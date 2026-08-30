import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type AdminTokenKind = 'access' | 'refresh';

export function createAdminToken(kind: AdminTokenKind): string {
  return `ma_${kind}_${randomBytes(32).toString('base64url')}`;
}

export function createApiKey(keyId: string): string {
  return `mp_${keyId}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeHashEqual(actualHash: string, expectedHash: string): boolean {
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseApiKey(value: string): { keyId: string; token: string } | null {
  const match = /^mp_([0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/u.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { keyId: match[1], token: value };
}

export function maskSecret(value: string): string {
  if (value.length <= 12) return '********';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
