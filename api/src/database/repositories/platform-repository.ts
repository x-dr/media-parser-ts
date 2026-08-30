import type Database from 'better-sqlite3';
import type { PlatformId } from '../../config/platforms.js';
import type { EncryptedValue } from '../../security/encryption.js';

export interface PlatformSettingRecord {
  platformId: PlatformId;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformSecretRecord extends EncryptedValue {
  platformId: PlatformId;
  credentialName: string;
  maskedHint: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformTestRunRecord {
  id: string;
  platformId: PlatformId;
  adminId: string;
  success: boolean;
  mediaTypes: string[];
  missingFields: string[];
  durationMs: number;
  errorCategory: string | null;
  createdAt: string;
  expiresAt: string;
}

interface SettingRow {
  platform_id: PlatformId;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface SecretRow {
  platform_id: PlatformId;
  credential_name: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  masked_hint: string;
  created_at: string;
  updated_at: string;
}

interface TestRunRow {
  id: string;
  platform_id: PlatformId;
  admin_id: string;
  success: number;
  media_types_json: string;
  missing_fields_json: string;
  duration_ms: number;
  error_category: string | null;
  created_at: string;
  expires_at: string;
}

function mapSetting(row: SettingRow): PlatformSettingRecord {
  return {
    platformId: row.platform_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSecret(row: SecretRow): PlatformSecretRecord {
  return {
    platformId: row.platform_id,
    credentialName: row.credential_name,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    keyVersion: row.key_version,
    maskedHint: row.masked_hint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTestRun(row: TestRunRow): PlatformTestRunRecord {
  return {
    id: row.id,
    platformId: row.platform_id,
    adminId: row.admin_id,
    success: row.success === 1,
    mediaTypes: JSON.parse(row.media_types_json) as string[],
    missingFields: JSON.parse(row.missing_fields_json) as string[],
    durationMs: row.duration_ms,
    errorCategory: row.error_category,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class PlatformRepository {
  public constructor(private readonly database: Database.Database) {}

  public listSettings(): PlatformSettingRecord[] {
    return (this.database.prepare('SELECT * FROM platform_settings ORDER BY platform_id').all() as SettingRow[])
      .map(mapSetting);
  }

  public getSetting(platformId: PlatformId): PlatformSettingRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM platform_settings WHERE platform_id = ?',
    ).get(platformId) as SettingRow | undefined;
    return row ? mapSetting(row) : null;
  }

  public setEnabled(platformId: PlatformId, enabled: boolean, now: string): boolean {
    const result = this.database.prepare(`
      UPDATE platform_settings SET enabled = ?, updated_at = ? WHERE platform_id = ?
    `).run(enabled ? 1 : 0, now, platformId);
    return result.changes === 1;
  }

  public listSecrets(): PlatformSecretRecord[] {
    return (this.database.prepare('SELECT * FROM platform_secrets').all() as SecretRow[]).map(mapSecret);
  }

  public getSecret(platformId: PlatformId, credentialName: string): PlatformSecretRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM platform_secrets WHERE platform_id = ? AND credential_name = ?
    `).get(platformId, credentialName) as SecretRow | undefined;
    return row ? mapSecret(row) : null;
  }

  public upsertSecret(record: PlatformSecretRecord): void {
    this.database.prepare(`
      INSERT INTO platform_secrets(
        platform_id, credential_name, ciphertext, iv, auth_tag, key_version,
        masked_hint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform_id, credential_name) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        key_version = excluded.key_version,
        masked_hint = excluded.masked_hint,
        updated_at = excluded.updated_at
    `).run(
      record.platformId,
      record.credentialName,
      record.ciphertext,
      record.iv,
      record.authTag,
      record.keyVersion,
      record.maskedHint,
      record.createdAt,
      record.updatedAt,
    );
  }

  public deleteSecret(platformId: PlatformId, credentialName: string): boolean {
    return this.database.prepare(`
      DELETE FROM platform_secrets WHERE platform_id = ? AND credential_name = ?
    `).run(platformId, credentialName).changes === 1;
  }

  public getLatestTestRun(platformId: PlatformId): PlatformTestRunRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM platform_test_runs WHERE platform_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(platformId) as TestRunRow | undefined;
    return row ? mapTestRun(row) : null;
  }

  public createTestRun(run: PlatformTestRunRecord): void {
    this.database.prepare(`
      INSERT INTO platform_test_runs(
        id, platform_id, admin_id, success, media_types_json, missing_fields_json,
        duration_ms, error_category, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.platformId,
      run.adminId,
      run.success ? 1 : 0,
      JSON.stringify(run.mediaTypes),
      JSON.stringify(run.missingFields),
      run.durationMs,
      run.errorCategory,
      run.createdAt,
      run.expiresAt,
    );
  }
}
