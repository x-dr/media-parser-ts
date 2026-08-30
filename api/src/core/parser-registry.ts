import type { PlatformId } from '../config/platforms.js';
import { platformIds } from '../config/platforms.js';
import type { ParserFactory } from './parser.js';

export interface ParserRegistration {
  factory: ParserFactory;
  allowedHosts: readonly string[];
}

const registrations = new Map<PlatformId, ParserRegistration>();

export function registerParser(platformId: PlatformId, registration: ParserRegistration): void {
  if (registrations.has(platformId)) throw new Error(`Parser 重复注册：${platformId}`);
  registrations.set(platformId, registration);
}

export function getParserRegistration(platformId: PlatformId): ParserRegistration {
  const registration = registrations.get(platformId);
  if (!registration) throw new Error(`Parser 尚未迁移：${platformId}`);
  return registration;
}

export function getRegisteredPlatformIds(): PlatformId[] {
  return [...registrations.keys()];
}

export function assertRegistryComplete(): void {
  const missing = platformIds.filter((platformId) => !registrations.has(platformId));
  if (missing.length > 0) throw new Error(`Parser 注册不完整：${missing.join(', ')}`);
}
