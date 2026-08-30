export interface AnonymousLease {
  release(): void;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

export class AnonymousRateLimiter {
  readonly #windows = new Map<string, RateWindow>();

  public constructor(private readonly limitPerMinute: number) {}

  public consume(ip: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfter: number } {
    if (this.#windows.size > 10_000) this.#discardExpired(now);
    const window = this.#windows.get(ip);
    if (!window || now - window.startedAt >= 60_000) {
      this.#windows.set(ip, { startedAt: now, count: 1 });
      return { allowed: true };
    }
    if (window.count >= this.limitPerMinute) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((60_000 - (now - window.startedAt)) / 1_000)),
      };
    }
    window.count += 1;
    return { allowed: true };
  }

  #discardExpired(now: number): void {
    for (const [ip, window] of this.#windows) {
      if (now - window.startedAt >= 60_000) this.#windows.delete(ip);
    }
  }
}

export class AnonymousConcurrencyGate {
  #active = 0;

  public constructor(private readonly limit: number) {}

  public acquire(): AnonymousLease | null {
    if (this.#active >= this.limit) return null;
    this.#active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active = Math.max(0, this.#active - 1);
      },
    };
  }
}
