import { ulid } from 'ulid';
import type { AppConfig } from '../config/env.js';
import type { LogRepository } from '../database/repositories/log-repository.js';
import { redactMetadata } from './redact.js';

export interface AuditInput {
  requestId: string;
  adminId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: 'success' | 'failure';
  requestIp: string;
  metadata?: Record<string, unknown>;
}

export class AuditLogService {
  public constructor(
    private readonly repository: LogRepository,
    private readonly config: AppConfig,
  ) {}

  public record(input: AuditInput): void {
    const now = new Date();
    this.repository.insertAudit({
      id: ulid(),
      requestId: input.requestId,
      adminId: input.adminId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      outcome: input.outcome,
      requestIp: input.requestIp,
      metadataJson: JSON.stringify(redactMetadata(input.metadata ?? {})),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.logRetentionDays * 86_400_000).toISOString(),
    });
  }
}
