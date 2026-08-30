export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE admins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_params_json TEXT NOT NULL,
        must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER admins_singleton
      BEFORE INSERT ON admins
      WHEN (SELECT COUNT(*) FROM admins) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'only one administrator is allowed');
      END;

      CREATE TABLE admin_sessions (
        id TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admins(id),
        family_id TEXT NOT NULL,
        access_token_hash TEXT NOT NULL UNIQUE,
        access_expires_at TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        refresh_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        revoked_at TEXT,
        revoke_reason TEXT
      ) STRICT;

      CREATE INDEX admin_sessions_admin_idx ON admin_sessions(admin_id, revoked_at);
      CREATE INDEX admin_sessions_family_idx ON admin_sessions(family_id);

      CREATE TABLE admin_login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username_normalized TEXT NOT NULL,
        request_ip TEXT NOT NULL,
        successful INTEGER NOT NULL CHECK (successful IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX admin_login_attempts_window_idx
        ON admin_login_attempts(username_normalized, request_ip, created_at);

      CREATE TABLE api_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES api_clients(id),
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute > 0),
        max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
        expires_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        revoke_reason TEXT
      ) STRICT;

      CREATE INDEX api_keys_client_idx ON api_keys(client_id, created_at);

      CREATE TABLE parse_request_logs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL REFERENCES api_clients(id),
        api_key_id TEXT NOT NULL REFERENCES api_keys(id),
        input_text TEXT NOT NULL,
        share_url TEXT NOT NULL,
        real_url TEXT,
        platform_id TEXT,
        request_ip TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'client_aborted')),
        http_status INTEGER,
        retcode INTEGER,
        success INTEGER CHECK (success IS NULL OR success IN (0, 1)),
        error_code TEXT,
        response_json TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX parse_logs_created_idx ON parse_request_logs(created_at DESC, id DESC);
      CREATE INDEX parse_logs_client_idx ON parse_request_logs(client_id, created_at DESC);
      CREATE INDEX parse_logs_key_idx ON parse_request_logs(api_key_id, created_at DESC);
      CREATE INDEX parse_logs_platform_idx ON parse_request_logs(platform_id, created_at DESC);
      CREATE INDEX parse_logs_expires_idx ON parse_request_logs(expires_at);

      CREATE TABLE platform_settings (
        platform_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE platform_secrets (
        platform_id TEXT NOT NULL REFERENCES platform_settings(platform_id),
        credential_name TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        key_version INTEGER NOT NULL,
        masked_hint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (platform_id, credential_name)
      ) STRICT;

      CREATE TABLE platform_test_runs (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL REFERENCES platform_settings(platform_id),
        admin_id TEXT NOT NULL REFERENCES admins(id),
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        media_types_json TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        error_category TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX platform_test_runs_platform_idx
        ON platform_test_runs(platform_id, created_at DESC);
      CREATE INDEX platform_test_runs_expires_idx ON platform_test_runs(expires_at);

      CREATE TABLE admin_audit_logs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        admin_id TEXT REFERENCES admins(id),
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        outcome TEXT NOT NULL,
        request_ip TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX audit_logs_created_idx ON admin_audit_logs(created_at DESC, id DESC);
      CREATE INDEX audit_logs_expires_idx ON admin_audit_logs(expires_at);
    `,
  },
] as const;
