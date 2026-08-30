import type { TokenPair } from '../types';

interface SuccessEnvelope<T> {
  data: T;
  request_id: string;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
  request_id?: string;
}

export class AdminApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

class AdminApiClient {
  private tokens: TokenPair | null = null;
  private sessionListener: ((tokens: TokenPair | null) => void) | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  public setSessionListener(listener: (tokens: TokenPair | null) => void): () => void {
    this.sessionListener = listener;
    return () => { this.sessionListener = null; };
  }

  public setTokens(tokens: TokenPair | null): void {
    this.tokens = tokens;
    this.sessionListener?.(tokens);
  }

  public async login(username: string, password: string): Promise<TokenPair> {
    const pair = await this.request<TokenPair>('/api/admin/v1/auth/login', {
      method: 'POST',
      body: { username, password },
      authenticated: false,
    });
    this.setTokens(pair);
    return pair;
  }

  public async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      authenticated?: boolean;
      signal?: AbortSignal;
    } = {},
    canRefresh = true,
  ): Promise<T> {
    const authenticated = options.authenticated ?? true;
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (authenticated && this.tokens) headers.set('Authorization', `Bearer ${this.tokens.access_token}`);
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 401 && authenticated && canRefresh && await this.refresh()) {
      return this.request<T>(path, options, false);
    }
    const payload = await this.readJson(response);
    if (!response.ok) throw this.toError(response.status, payload);
    return (payload as SuccessEnvelope<T>).data;
  }

  public async download(path: string, filename: string): Promise<void> {
    const response = await this.fetchDownload(path, true);
    if (!response.ok) {
      const payload = await this.readJson(response);
      throw this.toError(response.status, payload);
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private async fetchDownload(path: string, canRefresh: boolean): Promise<Response> {
    const headers = new Headers();
    if (this.tokens) headers.set('Authorization', `Bearer ${this.tokens.access_token}`);
    const response = await fetch(path, { headers });
    if (response.status === 401 && canRefresh && await this.refresh()) {
      return this.fetchDownload(path, false);
    }
    return response;
  }

  private async refresh(): Promise<boolean> {
    if (!this.tokens?.refresh_token) return false;
    if (!this.refreshPromise) {
      this.refreshPromise = this.request<TokenPair>('/api/admin/v1/auth/refresh', {
        method: 'POST',
        body: { refresh_token: this.tokens.refresh_token },
        authenticated: false,
      }, false).then((pair) => {
        this.setTokens(pair);
        return true;
      }).catch(() => {
        this.setTokens(null);
        return false;
      }).finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text) as unknown; } catch { return {}; }
  }

  private toError(status: number, payload: unknown): AdminApiError {
    const value = payload as ErrorEnvelope;
    return new AdminApiError(
      value.error?.message ?? '请求失败，请稍后重试',
      status,
      value.error?.code ?? 'REQUEST_FAILED',
      value.request_id,
    );
  }
}

export const adminApi = new AdminApiClient();

export const errorMessage = (error: unknown): string => {
  if (error instanceof AdminApiError) {
    return error.requestId ? `${error.message}（Request ID：${error.requestId}）` : error.message;
  }
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
};
