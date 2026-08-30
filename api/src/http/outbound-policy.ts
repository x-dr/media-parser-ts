import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface OutboundPolicyOptions {
  allowedHosts: readonly string[];
  allowHttp?: boolean;
}

function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

function inIpv4Range(value: number, base: number, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffff_ffff << (32 - prefixLength)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Number(address);
    if (value === null) return true;
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => {
      const baseValue = ipv4Number(base as string);
      return baseValue !== null && inIpv4Range(value, baseValue, prefix as number);
    });
  }
  if (version === 6) {
    const normalized = address.toLowerCase().split('%')[0] ?? '';
    if (normalized.startsWith('::ffff:')) {
      return isBlockedAddress(normalized.slice('::ffff:'.length));
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff')
    );
  }
  return true;
}

export class OutboundPolicy {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #allowHttp: boolean;

  public constructor(options: OutboundPolicyOptions) {
    this.#allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase().replace(/\.$/, '')));
    this.#allowHttp = options.allowHttp ?? true;
  }

  public assertUrl(url: URL): void {
    if (url.protocol !== 'https:' && !(this.#allowHttp && url.protocol === 'http:')) {
      throw new Error('仅允许 HTTP(S) 上游地址');
    }
    if (url.username || url.password) throw new Error('上游 URL 不允许包含用户名或密码');
    if ((url.protocol === 'https:' && url.port && url.port !== '443') ||
        (url.protocol === 'http:' && url.port && url.port !== '80')) {
      throw new Error('上游 URL 不允许使用异常端口');
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (isIP(hostname) !== 0 || !this.#isAllowedHost(hostname)) {
      throw new Error('上游域名不在平台允许列表中');
    }
  }

  public assertAddress(address: string): void {
    if (isBlockedAddress(address)) throw new Error('上游域名解析到禁止访问的地址');
  }

  public async validateUrl(url: URL): Promise<void> {
    this.assertUrl(url);
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) throw new Error('上游域名没有可用 DNS 记录');
    for (const address of addresses) this.assertAddress(address.address);
  }

  #isAllowedHost(hostname: string): boolean {
    if (this.#allowedHosts.has(hostname)) return true;
    for (const allowed of this.#allowedHosts) {
      if (allowed.startsWith('*.') && hostname.endsWith(allowed.slice(1))) return true;
    }
    return false;
  }
}
