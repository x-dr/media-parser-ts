import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type {
  ParseLogDetailRow,
  ParseLogFilters,
  ParseLogListRow,
} from '../../database/repositories/log-repository.js';
import { AdminApiError, adminResponse, requireAdmin, type AdminRouteServices } from './context.js';

interface LogQuery {
  from?: string;
  to?: string;
  client_id?: string;
  key_id?: string;
  platform_id?: string;
  success?: string | boolean;
  http_status?: string | number;
  retcode?: string | number;
  error_code?: string;
  request_id?: string;
  cursor?: string;
  limit?: string | number;
}

const logQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    client_id: { type: 'string', maxLength: 64 },
    key_id: { type: 'string', maxLength: 64 },
    platform_id: { type: 'string', maxLength: 64 },
    success: { type: 'boolean' },
    http_status: { type: 'integer', minimum: 100, maximum: 599 },
    retcode: { type: 'integer', minimum: 0, maximum: 999 },
    error_code: { type: 'string', maxLength: 100 },
    request_id: { type: 'string', maxLength: 64 },
    cursor: { type: 'string', maxLength: 512 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  },
} as const;

export async function registerAdminLogRoutes(
  app: FastifyInstance,
  services: AdminRouteServices,
): Promise<void> {
  app.get<{ Querystring: LogQuery }>('/api/admin/v1/logs', {
    schema: { querystring: logQuerySchema },
  }, async (request) => {
    requireAdmin(request, services.auth);
    const filters = filtersFromQuery(request.query);
    const rows = services.requestLogs.list(filters);
    const nextCursor = rows.length === filters.limit ? encodeCursor(rows.at(-1) as ParseLogListRow) : null;
    return adminResponse({
      items: rows.map(listView),
      next_cursor: nextCursor,
    }, request.id);
  });

  app.get<{ Querystring: LogQuery }>('/api/admin/v1/logs/export', {
    schema: { querystring: logQuerySchema },
  }, async (request, reply) => {
    const identity = requireAdmin(request, services.auth);
    const filters = filtersFromQuery(request.query);
    validateExportRange(filters);
    services.audit.record({
      requestId: request.id,
      adminId: identity.adminId,
      action: 'parse_logs.export',
      entityType: 'parse_request_log',
      entityId: null,
      outcome: 'success',
      requestIp: request.ip,
      metadata: { from: filters.from, to: filters.to },
    });
    const rows = services.requestLogs.export(filters);
    const stream = Readable.from((function* (): Generator<string> {
      for (const row of rows) yield `${JSON.stringify(detailView(row))}\n`;
    })());
    return reply.type('application/x-ndjson').send(stream);
  });

  app.get<{ Params: { logId: string } }>('/api/admin/v1/logs/:logId', async (request) => {
    requireAdmin(request, services.auth);
    const row = services.requestLogs.get(request.params.logId);
    if (!row) throw new AdminApiError('LOG_NOT_FOUND', '调用日志不存在', 404);
    return adminResponse(detailView(row), request.id);
  });

  app.get<{ Querystring: LogQuery }>('/api/admin/v1/stats/overview', {
    schema: { querystring: logQuerySchema },
  }, async (request) => {
    requireAdmin(request, services.auth);
    return adminResponse(services.requestLogs.stats(filtersFromQuery(request.query), null), request.id);
  });

  app.get<{ Querystring: LogQuery }>('/api/admin/v1/stats/platforms', {
    schema: { querystring: logQuerySchema },
  }, async (request) => {
    requireAdmin(request, services.auth);
    return adminResponse(services.requestLogs.stats(filtersFromQuery(request.query), 'platform_id'), request.id);
  });

  app.get<{ Querystring: LogQuery }>('/api/admin/v1/stats/clients', {
    schema: { querystring: logQuerySchema },
  }, async (request) => {
    requireAdmin(request, services.auth);
    return adminResponse(services.requestLogs.stats(filtersFromQuery(request.query), 'client_id'), request.id);
  });
}

function filtersFromQuery(query: LogQuery): ParseLogFilters {
  let cursorCreatedAt: string | undefined;
  let cursorId: string | undefined;
  if (query.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as unknown;
      if (!Array.isArray(decoded) || decoded.length !== 2 ||
          typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string') throw new Error();
      cursorCreatedAt = decoded[0];
      cursorId = decoded[1];
    } catch {
      throw new AdminApiError('INVALID_CURSOR', '分页游标无效', 400);
    }
  }
  const optionalString = (value: string | undefined): { value?: string } =>
    value === undefined ? {} : { value };
  return {
    ...(optionalString(query.from).value === undefined ? {} : { from: query.from as string }),
    ...(optionalString(query.to).value === undefined ? {} : { to: query.to as string }),
    ...(query.client_id === undefined ? {} : { clientId: query.client_id }),
    ...(query.key_id === undefined ? {} : { apiKeyId: query.key_id }),
    ...(query.platform_id === undefined ? {} : { platformId: query.platform_id }),
    ...(query.success === undefined ? {} : { success: query.success === true || query.success === 'true' }),
    ...(query.http_status === undefined ? {} : { httpStatus: Number(query.http_status) }),
    ...(query.retcode === undefined ? {} : { retcode: Number(query.retcode) }),
    ...(query.error_code === undefined ? {} : { errorCode: query.error_code }),
    ...(query.request_id === undefined ? {} : { requestId: query.request_id }),
    ...(cursorCreatedAt === undefined ? {} : { cursorCreatedAt }),
    ...(cursorId === undefined ? {} : { cursorId }),
    limit: Number(query.limit ?? 50),
  };
}

function listView(row: ParseLogListRow): Record<string, unknown> {
  return {
    id: row.id,
    request_id: row.request_id,
    client_id: row.client_id,
    api_key_id: row.api_key_id,
    share_url: row.share_url,
    real_url: row.real_url,
    platform_id: row.platform_id,
    request_ip: row.request_ip,
    user_agent: row.user_agent,
    state: row.state,
    http_status: row.http_status,
    retcode: row.retcode,
    success: row.success === null ? null : row.success === 1,
    error_code: row.error_code,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

function detailView(typed: ParseLogDetailRow): Record<string, unknown> {
  return {
    ...listView(typed),
    input_text: typed.input_text,
    response: typed.response_json ? JSON.parse(typed.response_json) as unknown : null,
  };
}

function encodeCursor(row: ParseLogListRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id]), 'utf8').toString('base64url');
}

function validateExportRange(filters: ParseLogFilters): void {
  if (!filters.from || !filters.to) {
    throw new AdminApiError('EXPORT_RANGE_REQUIRED', '导出必须提供 UTC 起止时间', 400);
  }
  const start = Date.parse(filters.from);
  const end = Date.parse(filters.to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 30 * 86_400_000) {
    throw new AdminApiError('EXPORT_RANGE_INVALID', '导出时间范围不能超过 30 天', 400);
  }
}
