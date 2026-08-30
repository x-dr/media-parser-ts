const SENSITIVE_KEY = /authorization|password|token|api[_-]?key|cookie|credential|secret/i;

export function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactMetadata(child);
    }
    return redacted;
  }
  return value;
}

export function redactMediaUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '[INVALID_URL]';
  }
}
