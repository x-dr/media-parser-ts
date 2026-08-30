import type { LogRepository } from '../database/repositories/log-repository.js';

const TABLES = ['parse_request_logs', 'platform_test_runs', 'admin_audit_logs'] as const;

export class RetentionService {
  #timer: NodeJS.Timeout | null = null;

  public constructor(private readonly repository: LogRepository) {}

  public async cleanup(): Promise<number> {
    let total = 0;
    for (const table of TABLES) {
      while (true) {
        const deleted = this.repository.deleteExpired(table, new Date().toISOString());
        total += deleted;
        if (deleted < 1000) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return total;
  }

  public start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.cleanup();
    }, 60 * 60 * 1000);
    this.#timer.unref();
  }

  public stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
