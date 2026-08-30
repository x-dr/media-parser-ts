import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../core/errors.js';
import type { ApiKeyLease, ApiKeyService } from '../auth/api-key-service.js';
import type { ParseService } from '../core/parse-service.js';
import type { PlatformService } from '../platform-admin/platform-service.js';
import { presentError } from '../api/presenter.js';
import { AnonymousConcurrencyGate, AnonymousRateLimiter } from './anonymous-guards.js';

export interface PublicWebServices {
  config: AppConfig;
  apiKeys: ApiKeyService;
  parse: ParseService;
  platforms: PlatformService;
  checkReady(): boolean;
}

interface ParseBody {
  text: string;
}

const parseBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
  },
} as const;

export async function registerPublicWebRoutes(
  app: FastifyInstance,
  services: PublicWebServices,
): Promise<void> {
  const rateLimiter = new AnonymousRateLimiter(services.config.publicWebRateLimitPerMinute);
  const concurrencyGate = new AnonymousConcurrencyGate(services.config.publicWebConcurrency);

  app.get('/web-api/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const configured = isConfigured(services.config)
      && services.apiKeys.isAuthorized(publicWebAuthorization(services.config));
    const ready = configured && services.checkReady();
    return {
      status: ready ? 'ok' : 'not_ready',
      ready,
      checked_at: new Date().toISOString(),
      request_id: request.id,
    };
  });

  const listPlatforms = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'public, max-age=30');
    const items = services.platforms.listPublic().map((platform) => ({
      id: platform.id,
      name: platform.name,
      enabled: platform.enabled,
      media_types: platform.mediaTypes,
      domains: platform.domains,
    }));
    return { data: { items }, request_id: request.id };
  };
  app.get('/api/platforms', listPlatforms);
  app.get('/web-api/platforms', listPlatforms);

  app.post<{ Body: ParseBody }>('/web-api/parse', {
    schema: { body: parseBodySchema },
    preHandler: async (request, reply) => {
      const outcome = rateLimiter.consume(request.ip);
      if (!outcome.allowed) {
        reply.header('Retry-After', outcome.retryAfter);
        return await reply.code(429).send(webError(
          429,
          '请求过于频繁，请稍后重试',
          'RATE_LIMITED',
          request.id,
        ));
      }
    },
  }, async (request, reply) => {
    const startedAt = Date.now();
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Request-Id', request.id);
    if (!isConfigured(services.config)) {
      return reply.code(503).send(webError(
        503,
        '公开解析服务暂未配置完成',
        'PUBLIC_WEB_UNAVAILABLE',
        request.id,
      ));
    }

    const disconnected = new AbortController();
    const abort = (): void => disconnected.abort(new Error('client disconnected'));
    request.raw.once('aborted', abort);
    let apiKeyLease: ApiKeyLease | null = null;
    let anonymousLease: ReturnType<AnonymousConcurrencyGate['acquire']> = null;
    try {
      anonymousLease = concurrencyGate.acquire();
      if (!anonymousLease) {
        reply.header('Retry-After', 1);
        return await reply.code(429).send(webError(
          429,
          '当前解析请求较多，请稍后重试',
          'CONCURRENCY_LIMITED',
          request.id,
        ));
      }
      try {
        apiKeyLease = services.apiKeys.authorize(publicWebAuthorization(services.config));
      } catch (error) {
        if (error instanceof AppError && ['RATE_LIMITED', 'CONCURRENCY_LIMITED'].includes(error.code)) {
          reply.header('Retry-After', error.code === 'RATE_LIMITED' ? 60 : 1);
          return await reply.code(429).send(webError(429, error.message, error.code, request.id));
        }
        request.log.error(
          { error_category: 'public_web_authorization_failed' },
          'public web API key authorization failed',
        );
        return await reply.code(503).send(webError(
          503,
          '公开解析服务暂不可用',
          'PUBLIC_WEB_UNAVAILABLE',
          request.id,
        ));
      }
      try {
        const output = await services.parse.parse({
          requestId: request.id,
          identity: apiKeyLease.identity,
          text: request.body.text.trim(),
          requestIp: request.ip,
          userAgent: request.headers['user-agent'] ?? '',
          signal: disconnected.signal,
          logger: request.log,
        });
        return await reply.code(output.statusCode).send({
          ...output.body,
          request_id: request.id,
          duration_ms: Date.now() - startedAt,
        });
      } catch (error) {
        if (error instanceof AppError) {
          return await reply.code(error.statusCode).send(webError(
            error.statusCode,
            error.message,
            error.code,
            request.id,
          ));
        }
        throw error;
      }
    } finally {
      request.raw.off('aborted', abort);
      apiKeyLease?.release();
      anonymousLease?.release();
    }
  });
}

function isConfigured(config: AppConfig): boolean {
  return Boolean(config.publicWebApiKey);
}

function publicWebAuthorization(config: AppConfig): string {
  return `Bearer ${config.publicWebApiKey ?? ''}`;
}

function webError(
  statusCode: number,
  message: string,
  errorCode: string,
  requestId: string,
): ReturnType<typeof presentError> & { request_id: string } {
  return { ...presentError(statusCode, message, errorCode), request_id: requestId };
}
