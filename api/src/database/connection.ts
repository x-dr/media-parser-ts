import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { platformIds } from '../config/platforms.js';
import { migrations } from './migrations/index.js';

export class DatabaseConnection {
  public readonly database: Database.Database;

  public constructor(path: string) {
    // DATABASE_PATH is an operator-controlled startup setting, never request input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { timeout: 5_000 });
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    this.#migrate();
    this.#synchronizePlatforms();
  }

  public checkReady(): { ready: true; migrationVersion: number } {
    const row = this.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number | null;
    };
    const migrationVersion = row.version ?? 0;
    const expectedVersion = migrations.at(-1)?.version ?? 0;
    if (migrationVersion !== expectedVersion) throw new Error('数据库迁移版本不完整');

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE platform_settings SET updated_at = updated_at WHERE 0').run();
    } finally {
      this.database.exec('ROLLBACK');
    }
    return { ready: true, migrationVersion };
  }

  public close(): void {
    this.database.close();
  }

  #migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    const applied = new Set(
      (this.database.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
        .map((row) => row.version),
    );
    const apply = this.database.transaction((version: number, sql: string) => {
      this.database.exec(sql);
      this.database.prepare(
        'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
      ).run(version, new Date().toISOString());
    });
    for (const migration of migrations) {
      if (!applied.has(migration.version)) apply(migration.version, migration.sql);
    }
  }

  #synchronizePlatforms(): void {
    const statement = this.database.prepare(`
      INSERT INTO platform_settings(platform_id, enabled, created_at, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(platform_id) DO NOTHING
    `);
    const synchronize = this.database.transaction(() => {
      const now = new Date().toISOString();
      for (const platformId of platformIds) statement.run(platformId, now, now);
    });
    synchronize();
  }
}
