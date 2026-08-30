import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { Script, createContext, type Context } from 'node:vm';

export interface ByteDanceSigner {
  getABogus(requestUrl: URL, userAgent: string): string;
  getXBogus(requestUrl: URL, userAgent: string): string;
  getMsToken(length?: number): string;
}

export interface SignerRuntimeOptions {
  random?: () => number;
  now?: () => number;
}

const TOKEN_ALPHABET = 'ABCDEFGHIGKLMNOPQRSTUVWXYZabcdefghigklmnopqrstuvwxyz0123456789=';

export class LocalByteDanceSigner implements ByteDanceSigner {
  readonly #aBogusContext: Context;
  readonly #xBogusContext: Context;
  readonly #random: () => number;

  public constructor(options: SignerRuntimeOptions = {}) {
    this.#random = options.random ?? (() => randomInt(0, 1_000_000) / 1_000_000);
    this.#aBogusContext = trustedContext(options);
    this.#xBogusContext = trustedContext(options);
    // These are version-controlled trusted algorithms, not remote challenge code.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const aBogus = readFileSync(new URL('./a_bogus.js', import.meta.url), 'utf8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const xBogus = readFileSync(new URL('./x_bogus.js', import.meta.url), 'utf8');
    new Script(aBogus, { filename: 'a_bogus.js' }).runInContext(this.#aBogusContext);
    new Script(xBogus, { filename: 'x_bogus.js' }).runInContext(this.#xBogusContext);
  }

  public getABogus(requestUrl: URL, userAgent: string): string {
    const signer: unknown = Reflect.get(this.#aBogusContext, 'generate_a_bogus');
    if (typeof signer !== 'function') throw new Error('a_bogus 签名函数未加载');
    const typedSigner = signer as (query: string, agent: string) => unknown;
    return String(typedSigner(requestUrl.search.slice(1), userAgent));
  }

  public getXBogus(requestUrl: URL, userAgent: string): string {
    const signer: unknown = Reflect.get(this.#xBogusContext, 'sign');
    if (typeof signer !== 'function') throw new Error('x_bogus 签名函数未加载');
    const typedSigner = signer as (query: string, agent: string) => unknown;
    return String(typedSigner(requestUrl.search.slice(1), userAgent));
  }

  public getMsToken(length = 107): string {
    if (!Number.isInteger(length) || length < 1 || length > 512) throw new Error('msToken 长度无效');
    let token = '';
    for (let index = 0; index < length; index += 1) {
      token += TOKEN_ALPHABET[Math.floor(this.#random() * TOKEN_ALPHABET.length)] ?? '';
    }
    return token;
  }
}

function trustedContext(options: SignerRuntimeOptions): Context {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const math = Object.create(Math) as Math;
  Object.defineProperty(math, 'random', { value: random });
  class ControlledDate extends Date {
    public static override now(): number {
      return now();
    }
  }
  return createContext({
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    Math: math,
    Date: ControlledDate,
    Uint8Array,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Reflect,
    Symbol,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
  });
}
