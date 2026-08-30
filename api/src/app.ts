import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import type { AppConfig } from './config/env.js';
import { loadConfig } from './config/env.js';
import { DatabaseConnection } from './database/connection.js';
import { AdminRepository } from './database/repositories/admin-repository.js';
import { ApiClientRepository } from './database/repositories/api-client-repository.js';
import { PlatformRepository } from './database/repositories/platform-repository.js';
import { LogRepository } from './database/repositories/log-repository.js';
import { AdminAuthError, AdminAuthService } from './auth/admin-auth-service.js';
import { ApiKeyService } from './auth/api-key-service.js';
import { EncryptionService } from './security/encryption.js';
import { CredentialService } from './platform-admin/credential-service.js';
import { PlatformService } from './platform-admin/platform-service.js';
import { PlatformTestService } from './platform-admin/platform-test-service.js';
import { RequestLogService } from './logging/request-log-service.js';
import { AuditLogService } from './logging/audit-log-service.js';
import { RetentionService } from './logging/retention-service.js';
import { ParseService } from './core/parse-service.js';
import { AppError } from './core/errors.js';
import { assertRegistryComplete } from './core/parser-registry.js';
import { presentError } from './api/presenter.js';
import { registerPublicRoutes } from './api/public/routes.js';
import { registerAdminAuthRoutes } from './api/admin/auth-routes.js';
import { registerAdminClientRoutes } from './api/admin/client-routes.js';
import { registerAdminPlatformRoutes } from './api/admin/platform-routes.js';
import { registerAdminLogRoutes } from './api/admin/log-routes.js';
import { AdminApiError, type AdminRouteServices } from './api/admin/context.js';
import { registerPublicWebRoutes } from './public-web/routes.js';
import './platforms/index.js';

export interface CreateAppOptions {
  config?: AppConfig;
  servePublicWebAssets?: boolean;
}

export interface ManagedFastifyInstance extends FastifyInstance {
  abortActiveWork(): void;
}

