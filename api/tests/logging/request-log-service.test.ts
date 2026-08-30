import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyService } from '../../src/auth/api-key-service.js';
import { DatabaseConnection } from '../../src/database/connection.js';
import { ApiClientRepository } from '../../src/database/repositories/api-client-repository.js';
import { LogRepository } from '../../src/database/repositories/log-repository.js';
import { AuditLogService } from '../../src/logging/audit-log-service.js';
import { RequestLogService } from '../../src/logging/request-log-service.js';
import { testConfig } from '../helpers.js';

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

describe('queryable request and audit logs', () => {
  it('persists full authorized input/response but keeps list rows compact', async () => {
    const { connection, logRepository, service, clientId, keyId } = await setup();
    const id = service.createPending({
      requestId: 'request-1', clientId, apiKeyId: keyId,
      inputText: 'complete sharing text', shareUrl: 'https://www.douyin.com/video/1',
      requestIp: '192.0.2.1', userAgent: 'fixture-agent',
    });
    service.complete('request-1', {
      realUrl: 'https://www.douyin.com/video/1', platformId: 'douyin', state: 'completed',
      httpStatus: 400, retcode: 400, success: false, errorCode: 'MEDIA_NOT_FOUND',
      responseJson: JSON.stringify({ succ: false, error_code: 'MEDIA_NOT_FOUND' }),
      durationMs: 25,
    });
    const detail = service.get(id);
    expect(detail?.input_text).toBe('complete sharing text');
    expect(detail?.response_json).toContain('MEDIA_NOT_FOUND');
    expect(service.list({ limit: 50 })[0]).not.toHaveProperty('input_text');
    expect(connection.database.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(logRepository.get(id)?.state).toBe('completed');
  });

  it('reports error categories and duration percentiles', async () => {
    const { service, clientId, keyId } = await setup();
    for (const [index, durationMs] of [10, 20, 30].entries()) {
      const requestId = `request-${index}`;
      service.createPending({
        requestId, clientId, apiKeyId: keyId, inputText: 'text',
        shareUrl: 'https://www.douyin.com/video/1', requestIp: '192.0.2.1', userAgent: '',
      });
      service.complete(requestId, {
        realUrl: null, platformId: 'douyin', state: 'completed', httpStatus: 400,
        retcode: 400, success: false, errorCode: 'MEDIA_NOT_FOUND', responseJson: '{}', durationMs,
      });
    }
    expect(service.stats({ limit: 50 }, null)).toMatchObject({
      errors: [{ error_code: 'MEDIA_NOT_FOUND', total: 3 }],
      percentiles: { p50: 20, p95: 30, p99: 30 },
    });
  });

  it('redacts secret-shaped audit metadata before SQLite persistence', async () => {
    const { connection, logRepository } = await setup();
    const config = await testConfig();
    new AuditLogService(logRepository, config).record({
      requestId: 'audit-1', adminId: null, action: 'test', entityType: 'test', entityId: null,
      outcome: 'success', requestIp: '192.0.2.1',
      metadata: { cookie: 'must-not-persist', nested: { api_key: 'must-not-persist' }, safe: 'kept' },
    });
    const row = connection.database.prepare(
      'SELECT metadata_json FROM admin_audit_logs WHERE request_id = ?',
    ).get('audit-1') as { metadata_json: string };
    expect(row.metadata_json).not.toContain('must-not-persist');
    expect(JSON.parse(row.metadata_json)).toEqual({
      cookie: '[REDACTED]', nested: { api_key: '[REDACTED]' }, safe: 'kept',
    });
  });
});

async function setup(): Promise<{
  connection: DatabaseConnection;
  logRepository: LogRepository;
  service: RequestLogService;
  clientId: string;
  keyId: string;
}> {
  const connection = new DatabaseConnection(':memory:');
  connections.push(connection);
  const clients = new ApiKeyService(new ApiClientRepository(connection.database), 20);
  const client = clients.createClient({ name: 'log-test' });
  const key = clients.createKey(client.id, { name: 'log-key' });
  if (!key) throw new Error('fixture key was not created');
  const logRepository = new LogRepository(connection.database);
  const service = new RequestLogService(logRepository, await testConfig());
  return { connection, logRepository, service, clientId: client.id, keyId: key.record.id };
}
