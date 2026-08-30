import { ulid } from 'ulid';
import type { AppConfig } from '../config/env.js';
import type {
  CompletedParseLog,
  LogRepository,
  ParseLogFilters,
  ParseLogListRow,
  ParseLogDetailRow,
} from '../database/repositories/log-repository.js';

export interface CreateRequestLogInput {
  requestId: string;
  clientId: string;
  apiKeyId: string;
  inputText: string;
  shareUrl: string;
  requestIp: string;
  userAgent: string;
}

export class RequestLogService {
  public constructor(
    private readonly repository: LogRepository,
    private readonly config: AppConfig,
  ) {}

  public createPending(input: CreateRequestLogInput): string {
    const now = new Date();
    const id = ulid();
    this.repository.createPending({
      id,
      ...input,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.logRetentionDays * 86_400_000).toISOString(),
    });
    return id;
  }

  public complete(requestId: string, result: CompletedParseLog): void {
    if (!this.repository.complete(requestId, result)) {
      throw new Error('无法完成解析调用日志');
    }
  }

  public list(filters: ParseLogFilters): ParseLogListRow[] {
    return this.repository.list(filters);
  }

  public get(id: string): ParseLogDetailRow | null {
    return this.repository.get(id);
  }

  public export(filters: ParseLogFilters): IterableIterator<ParseLogDetailRow> {
    return this.repository.export(filters);
  }

  public stats(filters: ParseLogFilters, groupBy: 'platform_id' | 'client_id' | null): {
    aggregates: unknown[];
    errors: unknown[];
    percentiles: { p50: number | null; p95: number | null; p99: number | null };
  } {
    const durations = this.repository.getDurations(filters);
    return {
      aggregates: this.repository.aggregate(filters, groupBy),
      errors: this.repository.aggregateErrors(filters),
      percentiles: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
      },
    };
  }
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  return values[Math.ceil(values.length * quantile) - 1] ?? null;
}