export async function createApp(options: CreateAppOptions = {}): Promise<ManagedFastifyInstance> {
  const config = options.config ?? loadConfig();
  const shutdown = new AbortController();
  const connection = new DatabaseConnection(config.databasePath);
  const adminRepository = new AdminRepository(connection.database);
  const apiClientRepository = new ApiClientRepository(connection.database);
  const platformRepository = new PlatformRepository(connection.database);
  const logRepository = new LogRepository(connection.database);
  const auth = new AdminAuthService(adminRepository, config);
  await auth.initialize();

  const encryption = new EncryptionService(config.encryptionKey, config.previousEncryptionKey);
  const credentials = new CredentialService(platformRepository, encryption, config);
  const platforms = new PlatformService(platformRepository, credentials);
  const platformTests = new PlatformTestService(
    config,
    platformRepository,
    credentials,
    shutdown.signal,
  );
  const apiKeys = new ApiKeyService(apiClientRepository, config.globalParseConcurrency);
  const requestLogs = new RequestLogService(logRepository, config);
  const audit = new AuditLogService(logRepository, config);
  const retention = new RetentionService(logRepository);
  const parse = new ParseService(config, platforms, credentials, requestLogs, shutdown.signal);
  const adminServices: AdminRouteServices = {
    auth,
    apiKeys,
    audit,
    credentials,
    platforms,
    platformTests,
    requestLogs,
  };

  let trustProxy: false | string[] | ((address: string, hop: number) => boolean);
  if (typeof config.trustProxy === 'number') {
    const trustedHops = config.trustProxy;
    trustProxy = (_address, hop) => hop < trustedHops;
  } else if (config.trustProxy === false) {
    trustProxy = false;
  } else {
    trustProxy = [...config.trustProxy];
  }
  const app = Fastify({
    trustProxy,
    genReqId: () => ulid(),
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
          '*.password',
          '*.current_password',
          '*.new_password',
          '*.refresh_token',
          '*.api_key',
          '*.value',
        ],
        censor: '[REDACTED]',
      },
    },
    ajv: {
      customOptions: {
        coerceTypes: true,
        removeAdditional: false,
        useDefaults: true,
      },
    },
  }) as unknown as ManagedFastifyInstance;
  app.decorate('abortActiveWork', () => shutdown.abort(new Error('service shutting down')));

  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: (origin, callback) => {
        if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
        else callback(new Error('Origin not allowed'), false);
      },
      credentials: false,
    });
  }
  await app.register(rateLimit, { global: false });

  app.get('/api/ready', async (_request, reply) => {
    try {
      const database = checkReady();
      return { status: 'ok', database };
    } catch (error) {
      app.log.warn({ error_category: 'readiness_failed', error }, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  function checkReady(): ReturnType<DatabaseConnection['checkReady']> {
    const database = connection.checkReady();
    credentials.checkReady();
    assertRegistryComplete();
    return database;
  }

  function isReady(): boolean {
    try {
      checkReady();
      return true;
    } catch {
      return false;
    }
  }

  await registerPublicRoutes(app, { apiKeys, parse });
  await registerPublicWebRoutes(app, {
    config,
    apiKeys,
    parse,
    platforms,
    checkReady: isReady,
  });
  await registerAdminAuthRoutes(app, adminServices);
  await registerAdminClientRoutes(app, adminServices);
  await registerAdminPlatformRoutes(app, adminServices);
  await registerAdminLogRoutes(app, adminServices);

  app.setErrorHandler(async (error: FastifyError | Error, request, reply) => {
    const isAdmin = request.url.startsWith('/api/admin/');
    const isPublicWeb = request.url.startsWith('/web-api/');
    if (error instanceof AdminAuthError || error instanceof AdminApiError) {
      if (error.statusCode === 429) reply.header('Retry-After', 900);
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
        request_id: request.id,
      });
    }
    if (error instanceof AppError) {
      if (error.code === 'RATE_LIMITED') reply.header('Retry-After', 60);
      if (error.code === 'CONCURRENCY_LIMITED') reply.header('Retry-After', 1);
      return reply.code(error.statusCode).send(
        presentError(error.statusCode, error.message, error.code),
      );
    }
    if (!isAdmin && 'code' in error && (
      error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    )) {
      return reply.code(400).send(presentError(
        400,
        '请求体必须是 JSON 对象',
        'INVALID_REQUEST',
      ));
    }
    if ('validation' in error && error.validation) {
      if (isAdmin) {
        return reply.code(400).send({
          error: { code: 'ADMIN_INVALID_REQUEST', message: '请求参数无效' },
          request_id: request.id,
        });
      }
      const textTooLong = error.validation.some((item) => item.keyword === 'maxLength');
      const invalidObject = error.validation.some(
        (item) => item.keyword === 'type' && item.instancePath === '',
      );
      if (isPublicWeb) {
        const response = presentError(
          400,
          textTooLong ? '分享文本不能超过 2000 个字符' : '请输入分享文本或链接',
          textTooLong ? 'TEXT_TOO_LONG' : 'INVALID_TEXT',
        );
        return reply.code(400).send({ ...response, request_id: request.id });
      }
      return reply.code(400).send(presentError(
        400,
        textTooLong
          ? '分享文本不能超过 2000 个字符'
          : invalidObject ? '请求体必须是 JSON 对象' : '请提供包含分享链接的文本',
        textTooLong ? 'TEXT_TOO_LONG' : invalidObject ? 'INVALID_REQUEST' : 'INVALID_TEXT',
      ));
    }
    request.log.error({ error_category: 'request_handler_failed', error }, 'request failed');
    if (isAdmin) {
      return reply.code(500).send({
        error: { code: 'ADMIN_INTERNAL_ERROR', message: '服务内部错误' },
        request_id: request.id,
      });
    }
    return reply.code(500).send(presentError(500, '功能太火爆啦，请稍后再试', 'INTERNAL_ERROR'));
  });

  const adminRoot = fileURLToPath(new URL('../../admin/dist/', import.meta.url));
  // The path is fixed relative to this module; no request input is involved.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (existsSync(adminRoot)) {
    await app.register(fastifyStatic, {
      root: adminRoot,
      prefix: '/admin/',
      wildcard: false,
    });
    app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));
    app.get('/admin/*', async (_request, reply) => reply.sendFile('index.html'));
  }

  const publicRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  // The path is fixed relative to this module; no request input is involved.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (options.servePublicWebAssets !== false && existsSync(publicRoot)) {
    await app.register(fastifyStatic, {
      root: publicRoot,
      prefix: '/',
      wildcard: false,
      decorateReply: false,
      index: false,
    });
    app.get('/', async (_request, reply) => {
      reply.header('Content-Security-Policy', publicContentSecurityPolicy());
      return reply.sendFile('index.html', publicRoot);
    });
  }

  await retention.cleanup();
  retention.start();
  app.addHook('onClose', async () => {
    app.abortActiveWork();
    retention.stop();
    connection.close();
  });
  return app;
}

function publicContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob: http: https:",
    "media-src blob: http: https:",
    "style-src 'self' 'unsafe-inline'",
  ].join('; ');
}
