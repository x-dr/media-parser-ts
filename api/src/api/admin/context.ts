import type { FastifyRequest } from 'fastify';
import type { AdminAuthService, AdminIdentity } from '../../auth/admin-auth-service.js';
import type { ApiKeyService } from '../../auth/api-key-service.js';
import type { AuditLogService } from '../../logging/audit-log-service.js';
import type { RequestLogService } from '../../logging/request-log-service.js';
import type { CredentialService } from '../../platform-admin/credential-service.js';
import type { PlatformService } from '../../platform-admin/platform-service.js';
import type { PlatformTestService } from '../../platform-admin/platform-test-service.js';

export class AdminApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export interface AdminRouteServices {
  auth: AdminAuthService;
  apiKeys: ApiKeyService;
  audit: AuditLogService;
  credentials: CredentialService;
  platforms: PlatformService;
  platformTests: PlatformTestService;
  requestLogs: RequestLogService;
}

export function requireAdmin(
  request: FastifyRequest,
  auth: AdminAuthService,
  allowMustChange = false,
): AdminIdentity {
  const header = request.headers.authorization;
  const match = header ? /^Bearer ([^\s]+)$/u.exec(header) : null;
  const identity = auth.authenticateAccess(match?.[1] ?? '');
  if (identity.mustChangePassword && !allowMustChange) {
    throw new AdminApiError('PASSWORD_CHANGE_REQUIRED', '首次登录后必须先修改密码', 403);
  }
  return identity;
}

export function adminResponse(data: unknown, requestId: string): { data: unknown; request_id: string } {
  return { data, request_id: requestId };
}
