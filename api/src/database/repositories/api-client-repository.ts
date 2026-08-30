import type Database from 'better-sqlite3';

export interface ApiClientRecord {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  clientId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  enabled: boolean;
  rateLimitPerMinute: number;
  maxConcurrency: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface ApiKeyWithClient extends ApiKeyRecord {
  clientEnabled: boolean;
}

interface ClientRow {
  id: string;
  name: string;
  note: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface KeyRow {
  id: string;
  client_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  enabled: number;
  rate_limit_per_minute: number;
  max_concurrency: number;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

interface KeyWithClientRow extends KeyRow {
  client_enabled: number;
}

function mapClient(row: ClientRow): ApiClientRecord {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKey(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    enabled: row.enabled === 1,
    rateLimitPerMinute: row.rate_limit_per_minute,
    maxConcurrency: row.max_concurrency,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

export class ApiClientRepository {
  public constructor(private readonly database: Database.Database) {}

  public listClients(): ApiClientRecord[] {
    return (this.database.prepare('SELECT * FROM api_clients ORDER BY created_at DESC').all() as ClientRow[])
      .map(mapClient);
  }

  public getClient(id: string): ApiClientRecord | null {
    const row = this.database.prepare('SELECT * FROM api_clients WHERE id = ?').get(id) as
      | ClientRow
      | undefined;
    return row ? mapClient(row) : null;
  }

  public createClient(record: ApiClientRecord): void {
    this.database.prepare(`
      INSERT INTO api_clients(id, name, note, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.name,
      record.note,
      record.enabled ? 1 : 0,
      record.createdAt,
      record.updatedAt,
    );
  }

  public updateClient(id: string, changes: { name?: string; note?: string; enabled?: boolean }, now: string): boolean {
    const current = this.getClient(id);
    if (!current) return false;
    const result = this.database.prepare(`
      UPDATE api_clients SET name = ?, note = ?, enabled = ?, updated_at = ? WHERE id = ?
    `).run(
      changes.name ?? current.name,
      changes.note ?? current.note,
      (changes.enabled ?? current.enabled) ? 1 : 0,
      now,
      id,
    );
    return result.changes === 1;
  }

  public listKeys(clientId: string): ApiKeyRecord[] {
    return (this.database.prepare(
      'SELECT * FROM api_keys WHERE client_id = ? ORDER BY created_at DESC',
    ).all(clientId) as KeyRow[]).map(mapKey);
  }

  public getKey(id: string): ApiKeyRecord | null {
    const row = this.database.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as KeyRow | undefined;
    return row ? mapKey(row) : null;
  }

  public getKeyWithClient(id: string): ApiKeyWithClient | null {
    const row = this.database.prepare(`
      SELECT k.*, c.enabled AS client_enabled
      FROM api_keys k JOIN api_clients c ON c.id = k.client_id
      WHERE k.id = ?
    `).get(id) as KeyWithClientRow | undefined;
    return row ? { ...mapKey(row), clientEnabled: row.client_enabled === 1 } : null;
  }

  public createKey(record: ApiKeyRecord): void {
    this.database.prepare(`
      INSERT INTO api_keys(
        id, client_id, name, key_prefix, key_hash, enabled,
        rate_limit_per_minute, max_concurrency, expires_at, last_used_at,
        created_at, updated_at, revoked_at, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.clientId,
      record.name,
      record.keyPrefix,
      record.keyHash,
      record.enabled ? 1 : 0,
      record.rateLimitPerMinute,
      record.maxConcurrency,
      record.expiresAt,
      record.lastUsedAt,
      record.createdAt,
      record.updatedAt,
      record.revokedAt,
      record.revokeReason,
    );
  }

  public updateKey(
    id: string,
    changes: {
      name?: string;
      enabled?: boolean;
      rateLimitPerMinute?: number;
      maxConcurrency?: number;
      expiresAt?: string | null;
    },
    now: string,
  ): boolean {
    const current = this.getKey(id);
    if (!current || current.revokedAt) return false;
    const result = this.database.prepare(`
      UPDATE api_keys SET name = ?, enabled = ?, rate_limit_per_minute = ?,
        max_concurrency = ?, expires_at = ?, updated_at = ? WHERE id = ?
    `).run(
      changes.name ?? current.name,
      (changes.enabled ?? current.enabled) ? 1 : 0,
      changes.rateLimitPerMinute ?? current.rateLimitPerMinute,
      changes.maxConcurrency ?? current.maxConcurrency,
      changes.expiresAt === undefined ? current.expiresAt : changes.expiresAt,
      now,
      id,
    );
    return result.changes === 1;
  }

  public revokeKey(id: string, reason: string, now: string): boolean {
    const result = this.database.prepare(`
      UPDATE api_keys SET revoked_at = ?, revoke_reason = ?, enabled = 0, updated_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).run(now, reason, now, id);
    return result.changes === 1;
  }

  public markKeyUsed(id: string, now: string): void {
    this.database.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, id);
  }
}
