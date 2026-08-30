import type { FastifyInstance } from 'fastify';
import { platformDefinitions, type PlatformId } from '../../config/platforms.js';
import { AdminApiError, adminResponse, requireAdmin, type AdminRouteServices } from './context.js';
import { PlatformTestError } from '../../platform-admin/platform-test-service.js';

function platformId(value: string): PlatformId {
  if (!Object.hasOwn(platformDefinitions, value)) {
    throw new AdminApiError('PLATFORM_NOT_FOUND', '平台不存在', 404);
  }
  return value as PlatformId;
}

export async function registerAdminPlatformRoutes(
  app: FastifyInstance,
  services: AdminRouteServices,
): Promise<void> {
  app.get('/api/admin/v1/platforms', async (request) => {
    requireAdmin(request, services.auth);
    return adminResponse(services.platforms.list().map((platform) => ({
      id: platform.id,
      name: platform.name,
      enabled: platform.enabled,
      media_types: platform.mediaTypes,
      credentials: platform.credentials.map((credential) => ({
        name: credential.name,
        required: credential.required,
        configured: credential.configured,
        source: credential.source,
        masked: credential.masked,
        updated_at: credential.updatedAt,
      })),
      updated_at: platform.updatedAt,
      last_test: platform.lastTest ? {
        success: platform.lastTest.success,
        media_types: platform.lastTest.mediaTypes,
        missing_fields: platform.lastTest.missingFields,
        duration_ms: platform.lastTest.durationMs,
        error_category: platform.lastTest.errorCategory,
        created_at: platform.lastTest.createdAt,
      } : null,
    })), request.id);
  });

  app.patch<{
    Params: { platformId: string };
    Body: { enabled: boolean };
  }>('/api/admin/v1/platforms/:platformId', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } },
      },
    },
  }, async (request) => {
    const identity = requireAdmin(request, services.auth);
    const id = platformId(request.params.platformId);
    const platform = services.platforms.setEnabled(id, request.body.enabled);
    if (!platform) throw new AdminApiError('PLATFORM_NOT_FOUND', '平台不存在', 404);
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'platform.update',
      entityType: 'platform',
      entityId: id,
      outcome: 'success',
      requestIp: request.ip,
      metadata: { enabled: request.body.enabled },
    });
    return adminResponse({ id, enabled: platform.enabled, updated_at: platform.updatedAt }, request.id);
  });

  app.put<{
    Params: { platformId: string; credentialName: string };
    Body: { value: string };
  }>('/api/admin/v1/platforms/:platformId/credentials/:credentialName', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string', minLength: 1, maxLength: 16_384 } },
      },
    },
  }, async (request) => {
    const identity = requireAdmin(request, services.auth);
    const id = platformId(request.params.platformId);
    let status;
    try {
      status = services.credentials.setCredential(id, request.params.credentialName, request.body.value);
    } catch (error) {
      throw new AdminApiError('CREDENTIAL_INVALID', (error as Error).message, 400);
    }
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'platform.credential.set',
      entityType: 'platform_credential',
      entityId: `${id}:${request.params.credentialName}`,
      outcome: 'success',
      requestIp: request.ip,
      metadata: { field: request.params.credentialName },
    });
    return adminResponse({
      name: status.name,
      configured: status.configured,
      source: status.source,
      masked: status.masked,
      updated_at: status.updatedAt,
    }, request.id);
  });

  app.delete<{
    Params: { platformId: string; credentialName: string };
  }>('/api/admin/v1/platforms/:platformId/credentials/:credentialName', async (request) => {
    const identity = requireAdmin(request, services.auth);
    const id = platformId(request.params.platformId);
    try {
      services.credentials.deleteCredential(id, request.params.credentialName);
    } catch (error) {
      throw new AdminApiError('CREDENTIAL_INVALID', (error as Error).message, 400);
    }
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'platform.credential.delete',
      entityType: 'platform_credential',
      entityId: `${id}:${request.params.credentialName}`,
      outcome: 'success',
      requestIp: request.ip,
      metadata: { field: request.params.credentialName },
    });
    const status = services.credentials.listStatus(id)
      .find((credential) => credential.name === request.params.credentialName);
    return adminResponse(status ? {
      name: status.name,
      configured: status.configured,
      source: status.source,
      masked: status.masked,
      updated_at: status.updatedAt,
    } : {}, request.id);
  });

  app.post<{
    Params: { platformId: string };
    Body: { text?: string };
  }>('/api/admin/v1/platforms/:platformId/test', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
  }, async (request) => {
    const identity = requireAdmin(request, services.auth);
    const id = platformId(request.params.platformId);
    const disconnected = new AbortController();
    const abort = (): void => disconnected.abort(new Error('client disconnected'));
    request.raw.once('aborted', abort);
    try {
      const output = await services.platformTests.run({
        platformId: id,
        adminId: identity.adminId,
        ...(request.body.text === undefined ? {} : { text: request.body.text }),
        requestId: request.id,
        signal: disconnected.signal,
        logger: request.log,
      });
      services.audit.record({
        requestId: request.id,
        adminId: identity.adminId,
        action: 'platform.test',
        entityType: 'platform',
        entityId: id,
        outcome: output.success ? 'success' : 'failure',
        requestIp: request.ip,
        metadata: { error_category: output.errorCategory },
      });
      return adminResponse({
        platform_id: output.platformId,
        success: output.success,
        media_types: output.mediaTypes,
        missing_fields: output.missingFields,
        duration_ms: output.durationMs,
        error_category: output.errorCategory,
        created_at: output.createdAt,
      }, request.id);
    } catch (error) {
      if (error instanceof PlatformTestError) {
        throw new AdminApiError(error.code, error.message, error.statusCode);
      }
      throw error;
    } finally {
      request.raw.off('aborted', abort);
    }
  });
}
