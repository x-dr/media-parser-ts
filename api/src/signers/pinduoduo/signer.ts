import { readFileSync } from 'node:fs';
import { Script, createContext, type Context } from 'node:vm';

export interface PinduoduoSigner {
  getAntiContent(): string;
}

export interface PinduoduoSignerOptions {
  random?: () => number;
  now?: () => number;
}

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1';

const SETUP_SCRIPT = `
var window = globalThis;
var self = globalThis;
var setTimeout = function() { return 0; };
var clearTimeout = function() {};
var setInterval = function() { return 0; };
var clearInterval = function() {};
var history = { back: function(){}, forward: function(){}, go: function(){}, length: 1 };
function Element() {}
function HTMLElement() {}
function HTMLCanvasElement() {}
function HTMLImageElement() {}
var document = {
  referrer: 'https://mobile.yangkeduo.com/',
  cookie: '',
  documentElement: { clientWidth: 375, clientHeight: 667 },
  body: { clientWidth: 375, clientHeight: 667 },
  createElement: function() { return { getContext: function() { return null; } }; },
  getElementsByTagName: function() { return []; },
  addEventListener: function() {},
  removeEventListener: function() {}
};
var location = {
  href: 'https://mobile.yangkeduo.com/fyxmkief.html',
  origin: 'https://mobile.yangkeduo.com',
  protocol: 'https:',
  host: 'mobile.yangkeduo.com',
  hostname: 'mobile.yangkeduo.com',
  pathname: '/fyxmkief.html',
  search: '',
  hash: ''
};
var navigator = {
  userAgent: '${MOBILE_USER_AGENT}',
  appVersion: '5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  language: 'zh-CN',
  languages: ['zh-CN', 'zh'],
  cookieEnabled: true,
  cookie: ''
};
var screen = { width: 375, height: 667, availWidth: 375, availHeight: 667, colorDepth: 24 };

var exportFn;
var __LOADABLE_LOADED_CHUNKS__ = {
  push: function(arr) {
    var mods = arr && arr[1];
    if (mods && mods[53636]) {
      var moduleObj = { exports: {} };
      mods[53636](moduleObj);
      exportFn = moduleObj.exports;
    }
  }
};
`;

const INIT_SCRIPT = `
var crawler = typeof exportFn === 'function'
  ? new exportFn({ serverTime: Date.now(), _2827c887a48a351a: false })
  : null;
if (crawler && typeof crawler.init === 'function') crawler.init();
function getAntiContent() {
  if (!crawler || typeof crawler.messagePack !== 'function') return '';
  return crawler.messagePack() || '';
}
`;

export class LocalPinduoduoSigner implements PinduoduoSigner {
  readonly #context: Context | null;

  public constructor(options: PinduoduoSignerOptions = {}) {
    try {
      const context = createTrustedPddContext(options);
      // Trusted version-controlled signer bundle copied from upstream baseline.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const antiCode = readFileSync(new URL('./anti_content.js', import.meta.url), 'utf8');
      new Script(SETUP_SCRIPT, { filename: 'pdd_setup.js' }).runInContext(context);
      new Script(antiCode, { filename: 'anti_content.js' }).runInContext(context);
      new Script(INIT_SCRIPT, { filename: 'pdd_init.js' }).runInContext(context);
      this.#context = context;
    } catch {
      this.#context = null;
    }
  }

  public getAntiContent(): string {
    if (!this.#context) return '';
    try {
      const fn: unknown = Reflect.get(this.#context, 'getAntiContent');
      if (typeof fn !== 'function') return '';
      const token = (fn as () => unknown)();
      return typeof token === 'string' ? token : '';
    } catch {
      return '';
    }
  }
}

function createTrustedPddContext(options: PinduoduoSignerOptions): Context {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const math = Object.create(Math) as Math;
  Object.defineProperty(math, 'random', { value: random });
  class ControlledDate extends Date {
    public constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(now());
      } else {
        super(...(args as [number]));
      }
    }

    public static override now(): number {
      return now();
    }
  }
  return createContext({
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    Math: math,
    Date: ControlledDate,
    ArrayBuffer,
    DataView,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    URIError,
    JSON,
    Reflect,
    Proxy,
    Symbol,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    escape: legacyEscape,
    unescape: legacyUnescape,
    btoa: (input: string) => Buffer.from(input, 'binary').toString('base64'),
    atob: (input: string) => Buffer.from(input, 'base64').toString('binary'),
  });
}

function legacyEscape(input: string): string {
  return encodeURIComponent(input).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function legacyUnescape(input: string): string {
  return input
    .replace(/%u([0-9a-fA-F]{4})/gu, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%([0-9a-fA-F]{2})/gu, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
