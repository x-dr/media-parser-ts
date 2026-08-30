import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../../src/database/connection.js';
import { PlatformRepository } from '../../src/database/repositories/platform-repository.js';
import { CredentialService } from '../../src/platform-admin/credential-service.js';
import { EncryptionService } from '../../src/security/encryption.js';
import { testConfig } from '../helpers.js';

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

describe('platform credential service', () => {
  it('prefers encrypted database values, masks responses and falls back to environment', async () => {
    const connection = new DatabaseConnection(':memory:');
    connections.push(connection);
    const repository = new PlatformRepository(connection.database);
    const environmentValue = 'environment-session-value';
    const databaseValue = 'database-session-value';
    const key = randomBytes(32);
    const service = new CredentialService(
      repository,
      new EncryptionService(key, null),
      await testConfig({
        encryptionKey: key,
        credentialEnvironment: { DOUBAO_COOKIE: environmentValue },
      }),
    );
    expect(service.getCredentials('doubao').cookie).toBe(environmentValue);
    const stored = service.setCredential('doubao', 'cookie', databaseValue);
    expect(stored).toMatchObject({ configured: true, source: 'database' });
    expect(stored.masked).not.toContain(databaseValue);
    expect(service.getCredentials('doubao').cookie).toBe(databaseValue);
    expect(JSON.stringify(repository.getSecret('doubao', 'cookie'))).not.toContain(databaseValue);
    service.deleteCredential('doubao', 'cookie');
    expect(service.getCredentials('doubao').cookie).toBe(environmentValue);
  });

  it('rejects undeclared credential names and fails readiness without a key', async () => {
    const connection = new DatabaseConnection(':memory:');
    connections.push(connection);
    const service = new CredentialService(
      new PlatformRepository(connection.database),
      new EncryptionService(null, null),
      await testConfig({ encryptionKey: null }),
    );
    expect(() => service.setCredential('doubao', 'password', 'value')).toThrow('不允许');
    expect(() => service.checkReady()).toThrow('加密密钥未配置');
  });
});
