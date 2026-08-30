import { Buffer } from 'node:buffer';
import { lookup } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import got, { RequestError, type Headers, type OptionsOfTextResponseBody } from 'got';
import { CookieJar } from 'tough-cookie';
import { UpstreamError } from '../core/errors.js';
import { OutboundPolicy } from './outbound-policy.js';

export interface HttpResponse {
  statusCode: number;
  url: URL;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Headers;
  searchParams?: URLSearchParams | Record<string, string | number | boolean>;
  json?: unknown;
  form?: Record<string, string | number | boolean>;
  body?: string | Buffer;
  followRedirect?: boolean;
  maxRedirects?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  discardBody?: boolean;
}

export interface HttpSessionOptions {
  allowedHosts: readonly string[];
  defaultHeaders?: Headers;
  timeoutMs: number;
  maxBodyBytes?: number;
  cookieJar?: CookieJar;
}

export class HttpSession {
  readonly #policy: OutboundPolicy;
  readonly #cookieJar: CookieJar;
  readonly #timeoutMs: number;
  readonly #maxBodyBytes: number;
  readonly #defaultHeaders: Headers;

  public constructor(options: HttpSessionOptions) {
    this.#policy = new OutboundPolicy({ allowedHosts: options.allowedHosts });
    this.#cookieJar = options.cookieJar ?? new CookieJar();
    this.#timeoutMs = options.timeoutMs;
    this.#maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
    this.#defaultHeaders = options.defaultHeaders ?? {};
  }

  public async request(url: URL | string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const parsedUrl = typeof url === 'string' ? new URL(url) : new URL(url.href);
    await this.#policy.validateUrl(parsedUrl);
    const maxBodyBytes = options.maxBodyBytes ?? this.#maxBodyBytes;

    try {
      const requestOptions: OptionsOfTextResponseBody = {
        method: options.method ?? 'GET',
        headers: { ...this.#defaultHeaders, ...options.headers },
        cookieJar: this.#cookieJar,
        timeout: { request: options.timeoutMs ?? this.#timeoutMs },
        retry: { limit: 0 },
        throwHttpErrors: false,
        followRedirect: options.followRedirect ?? false,
        maxRedirects: options.maxRedirects ?? 5,
        decompress: true,
        dnsLookup: this.#safeLookup,
        hooks: {
          beforeRedirect: [async (updatedOptions) => {
            if (!updatedOptions.url) throw new Error('重定向缺少目标 URL');
            await this.#policy.validateUrl(updatedOptions.url);
          }],
        },
      };
      if (options.searchParams !== undefined) requestOptions.searchParams = options.searchParams;
      if (options.json !== undefined) requestOptions.json = options.json;
      if (options.form !== undefined) requestOptions.form = options.form;
      if (options.body !== undefined) requestOptions.body = options.body;
      if (options.signal !== undefined) requestOptions.signal = options.signal;

      const stream = got.stream(parsedUrl, requestOptions);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const responsePromise = new Promise<{
        statusCode: number;
        url: URL;
        headers: Readonly<Record<string, string | string[] | undefined>>;
      }>((resolve, reject) => {
        stream.once('response', (response: IncomingMessage & { url: string }) => {
          resolve({
            statusCode: response.statusCode ?? 0,
            url: new URL(response.url),
            headers: response.headers,
          });
        });
        stream.once('error', reject);
      });

      if (options.discardBody) {
        const response = await responsePromise;
        stream.destroy();
        return { ...response, body: Buffer.alloc(0) };
      }

      for await (const rawChunk of stream) {
        const chunk: unknown = rawChunk;
        if (!(typeof chunk === 'string' || chunk instanceof Uint8Array)) {
          throw new UpstreamError('invalid_response', '上游返回了无效响应块');
        }
        const buffer = Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > maxBodyBytes) {
          stream.destroy(new UpstreamError('body_too_large', '上游响应体超过限制'));
          throw new UpstreamError('body_too_large', '上游响应体超过限制');
        }
        chunks.push(buffer);
      }
      const response = await responsePromise;
      return { ...response, body: Buffer.concat(chunks, totalBytes) };
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (error instanceof RequestError) {
        const category = error.code === 'ETIMEDOUT' ? 'timeout' : 'network';
        throw new UpstreamError(category, `上游请求失败：${error.code}`);
      }
      throw error;
    }
  }

  public async getText(url: URL | string, options: HttpRequestOptions = {}): Promise<string> {
    const response = await this.request(url, options);
    if (response.statusCode < 200 || response.statusCode >= 400) {
      throw new UpstreamError('http', `上游返回 HTTP ${response.statusCode}`, response.statusCode);
    }
    return response.body.toString('utf8');
  }

  public async getJson<T>(url: URL | string, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.request(url, options);
    if (response.statusCode < 200 || response.statusCode >= 400) {
      throw new UpstreamError('http', `上游返回 HTTP ${response.statusCode}`, response.statusCode);
    }
    try {
      return JSON.parse(response.body.toString('utf8')) as T;
    } catch {
      throw new UpstreamError('invalid_response', '上游未返回有效 JSON');
    }
  }

  public async setCookie(rawCookie: string, url: URL | string): Promise<void> {
    await this.#cookieJar.setCookie(rawCookie, typeof url === 'string' ? url : url.href);
  }

  readonly #safeLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address, family);
        return;
      }
      try {
        if (Array.isArray(address)) {
          for (const item of address) this.#policy.assertAddress(item.address);
        } else {
          this.#policy.assertAddress(address);
        }
        callback(null, address, family);
      } catch (lookupError) {
        callback(lookupError as Error, address, family);
      }
    });
  };
}
