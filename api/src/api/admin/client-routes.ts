import type { FastifyInstance } from 'fastify';
import type { ApiClientRecord, ApiKeyRecord } from '../../database/repositories/api-client-repository.js';
import { AdminApiError, adminResponse, requireAdmin, type AdminRouteServices } from './context.js';

function clientView(record: ApiClientRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    note: record.note,
    enabled: record.enabled,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function keyView(record: ApiKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    client_id: record.clientId,
    name: record.name,
    masked_key: record.keyPrefix,
    enabled: record.enabled,
    rate_limit_per_minute: record.rateLimitPerMinute,
    max_concurrency: record.maxConcurrency,
    expires_at: record.expiresAt,
    last_used_at: record.lastUsedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    revoked_at: record.revokedAt,
    revoke_reason: record.revokeReason,
  };
}

const clientProperties = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  note: { type: 'string', maxLength: 1000 },
  enabled: { type: 'boolean' },
} as const;

const keyProperties = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  enabled: { type: 'boolean' },
  rate_limit_per_minute: { type: 'integer', minimum: 1, maximum: 10_000 },
  max_concurrency: { type: 'integer', minimum: 1, maximum: 100 },
  expires_at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
} as const;

export async function registerAdminClientRoutes(
  app: FastifyInstance,
  services: AdminRouteServices,
): Promise<void> {
  app.get('/api/admin/v1/clients', async (request) => {
    requireAdmin(request, services.auth);
    return adminResponse(services.apiKeys.listClients().map(clientView), request.id);
  });

  app.post<{ Body: { name: string; note?: string; enabled?: boolean } }>('/api/admin/v1/clients', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['name'], properties: clientProperties,
      },
    },
  }, async (request, reply) => {
    const identity = requireAdmin(request, services.auth);
    const record = services.apiKeys.createClient(request.body);
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'client.create',
      entityType: 'api_client',
      entityId: record.id,
      outcome: 'success',
      requestIp: request.ip,
    });
    return reply.code(201).send(adminResponse(clientView(record), request.id));
  });

  app.get<{ Params: { clientId: string } }>('/api/admin/v1/clients/:clientId', async (request) => {
    requireAdmin(request, services.auth);
    const record = services.apiKeys.getClient(request.params.clientId);
    if (!record) throw new AdminApiError('CLIENT_NOT_FOUND', '调用方不存在', 404);
    return adminResponse(clientView(record), request.id);
  });

  app.patch<{
    Params: { clientId: string };
    Body: { name?: string; note?: string; enabled?: boolean };
  }>('/api/admin/v1/clients/:clientId', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1, properties: clientProperties,
      },
    },
  }, async (request) => {
    const identity = requireAdmin(request, services.auth);
    const record = services.apiKeys.updateClient(request.params.clientId, request.body);
    if (!record) throw new AdminApiError('CLIENT_NOT_FOUND', '调用方不存在', 404);
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'client.update',
      entityType: 'api_client',
      entityId: record.id,
      outcome: 'success',
      requestIp: request.ip,
      metadata: { changed_fields: Object.keys(request.body) },
    });
    return adminResponse(clientView(record), request.id);
  });

  app.get<{ Params: { clientId: string } }>('/api/admin/v1/clients/:clientId/keys', async (request) => {
    requireAdmin(request, services.auth);
    if (!services.apiKeys.getClient(request.params.clientId)) {
      throw new AdminApiError('CLIENT_NOT_FOUND', '调用方不存在', 404);
    }
    return adminResponse(services.apiKeys.listKeys(request.params.clientId).map(keyView), request.id);
  });

  app.post<{
    Params: { clientId: string };
    Body: {
      name: string;
      rate_limit_per_minute?: number;
      max_concurrency?: number;
      expires_at?: string | null;
    };
  }>('/api/admin/v1/clients/:clientId/keys', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: keyProperties,
      },
    },
  }, async (request, reply) => {
    const identity = requireAdmin(request, services.auth);
    const created = services.apiKeys.createKey(request.params.clientId, {
      name: request.body.name,
      ...(request.body.rate_limit_per_minute === undefined ? {} : {
        rateLimitPerMinute: request.body.rate_limit_per_minute,
      }),
      ...(request.body.max_concurrency === undefined ? {} : {
        maxConcurrency: request.body.max_concurrency,
      }),
      ...(request.body.expires_at === undefined ? {} : { expiresAt: request.body.expires_at }),
    });
    if (!created) throw new AdminApiError('CLIENT_NOT_FOUND', '调用方不存在', 404);
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'api_key.create',
      entityType: 'api_key',
      entityId: created.record.id,
      outcome: 'success',
      requestIp: request.ip,
    });
    return reply.code(201).send(adminResponse({
      ...keyView(created.record),
      api_key: created.apiKey,
    }, request.id));
  });

  app.patch<{
    Params: { keyId: string };
    Body: {
      name?: string;
      enabled?: boolean;
      rate_limit_per_minute?: number;
      max_concurrency?: number;
      expires_at?: string | null;
    };
  }>('/api/admin/v1/keys/:keyId', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1, properties: keyProperties,
      },
    },
  }, async (request) => {
    const identity = requireAdmin(request, services.auth);
    const record = services.apiKeys.updateKey(request.params.keyId, {
      ...(request.body.name === undefined ? {} : { name: request.body.name }),
      ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
      ...(request.body.rate_limit_per_minute === undefined ? {} : {
        rateLimitPerMinute: request.body.rate_limit_per_minute,
      }),
      ...(request.body.max_concurrency === undefined ? {} : {
        maxConcurrency: request.body.max_concurrency,
      }),
      ...(request.body.expires_at === undefined ? {} : { expiresAt: request.body.expires_at }),
    });
    if (!record) throw new AdminApiError('KEY_NOT_FOUND', 'API Key 不存在或已吊销', 404);
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'api_key.update',
      entityType: 'api_key',
      entityId: record.id,
      outcome: 'success',
      requestIp: request.ip,
      metadata: { changed_fields: Object.keys(request.body) },
    });
    return adminResponse(keyView(record), request.id);
  });

  app.post<{
    Params: { keyId: string };
    Body: { reason?: string };
  }>('/api/admin/v1/keys/:keyId/revoke', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } },
      },
    },
  }, async (request) => {
    const identity = requireAdmin(request, services.auth);
    const record = services.apiKeys.revokeKey(request.params.keyId, request.body.reason?.trim() || 'admin_revoked');
    if (!record) throw new AdminApiError('KEY_NOT_FOUND', 'API Key 不存在或已吊销', 404);
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'api_key.revoke',
      entityType: 'api_key',
      entityId: record.id,
      outcome: 'success',
      requestIp: request.ip,
    });
    return adminResponse(keyView(record), request.id);
  });
}
