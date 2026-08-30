import type Database from 'better-sqlite3';

export interface AdminRecord {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  passwordParamsJson: string;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSessionRecord {
  id: string;
  adminId: string;
  familyId: string;
  accessTokenHash: string;
  accessExpiresAt: string;
  refreshTokenHash: string;
  refreshExpiresAt: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  password_params_json: string;
  must_change_password: number;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  admin_id: string;
  family_id: string;
  access_token_hash: string;
  access_expires_at: string;
  refresh_token_hash: string;
  refresh_expires_at: string;
  created_at: string;
  last_used_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

function mapAdmin(row: AdminRow): AdminRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    passwordParamsJson: row.password_params_json,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): AdminSessionRecord {
  return {
    id: row.id,
    adminId: row.admin_id,
    familyId: row.family_id,
    accessTokenHash: row.access_token_hash,
    accessExpiresAt: row.access_expires_at,
    refreshTokenHash: row.refresh_token_hash,
    refreshExpiresAt: row.refresh_expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
}

export class AdminRepository {
  public constructor(private readonly database: Database.Database) {}

  public findAdmin(): AdminRecord | null {
    const row = this.database.prepare('SELECT * FROM admins LIMIT 1').get() as AdminRow | undefined;
    return row ? mapAdmin(row) : null;
  }

  public createAdmin(record: AdminRecord): void {
    this.database.prepare(`
      INSERT INTO admins(
        id, username, password_hash, password_salt, password_params_json,
        must_change_password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.username,
      record.passwordHash,
      record.passwordSalt,
      record.passwordParamsJson,
      record.mustChangePassword ? 1 : 0,
      record.createdAt,
      record.updatedAt,
    );
  }

  public updatePassword(
    adminId: string,
    passwordHash: string,
    passwordSalt: string,
    passwordParamsJson: string,
    updatedAt: string,
  ): void {
    this.database.prepare(`
      UPDATE admins
      SET password_hash = ?, password_salt = ?, password_params_json = ?,
          must_change_password = 0, updated_at = ?
      WHERE id = ?
    `).run(passwordHash, passwordSalt, passwordParamsJson, updatedAt, adminId);
  }

  public createSession(record: AdminSessionRecord): void {
    this.database.prepare(`
      INSERT INTO admin_sessions(
        id, admin_id, family_id, access_token_hash, access_expires_at,
        refresh_token_hash, refresh_expires_at, created_at, last_used_at,
        revoked_at, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.adminId,
      record.familyId,
      record.accessTokenHash,
      record.accessExpiresAt,
      record.refreshTokenHash,
      record.refreshExpiresAt,
      record.createdAt,
      record.lastUsedAt,
      record.revokedAt,
      record.revokeReason,
    );
  }

  public findSessionByAccessHash(hash: string): AdminSessionRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM admin_sessions WHERE access_token_hash = ?',
    ).get(hash) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  public findSessionByRefreshHash(hash: string): AdminSessionRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM admin_sessions WHERE refresh_token_hash = ?',
    ).get(hash) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  public rotateSession(previousId: string, next: AdminSessionRecord, now: string): boolean {
    const rotate = this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE admin_sessions
        SET revoked_at = ?, revoke_reason = 'rotated', last_used_at = ?
        WHERE id = ? AND revoked_at IS NULL
      `).run(now, now, previousId);
      if (result.changes !== 1) return false;
      this.createSession(next);
      return true;
    });
    return rotate();
  }

  public revokeSession(sessionId: string, reason: string, now: string): void {
    this.database.prepare(`
      UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?)
      WHERE id = ?
    `).run(now, reason, sessionId);
  }

  public revokeFamily(familyId: string, reason: string, now: string): void {
    this.database.prepare(`
      UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = ?
      WHERE family_id = ?
    `).run(now, reason, familyId);
  }

  public revokeAllSessions(adminId: string, reason: string, now: string): void {
    this.database.prepare(`
      UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = ?
      WHERE admin_id = ?
    `).run(now, reason, adminId);
  }

  public countRecentFailedLogins(username: string, requestIp: string, since: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM admin_login_attempts
      WHERE username_normalized = ? AND request_ip = ? AND successful = 0 AND created_at >= ?
    `).get(username, requestIp, since) as { count: number };
    return row.count;
  }

  public recordLoginAttempt(username: string, requestIp: string, successful: boolean, now: string): void {
    this.database.prepare(`
      INSERT INTO admin_login_attempts(username_normalized, request_ip, successful, created_at)
      VALUES (?, ?, ?, ?)
    `).run(username, requestIp, successful ? 1 : 0, now);
    this.database.prepare('DELETE FROM admin_login_attempts WHERE created_at < ?').run(
      new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString(),
    );
  }
}
