import type { FastifyInstance } from 'fastify';
import type { AdminRouteServices } from './context.js';
import { adminResponse, requireAdmin } from './context.js';

const tokenData = (pair: {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  tokenType: string;
  mustChangePassword: boolean;
}): Record<string, unknown> => ({
  access_token: pair.accessToken,
  access_expires_in: pair.accessExpiresIn,
  refresh_token: pair.refreshToken,
  refresh_expires_in: pair.refreshExpiresIn,
  token_type: pair.tokenType,
  must_change_password: pair.mustChangePassword,
});

export async function registerAdminAuthRoutes(
  app: FastifyInstance,
  services: AdminRouteServices,
): Promise<void> {
  app.post<{ Body: { username: string; password: string } }>('/api/admin/v1/auth/login', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 64 },
          password: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (request) => {
    try {
      const pair = await services.auth.login(request.body.username, request.body.password, request.ip);
      const admin = services.auth.authenticateAccess(pair.accessToken);
      services.audit.record({
        requestId: request.id,
        adminId: admin.adminId,
        action: 'admin.login',
        entityType: 'admin_session',
        entityId: admin.sessionId,
        outcome: 'success',
        requestIp: request.ip,
      });
      return adminResponse(tokenData(pair), request.id);
    } catch (error) {
      services.audit.record({
        requestId: request.id,
        adminId: null,
        action: 'admin.login',
        entityType: 'admin_session',
        entityId: null,
        outcome: 'failure',
        requestIp: request.ip,
      });
      throw error;
    }
  });

  app.post<{ Body: { refresh_token: string } }>('/api/admin/v1/auth/refresh', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['refresh_token'],
        properties: { refresh_token: { type: 'string', minLength: 1, maxLength: 256 } },
      },
    },
  }, async (request) => {
    const pair = services.auth.refresh(request.body.refresh_token);
    return adminResponse(tokenData(pair), request.id);
  });

  app.get('/api/admin/v1/auth/me', async (request) => {
    const identity = requireAdmin(request, services.auth, true);
    return adminResponse({
      id: identity.adminId,
      username: identity.username,
      must_change_password: identity.mustChangePassword,
    }, request.id);
  });

  app.post('/api/admin/v1/auth/logout', async (request) => {
    const identity = requireAdmin(request, services.auth, true);
    services.auth.logout(identity.sessionId);
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'admin.logout',
      entityType: 'admin_session',
      entityId: identity.sessionId,
      outcome: 'success',
      requestIp: request.ip,
    });
    return adminResponse({}, request.id);
  });

  app.put<{ Body: { current_password: string; new_password: string } }>('/api/admin/v1/auth/password', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['current_password', 'new_password'],
        properties: {
          current_password: { type: 'string', minLength: 1, maxLength: 128 },
          new_password: { type: 'string', minLength: 12, maxLength: 128 },
        },
      },
    },
  }, async (request) => {
    const identity = requireAdmin(request, services.auth, true);
    const pair = await services.auth.changePassword(
      identity,
      request.body.current_password,
      request.body.new_password,
    );
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'admin.password.change',
      entityType: 'admin',
      entityId: identity.adminId,
      outcome: 'success',
      requestIp: request.ip,
    });
    return adminResponse(tokenData(pair), request.id);
  });
}
