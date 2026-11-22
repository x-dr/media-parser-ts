import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeyLease, ApiKeyService } from '../../auth/api-key-service.js';
import { AppError } from '../../core/errors.js';
import type { ParseService } from '../../core/parse-service.js';

export interface PublicRouteServices {
  apiKeys: ApiKeyService;
  parse: ParseService;
}

const MAX_TEXT_LENGTH = 2000;

const parseBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH, pattern: '\\S' },
  },
} as const;

export async function registerPublicRoutes(
  app: FastifyInstance,
  services: PublicRouteServices,
): Promise<void> {
  const leases = new WeakMap<FastifyRequest, ApiKeyLease>();

  const authorizeBearer = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const lease = services.apiKeys.authorize(request.headers.authorization);
    leases.set(request, lease);
    reply.header('X-RateLimit-Limit', lease.identity.rateLimitPerMinute);
  };

  const releaseLease = async (request: FastifyRequest): Promise<void> => {
    leases.get(request)?.release();
  };

  const executeParse = async (request: FastifyRequest, reply: FastifyReply, text: string) => {
    const lease = leases.get(request);
    if (!lease) throw new Error('API Key lease missing');
    const disconnected = new AbortController();
    const abort = (): void => disconnected.abort(new Error('client disconnected'));
    request.raw.once('aborted', abort);
    try {
      const output = await services.parse.parse({
        requestId: request.id,
        identity: lease.identity,
        text,
        requestIp: request.ip,
        userAgent: request.headers['user-agent'] ?? '',
        signal: disconnected.signal,
        logger: request.log,
      });
      return await reply.code(output.statusCode).send(output.body);
    } finally {
      request.raw.off('aborted', abort);
      lease.release();
    }
  };

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post<{ Body: { text: string } }>('/api/parse', {
    schema: { body: parseBodySchema },
    onRequest: authorizeBearer,
    onResponse: releaseLease,
    onError: releaseLease,
  }, async (request, reply) => executeParse(request, reply, request.body.text));

  app.get('/api/v1/parse', {
    onRequest: authorizeBearer,
    onResponse: releaseLease,
    onError: releaseLease,
  }, async (request, reply) => {
    const text = extractV1Text(request.query, null);
    return executeParse(request, reply, text);
  });

  app.post('/api/v1/parse', {
    onRequest: authorizeBearer,
    onResponse: releaseLease,
    onError: releaseLease,
  }, async (request, reply) => {
    const body = request.body;
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw new AppError('INVALID_REQUEST', 400, '请求体必须是 JSON 或表单对象');
    }
    const text = extractV1Text(request.query, body);
    return executeParse(request, reply, text);
  });
}

function extractV1Text(query: unknown, body: unknown): string {
  const fromBody = pickUrlOrText(body);
  const fromQuery = pickUrlOrText(query);
  const raw = fromBody !== null ? fromBody : fromQuery;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AppError('INVALID_TEXT', 400, '请提供包含分享链接的文本');
  }
  if (raw.length > MAX_TEXT_LENGTH) {
    throw new AppError('TEXT_TOO_LONG', 400, `分享文本不能超过 ${MAX_TEXT_LENGTH} 个字符`);
  }
  return raw;
}

function pickUrlOrText(source: unknown): unknown {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null;
  const obj = source as Record<string, unknown>;
  if (typeof obj.url === 'string' && obj.url.trim()) return obj.url;
  if (typeof obj.text === 'string' && obj.text.trim()) return obj.text;
  if (obj.url !== undefined) return obj.url;
  if (obj.text !== undefined) return obj.text;
  return null;
}
