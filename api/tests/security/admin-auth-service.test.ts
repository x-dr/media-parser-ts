import { afterEach, describe, expect, it } from 'vitest';
import { AdminAuthService } from '../../src/auth/admin-auth-service.js';
import { DatabaseConnection } from '../../src/database/connection.js';
import { AdminRepository } from '../../src/database/repositories/admin-repository.js';
import { BOOTSTRAP_PASSWORD, testConfig } from '../helpers.js';

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

describe('administrator authentication lifecycle', () => {
  it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
    const service = await setup();
    const first = await service.login('ADMIN', BOOTSTRAP_PASSWORD, '192.0.2.1');
    const second = service.refresh(first.refreshToken);
    expect(() => service.refresh(first.refreshToken)).toThrow(
      expect.objectContaining({ code: 'ADMIN_UNAUTHORIZED' }),
    );
    expect(() => service.authenticateAccess(second.accessToken)).toThrow(
      expect.objectContaining({ code: 'ADMIN_UNAUTHORIZED' }),
    );
  });

  it('rate-limits repeated failed logins without exposing which field was wrong', async () => {
    const service = await setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.login('admin', 'wrong-password', '192.0.2.2')).rejects.toMatchObject({
        code: 'ADMIN_UNAUTHORIZED', message: '管理员认证失败',
      });
    }
    await expect(service.login('admin', 'wrong-password', '192.0.2.2')).rejects.toMatchObject({
      code: 'ADMIN_RATE_LIMITED',
    });
  });

  it('refuses first startup without explicit bootstrap credentials', async () => {
    const connection = new DatabaseConnection(':memory:');
    connections.push(connection);
    const config = await testConfig({
      adminBootstrapUsername: null,
      adminBootstrapPasswordFile: null,
    });
    const service = new AdminAuthService(new AdminRepository(connection.database), config);
    await expect(service.initialize()).rejects.toThrow('缺少管理员引导凭据');
  });
});

async function setup(): Promise<AdminAuthService> {
  const connection = new DatabaseConnection(':memory:');
  connections.push(connection);
  const service = new AdminAuthService(
    new AdminRepository(connection.database),
    await testConfig(),
  );
  await service.initialize();
  return service;
}
