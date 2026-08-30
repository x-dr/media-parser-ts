import type Database from 'better-sqlite3';

export interface PendingParseLog {
  id: string;
  requestId: string;
  clientId: string;
  apiKeyId: string;
  inputText: string;
  shareUrl: string;
  requestIp: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
}

export interface CompletedParseLog {
  realUrl: string | null;
  platformId: string | null;
  state: 'completed' | 'client_aborted';
  httpStatus: number;
  retcode: number;
  success: boolean;
  errorCode: string | null;
  responseJson: string;
  durationMs: number;
}

export interface ParseLogFilters {
  from?: string;
  to?: string;
  clientId?: string;
  apiKeyId?: string;
  platformId?: string;
  success?: boolean;
  httpStatus?: number;
  retcode?: number;
  errorCode?: string;
  requestId?: string;
  cursorCreatedAt?: string;
  cursorId?: string;
  limit: number;
}

export interface ParseLogListRow {
  id: string;
  request_id: string;
  client_id: string;
  api_key_id: string;
  share_url: string;
  real_url: string | null;
  platform_id: string | null;
  request_ip: string;
  user_agent: string;
  state: string;
  http_status: number | null;
  retcode: number | null;
  success: number | null;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
  expires_at: string;
}

export interface ParseLogDetailRow extends ParseLogListRow {
  input_text: string;
  response_json: string | null;
}

export interface AuditLogRecord {
  id: string;
  requestId: string;
  adminId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: string;
  requestIp: string;
  metadataJson: string;
  createdAt: string;
  expiresAt: string;
}

export class LogRepository {
  public constructor(private readonly database: Database.Database) {}

  public createPending(record: PendingParseLog): void {
    this.database.prepare(`
      INSERT INTO parse_request_logs(
        id, request_id, client_id, api_key_id, input_text, share_url,
        request_ip, user_agent, state, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      record.id,
      record.requestId,
      record.clientId,
      record.apiKeyId,
      record.inputText,
      record.shareUrl,
      record.requestIp,
      record.userAgent,
      record.createdAt,
      record.expiresAt,
    );
  }

  public complete(requestId: string, record: CompletedParseLog): boolean {
    const result = this.database.prepare(`
      UPDATE parse_request_logs SET
        real_url = ?, platform_id = ?, state = ?, http_status = ?, retcode = ?,
        success = ?, error_code = ?, response_json = ?, duration_ms = ?
      WHERE request_id = ? AND state = 'pending'
    `).run(
      record.realUrl,
      record.platformId,
      record.state,
      record.httpStatus,
      record.retcode,
      record.success ? 1 : 0,
      record.errorCode,
      record.responseJson,
      record.durationMs,
      requestId,
    );
    return result.changes === 1;
  }

  public list(filters: ParseLogFilters): ParseLogListRow[] {
    const { where, values } = buildWhere(filters);
    return this.database.prepare(`
      SELECT id, request_id, client_id, api_key_id, share_url, real_url, platform_id,
        request_ip, user_agent, state, http_status, retcode, success, error_code,
        duration_ms, created_at, expires_at
      FROM parse_request_logs ${where}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...values, filters.limit) as ParseLogListRow[];
  }

  public get(id: string): ParseLogDetailRow | null {
    return (this.database.prepare(
      'SELECT * FROM parse_request_logs WHERE id = ?',
    ).get(id) as ParseLogDetailRow | undefined) ?? null;
  }

  public export(filters: ParseLogFilters): IterableIterator<ParseLogDetailRow> {
    const { where, values } = buildWhere(filters);
    return this.database.prepare(`
      SELECT * FROM parse_request_logs ${where} ORDER BY created_at ASC, id ASC
    `).iterate(...values) as IterableIterator<ParseLogDetailRow>;
  }

  public getDurations(filters: ParseLogFilters): number[] {
    const { where, values } = buildWhere(filters, ['duration_ms IS NOT NULL']);
    return (this.database.prepare(`
      SELECT duration_ms FROM parse_request_logs ${where} ORDER BY duration_ms ASC
    `).all(...values) as { duration_ms: number }[]).map((row) => row.duration_ms);
  }

  public aggregate(filters: ParseLogFilters, groupBy: 'platform_id' | 'client_id' | null): unknown[] {
    const { where, values } = buildWhere(filters);
    const group = groupBy ? `, ${groupBy} AS group_id` : '';
    const groupClause = groupBy ? `GROUP BY ${groupBy}` : '';
    return this.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful,
        AVG(duration_ms) AS average_duration_ms${group}
      FROM parse_request_logs ${where} ${groupClause}
      ORDER BY total DESC
    `).all(...values);
  }

  public aggregateErrors(filters: ParseLogFilters): unknown[] {
    const { where, values } = buildWhere(filters, ['success = 0', 'error_code IS NOT NULL']);
    return this.database.prepare(`
      SELECT error_code, COUNT(*) AS total
      FROM parse_request_logs ${where}
      GROUP BY error_code ORDER BY total DESC, error_code ASC
    `).all(...values);
  }

  public insertAudit(record: AuditLogRecord): void {
    this.database.prepare(`
      INSERT INTO admin_audit_logs(
        id, request_id, admin_id, action, entity_type, entity_id, outcome,
        request_ip, metadata_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.requestId,
      record.adminId,
      record.action,
      record.entityType,
      record.entityId,
      record.outcome,
      record.requestIp,
      record.metadataJson,
      record.createdAt,
      record.expiresAt,
    );
  }

  public deleteExpired(table: 'parse_request_logs' | 'platform_test_runs' | 'admin_audit_logs', now: string): number {
    return this.database.prepare(`
      DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at <= ? LIMIT 1000)
    `).run(now).changes;
  }
}

function buildWhere(
  filters: ParseLogFilters,
  initialClauses: string[] = [],
): { where: string; values: (string | number)[] } {
  const clauses = [...initialClauses];
  const values: (string | number)[] = [];
  const add = (condition: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    clauses.push(condition);
    values.push(value);
  };
  add('created_at >= ?', filters.from);
  add('created_at <= ?', filters.to);
  add('client_id = ?', filters.clientId);
  add('api_key_id = ?', filters.apiKeyId);
  add('platform_id = ?', filters.platformId);
  add('success = ?', filters.success === undefined ? undefined : filters.success ? 1 : 0);
  add('http_status = ?', filters.httpStatus);
  add('retcode = ?', filters.retcode);
  add('error_code = ?', filters.errorCode);
  add('request_id = ?', filters.requestId);
  if (filters.cursorCreatedAt && filters.cursorId) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
    values.push(filters.cursorCreatedAt, filters.cursorCreatedAt, filters.cursorId);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', values };
}
