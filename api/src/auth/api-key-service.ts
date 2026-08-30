import { ulid } from 'ulid';
import { AppError } from '../core/errors.js';
import {
  ApiClientRepository,
  type ApiClientRecord,
  type ApiKeyRecord,
  type ApiKeyWithClient,
} from '../database/repositories/api-client-repository.js';
import { createApiKey, hashToken, maskSecret, parseApiKey, safeHashEqual } from './tokens.js';

export interface ApiKeyIdentity {
  clientId: string;
  apiKeyId: string;
  rateLimitPerMinute: number;
  maxConcurrency: number;
}

export interface ApiKeyLease {
  identity: ApiKeyIdentity;
  release(): void;
}

export interface CreatedApiKey {
  record: ApiKeyRecord;
  apiKey: string;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

export class ApiKeyService {
  readonly #rateWindows = new Map<string, RateWindow>();
  readonly #activeByKey = new Map<string, number>();
  #activeGlobal = 0;

  public constructor(
    private readonly repository: ApiClientRepository,
    private readonly globalConcurrency: number,
  ) {}

  public listClients(): ApiClientRecord[] {
    return this.repository.listClients();
  }

  public getClient(id: string): ApiClientRecord | null {
    return this.repository.getClient(id);
  }

  public createClient(input: { name: string; note?: string; enabled?: boolean }): ApiClientRecord {
    const now = new Date().toISOString();
    const record: ApiClientRecord = {
      id: ulid(),
      name: input.name.trim(),
      note: input.note?.trim() ?? '',
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.repository.createClient(record);
    return record;
  }

  public updateClient(
    id: string,
    changes: { name?: string; note?: string; enabled?: boolean },
  ): ApiClientRecord | null {
    const normalized = {
      ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
      ...(changes.note === undefined ? {} : { note: changes.note.trim() }),
      ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
    };
    if (!this.repository.updateClient(id, normalized, new Date().toISOString())) return null;
    return this.repository.getClient(id);
  }

  public listKeys(clientId: string): ApiKeyRecord[] {
    return this.repository.listKeys(clientId);
  }

  public createKey(
    clientId: string,
    input: {
      name: string;
      rateLimitPerMinute?: number;
      maxConcurrency?: number;
      expiresAt?: string | null;
    },
  ): CreatedApiKey | null {
    if (!this.repository.getClient(clientId)) return null;
    const id = ulid();
    const apiKey = createApiKey(id);
    const now = new Date().toISOString();
    const record: ApiKeyRecord = {
      id,
      clientId,
      name: input.name.trim(),
      keyPrefix: maskSecret(apiKey),
      keyHash: hashToken(apiKey),
      enabled: true,
      rateLimitPerMinute: input.rateLimitPerMinute ?? 30,
      maxConcurrency: input.maxConcurrency ?? 3,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
      revokeReason: null,
    };
    this.repository.createKey(record);
    return { record, apiKey };
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
  ): ApiKeyRecord | null {
    if (!this.repository.updateKey(id, changes, new Date().toISOString())) return null;
    return this.repository.getKey(id);
  }

  public revokeKey(id: string, reason: string): ApiKeyRecord | null {
    if (!this.repository.revokeKey(id, reason, new Date().toISOString())) return null;
    return this.repository.getKey(id);
  }

  public authorize(authorizationHeader: string | undefined): ApiKeyLease {
    const now = Date.now();
    const record = this.#resolveActiveRecord(authorizationHeader, now);
    if (!record) throw new AppError('UNAUTHORIZED', 401, '认证失败');
    this.#consumeRate(record.id, record.rateLimitPerMinute, now);
    const activeForKey = this.#activeByKey.get(record.id) ?? 0;
    if (activeForKey >= record.maxConcurrency || this.#activeGlobal >= this.globalConcurrency) {
      throw new AppError('CONCURRENCY_LIMITED', 429, '并发请求过多，请稍后重试');
    }
    this.#activeByKey.set(record.id, activeForKey + 1);
    this.#activeGlobal += 1;
    this.repository.markKeyUsed(record.id, new Date(now).toISOString());
    let released = false;
    return {
      identity: {
        clientId: record.clientId,
        apiKeyId: record.id,
        rateLimitPerMinute: record.rateLimitPerMinute,
        maxConcurrency: record.maxConcurrency,
      },
      release: () => {
        if (released) return;
        released = true;
        const current = this.#activeByKey.get(record.id) ?? 1;
        if (current <= 1) this.#activeByKey.delete(record.id);
        else this.#activeByKey.set(record.id, current - 1);
        this.#activeGlobal = Math.max(0, this.#activeGlobal - 1);
      },
    };
  }

  public isAuthorized(authorizationHeader: string | undefined): boolean {
    return this.#resolveActiveRecord(authorizationHeader, Date.now()) !== null;
  }

  #resolveActiveRecord(authorizationHeader: string | undefined, now: number): ApiKeyWithClient | null {
    const token = bearerToken(authorizationHeader);
    const parsed = token ? parseApiKey(token) : null;
    const record = parsed ? this.repository.getKeyWithClient(parsed.keyId) : null;
    if (
      !parsed ||
      !record ||
      !record.enabled ||
      !record.clientEnabled ||
      record.revokedAt ||
      (record.expiresAt !== null && Date.parse(record.expiresAt) <= now) ||
      !safeHashEqual(hashToken(parsed.token), record.keyHash)
    ) {
      return null;
    }
    return record;
  }

  #consumeRate(keyId: string, limit: number, now: number): void {
    const window = this.#rateWindows.get(keyId);
    if (!window || now - window.startedAt >= 60_000) {
      this.#rateWindows.set(keyId, { startedAt: now, count: 1 });
      return;
    }
    if (window.count >= limit) throw new AppError('RATE_LIMITED', 429, '请求过于频繁，请稍后重试');
    window.count += 1;
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1] ?? null;
}
