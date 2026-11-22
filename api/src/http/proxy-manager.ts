import { isIP } from 'node:net';
import got from 'got';
import type { FastifyBaseLogger } from 'fastify';
import type { ProxyMode } from '../config/env.js';
import type { PlatformId } from '../config/platforms.js';
import { isBlockedAddress } from './outbound-policy.js';
import type { ProxyEndpoint } from './proxy-agent.js';

export interface ProxyLease extends ProxyEndpoint {
  expiresAtMs: number;
}

interface StoredProxy extends ProxyLease {
  createdAtMs: number;
  lastUsedMs: number;
  invalid: boolean;
  retired: boolean;
}

export interface ProxyManagerOptions {
  apiUrl: URL | null;
  mode: ProxyMode;
  poolSize: number;
  fetchPerSecond: number;
  logger?: FastifyBaseLogger;
  fetcher?: (url: URL, signal: AbortSignal) => Promise<string>;
}

const WINDOW_DURATION_MS = 900_000;
const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export class ProxyManager {
  readonly #apiUrl: URL | null;
  readonly #mode: ProxyMode;
  readonly #poolSize: number;
  readonly #fetchIntervalMs: number;
  readonly #logger: FastifyBaseLogger | undefined;
  readonly #fetcher: (url: URL, signal: AbortSignal) => Promise<string>;
  readonly #platformWindows = new Map<PlatformId, number>();
  readonly #pool = new Map<string, StoredProxy>();
  #nextFetchAtMs = 0;
  #fetching = false;
  #consecutiveFailures = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  public constructor(options: ProxyManagerOptions) {
    this.#apiUrl = options.apiUrl;
    this.#mode = options.mode;
    this.#poolSize = options.poolSize;
    this.#fetchIntervalMs = Math.max(50, Math.floor(1_000 / Math.max(1, options.fetchPerSecond)));
    this.#logger = options.logger;
    this.#fetcher = options.fetcher ?? defaultProxyFetcher;
  }

  public get enabled(): boolean {
    return this.#apiUrl !== null;
  }

  public get always(): boolean {
    return this.enabled && this.#mode === 'always';
  }

  public start(): void {
    if (!this.enabled || this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.maintainOnce();
    }, Math.min(1_000, this.#fetchIntervalMs));
    this.#timer.unref();
  }

  public stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  public active(platformId: PlatformId | null): boolean {
    if (!this.enabled) return false;
    if (this.#mode === 'always') return true;
    if (!platformId) return false;
    const until = this.#platformWindows.get(platformId);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.#platformWindows.delete(platformId);
      return false;
    }
    return true;
  }

  public activate(platformId: PlatformId): void {
    if (!this.enabled || this.#mode === 'always') return;
    const now = Date.now();
    const existing = this.#platformWindows.get(platformId) ?? 0;
    if (existing <= now) {
      this.#platformWindows.set(platformId, now + WINDOW_DURATION_MS);
      this.#logger?.info({ platform_id: platformId, duration_seconds: 900 }, 'activated platform dynamic proxy window');
    }
  }

  public available(excluded: ReadonlySet<string> = new Set()): ProxyLease | null {
    const now = Date.now();
    this.#pruneExpired(now);
    const candidates = [...this.#pool.values()]
      .filter((entry) => !entry.invalid && !entry.retired && entry.expiresAtMs > now + 10_000 && !excluded.has(entry.address))
      .sort((left, right) =>
        (left.lastUsedMs - right.lastUsedMs) ||
        (left.createdAtMs - right.createdAtMs) ||
        left.address.localeCompare(right.address),
      );
    const chosen = candidates[0];
    if (!chosen) return null;
    chosen.lastUsedMs = now;
    return {
      address: chosen.address,
      host: chosen.host,
      port: chosen.port,
      expiresAtMs: chosen.expiresAtMs,
    };
  }

  public isValid(address: string): boolean {
    const entry = this.#pool.get(address);
    return Boolean(entry && !entry.invalid && entry.expiresAtMs > Date.now());
  }

  public invalidate(address: string, reason: string): void {
    const entry = this.#pool.get(address);
    if (entry && !entry.invalid) {
      entry.invalid = true;
      this.#logger?.info({ proxy_address: address, reason }, 'invalidated dynamic proxy address');
    }
  }

  public async replenish(signal: AbortSignal): Promise<boolean> {
    if (!this.#apiUrl || signal.aborted) return false;
    const now = Date.now();
    this.#pruneExpired(now);
    const healthyCount = [...this.#pool.values()].filter((item) => !item.invalid && !item.retired).length;
    if (healthyCount >= this.#poolSize || this.#fetching || this.#nextFetchAtMs > now) {
      return false;
    }
    this.#fetching = true;
    this.#nextFetchAtMs = now + this.#fetchIntervalMs;
    let accepted = false;
    try {
      const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      const rawBody = await this.#fetcher(this.#apiUrl, fetchSignal);
      let parsedPayload: unknown = rawBody;
      const trimmed = rawBody.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          parsedPayload = JSON.parse(trimmed) as unknown;
        } catch {
          parsedPayload = rawBody;
        }
      }
      const decoded = decodeProxyPayload(parsedPayload, now);
      if (decoded.expiresAtMs > Date.now() + 10_000 && !this.#pool.has(decoded.address)) {
        this.#pool.set(decoded.address, {
          ...decoded,
          createdAtMs: now,
          lastUsedMs: 0,
          invalid: false,
          retired: false,
        });
        accepted = true;
      }
    } catch {
      this.#logger?.warn({ error_category: 'proxy_replenish_failed' }, 'failed to fetch dynamic proxy address');
    } finally {
      this.#fetching = false;
      if (accepted) {
        this.#consecutiveFailures = 0;
        this.#nextFetchAtMs = Math.max(this.#nextFetchAtMs, Date.now() + this.#fetchIntervalMs);
      } else {
        this.#consecutiveFailures += 1;
        const backoffMs = BACKOFF_STEPS_MS[Math.min(this.#consecutiveFailures - 1, BACKOFF_STEPS_MS.length - 1)] ?? 15_000;
        this.#nextFetchAtMs = Math.max(this.#nextFetchAtMs, Date.now() + backoffMs);
      }
    }
    return true;
  }

  public async maintainOnce(): Promise<void> {
    const now = Date.now();
    this.#pruneExpired(now);
    for (const [platformId, until] of this.#platformWindows) {
      if (until <= now) {
        this.#platformWindows.delete(platformId);
        this.#logger?.info({ platform_id: platformId }, 'restored direct platform connection after proxy window');
      }
    }
    if (this.always || this.#platformWindows.size > 0) {
      await this.replenish(AbortSignal.timeout(5_000));
    }
  }

  #pruneExpired(nowMs: number): void {
    for (const [address, item] of this.#pool) {
      if (item.expiresAtMs <= nowMs) {
        this.#pool.delete(address);
      } else if (item.expiresAtMs <= nowMs + 20_000) {
        item.retired = true;
      }
    }
  }
}

export function decodeProxyPayload(payload: unknown, startedMs: number): ProxyLease {
  let ip = '';
  let port = 0;
  let remainSeconds: number | null = null;

  if (typeof payload === 'string') {
    const match = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/u.exec(payload);
    if (match?.[1] && match[2]) {
      ip = match[1];
      port = Number(match[2]);
      remainSeconds = 300;
    }
  } else if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const root = payload as Record<string, unknown>;
    const code = root.code;
    const success = root.success;
    const validCode = code === 200 || code === 0 || code === '200' || code === '0' || code === 'SUCCESS' || success === true;
    if (!validCode && code !== undefined) {
      throw new Error('代理供应商返回失败状态');
    }
    let rows: unknown[] | null = null;
    const dataField = root.data;
    if (Array.isArray(dataField)) {
      rows = dataField;
    } else if (dataField !== null && typeof dataField === 'object') {
      const dataObj = dataField as Record<string, unknown>;
      const listCandidate = dataObj.proxy_list ?? dataObj.list ?? dataObj.proxies;
      rows = Array.isArray(listCandidate) ? listCandidate : [dataObj];
    } else if (Array.isArray(root.proxy_list)) {
      rows = root.proxy_list;
    }

    const first = rows?.[0];
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      const row = first as Record<string, unknown>;
      const rawIp = row.ip ?? row.outip ?? row.server ?? row.host;
      const rawPort = row.port ?? row.server_port;
      ip = typeof rawIp === 'string' ? rawIp.trim() : '';
      port = typeof rawPort === 'number' || typeof rawPort === 'string' ? Number(rawPort) : 0;

      const hasExplicitRemain = 'ip_remain' in row || 'ttl' in row || 'expire_seconds' in row;
      const rawRemain = 'ip_remain' in row ? row.ip_remain : ('ttl' in row ? row.ttl : row.expire_seconds);
      if (hasExplicitRemain) {
        const parsedRemain = Number(rawRemain);
        if (!Number.isFinite(parsedRemain)) throw new Error('代理有效期无效');
        remainSeconds = parsedRemain;
      } else {
        const expVal = row.expire_time ?? row.deadline;
        if (typeof expVal === 'number' && expVal > 1_000_000_000) {
          remainSeconds = expVal - (startedMs / 1_000);
        } else if (typeof expVal === 'string') {
          const parsedDate = Date.parse(expVal.trim().replace(' ', 'T') + '+08:00');
          if (Number.isFinite(parsedDate)) {
            remainSeconds = (parsedDate - startedMs) / 1_000;
          }
        }
      }
      if (remainSeconds === null) remainSeconds = 300;
    }
  }

  if (!ip || !Number.isInteger(port) || port < 1 || port > 65_535 || remainSeconds === null || !(remainSeconds > 10 && Number.isFinite(remainSeconds))) {
    throw new Error('未能提取到有效的代理 IP 或端口');
  }
  if (isIP(ip) !== 4 || isBlockedAddress(ip)) {
    throw new Error('代理地址不是合法的公网 IPv4 地址');
  }
  const expiresAtMs = startedMs + Math.floor(remainSeconds * 1_000);
  if (expiresAtMs <= Date.now() + 10_000) {
    throw new Error('代理剩余有效期不足');
  }
  return {
    address: `${ip}:${port}`,
    host: ip,
    port,
    expiresAtMs,
  };
}

async function defaultProxyFetcher(url: URL, signal: AbortSignal): Promise<string> {
  const response = await got(url, {
    method: 'GET',
    retry: { limit: 0 },
    timeout: { request: 5_000 },
    followRedirect: false,
    signal,
    responseType: 'text',
  });
  return response.body;
}
