import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyService } from '../../src/auth/api-key-service.js';
import { DatabaseConnection } from '../../src/database/connection.js';
import { ApiClientRepository } from '../../src/database/repositories/api-client-repository.js';

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

describe('API key lifecycle and limits', () => {
  it('stores only a hash and rejects disabled, expired, revoked and disabled-client keys', () => {
    const { repository, service } = setup();
    const client = service.createClient({ name: 'client' });
    const created = service.createKey(client.id, { name: 'key' });
    if (!created) throw new Error('key was not created');
    expect(JSON.stringify(repository.getKey(created.record.id))).not.toContain(created.apiKey);
    service.authorize(`Bearer ${created.apiKey}`).release();

    service.updateKey(created.record.id, { enabled: false });
    expectUnauthorized(() => service.authorize(`Bearer ${created.apiKey}`));
    service.updateKey(created.record.id, { enabled: true, expiresAt: new Date(0).toISOString() });
    expectUnauthorized(() => service.authorize(`Bearer ${created.apiKey}`));

    const active = service.createKey(client.id, { name: 'active' });
    if (!active) throw new Error('active key was not created');
    service.updateClient(client.id, { enabled: false });
    expectUnauthorized(() => service.authorize(`Bearer ${active.apiKey}`));
    service.updateClient(client.id, { enabled: true });
    service.revokeKey(active.record.id, 'test');
    expectUnauthorized(() => service.authorize(`Bearer ${active.apiKey}`));
  });

  it('enforces per-minute, per-key and global concurrency and releases idempotently', () => {
    const { service } = setup(1);
    const client = service.createClient({ name: 'client' });
    const limited = service.createKey(client.id, {
      name: 'limited', rateLimitPerMinute: 2, maxConcurrency: 1,
    });
    const other = service.createKey(client.id, {
      name: 'other', rateLimitPerMinute: 10, maxConcurrency: 1,
    });
    if (!limited || !other) throw new Error('keys were not created');
    const lease = service.authorize(`Bearer ${limited.apiKey}`);
    expectCode(() => service.authorize(`Bearer ${limited.apiKey}`), 'CONCURRENCY_LIMITED');
    expectCode(() => service.authorize(`Bearer ${other.apiKey}`), 'CONCURRENCY_LIMITED');
    lease.release();
    lease.release();
    service.authorize(`Bearer ${other.apiKey}`).release();
    expectCode(() => service.authorize(`Bearer ${limited.apiKey}`), 'RATE_LIMITED');
  });
});

function setup(globalConcurrency = 20): {
  repository: ApiClientRepository;
  service: ApiKeyService;
} {
  const connection = new DatabaseConnection(':memory:');
  connections.push(connection);
  const repository = new ApiClientRepository(connection.database);
  return { repository, service: new ApiKeyService(repository, globalConcurrency) };
}

function expectUnauthorized(operation: () => unknown): void {
  expectCode(operation, 'UNAUTHORIZED');
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrow(expect.objectContaining({ code }));
}
