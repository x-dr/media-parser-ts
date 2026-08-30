import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiKeyLease, ApiKeyService } from '../../auth/api-key-service.js';
import type { ParseService } from '../../core/parse-service.js';

export interface PublicRouteServices {
  apiKeys: ApiKeyService;
  parse: ParseService;
}

const parseBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
  },
} as const;

export async function registerPublicRoutes(
  app: FastifyInstance,
  services: PublicRouteServices,
): Promise<void> {
  const leases = new WeakMap<FastifyRequest, ApiKeyLease>();

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post<{ Body: { text: string } }>('/api/parse', {
    schema: { body: parseBodySchema },
    onRequest: async (request, reply) => {
      const lease = services.apiKeys.authorize(request.headers.authorization);
      leases.set(request, lease);
      reply.header('X-RateLimit-Limit', lease.identity.rateLimitPerMinute);
    },
    onResponse: async (request) => {
      leases.get(request)?.release();
    },
    onError: async (request) => {
      leases.get(request)?.release();
    },
  }, async (request, reply) => {
    const lease = leases.get(request);
    if (!lease) throw new Error('API Key lease missing');
    const disconnected = new AbortController();
    const abort = (): void => disconnected.abort(new Error('client disconnected'));
    request.raw.once('aborted', abort);
    try {
      const output = await services.parse.parse({
        requestId: request.id,
        identity: lease.identity,
        text: request.body.text,
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
  });
}
