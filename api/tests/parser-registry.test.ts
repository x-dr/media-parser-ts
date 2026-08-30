import { describe, expect, it } from 'vitest';
import { platformIds } from '../src/config/platforms.js';
import { detectPlatform } from '../src/config/platforms.js';
import { assertRegistryComplete, getRegisteredPlatformIds } from '../src/core/parser-registry.js';
import { defaultPlatformSamples } from '../src/platform-admin/platform-test-samples.js';
import '../src/platforms/index.js';

describe('parser registry', () => {
  it('registers every configured platform exactly once', () => {
    expect(() => assertRegistryComplete()).not.toThrow();
    expect(new Set(getRegisteredPlatformIds())).toEqual(new Set(platformIds));
    expect(getRegisteredPlatformIds()).toHaveLength(31);
  });

  it('keeps one detectable registered live sample for every platform', () => {
    expect(Object.keys(defaultPlatformSamples)).toHaveLength(31);
    for (const platformId of platformIds) {
      expect(detectPlatform(new URL(defaultPlatformSamples[platformId])), platformId).toBe(platformId);
    }
  });
});
