import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app.js';
import { BOOTSTRAP_PASSWORD, testConfig } from '../helpers.js';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('public API shell', () => {
  it('exposes health and readiness after all parsers are registered', async () => {
    app = await createApp({ config: await testConfig() });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
    const platforms = await app.inject({ method: 'GET', url: '/api/platforms' });
    expect(platforms.statusCode).toBe(200);
    expect(platforms.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(31);
    expect(platforms.body).not.toContain('credentials');
  });

  it('requires a bearer API key for parsing', async () => {
    app = await createApp({ config: await testConfig() });
    const response = await app.inject({
      method: 'POST', url: '/api/parse', payload: { text: 'https://www.douyin.com/video/1' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ succ: false, error_code: 'UNAUTHORIZED' });
  });

  it('keeps stable validation envelopes after API-key authentication', async () => {
    app = await createApp({ config: await testConfig() });
    const apiKey = await createAuthorizedApiKey(app);
    const authorization = `Bearer ${apiKey}`;
    const cases = [
      {
        request: {
          payload: 'text',
          headers: { authorization, 'content-type': 'text/plain' },
        },
        errorCode: 'INVALID_REQUEST',
      },
      {
        request: {
          payload: [],
          headers: { authorization, 'content-type': 'application/json' },
        },
        errorCode: 'INVALID_REQUEST',
      },
      {
        request: {
          payload: { text: ' ' },
          headers: { authorization, 'content-type': 'application/json' },
        },
        errorCode: 'INVALID_TEXT',
      },
      {
        request: {
          payload: { text: 'x'.repeat(2001) },
          headers: { authorization, 'content-type': 'application/json' },
        },
        errorCode: 'TEXT_TOO_LONG',
      },
    ] as const;
    for (const item of cases) {
      const response = await app.inject({
        method: 'POST', url: '/api/parse', ...item.request,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ succ: false, error_code: item.errorCode });
    }
  });

  it('keeps the anonymous web API key on the server and accepts text-only requests', async () => {
    const config = await testConfig();
    app = await createApp({ config });
    const before = await app.inject({ method: 'GET', url: '/web-api/status' });
    expect(before.json()).toMatchObject({ status: 'not_ready', ready: false });
    expect(before.body).not.toContain('api_key');

    config.publicWebApiKey = await createAuthorizedApiKey(app);
    const ready = await app.inject({ method: 'GET', url: '/web-api/status' });
    expect(ready.json()).toMatchObject({ status: 'ok', ready: true });
    expect(ready.body).not.toContain(config.publicWebApiKey);

    const response = await app.inject({
      method: 'POST',
      url: '/web-api/parse',
      payload: { text: '这段内容里没有分享链接' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ succ: boolean; error_code: string; request_id: string }>();
    expect(body).toMatchObject({
      succ: false,
      error_code: 'URL_NOT_FOUND',
    });
    expect(typeof body.request_id).toBe('string');
  });
});

async function createAuthorizedApiKey(instance: FastifyInstance): Promise<string> {
  const login = await instance.inject({
    method: 'POST', url: '/api/admin/v1/auth/login',
    payload: { username: 'admin', password: BOOTSTRAP_PASSWORD },
  });
  const initialToken = login.json<{ data: { access_token: string } }>().data.access_token;
  const changed = await instance.inject({
    method: 'PUT', url: '/api/admin/v1/auth/password',
    headers: { authorization: `Bearer ${initialToken}` },
    payload: { current_password: BOOTSTRAP_PASSWORD, new_password: 'replacement-password-456' },
  });
  const token = changed.json<{ data: { access_token: string } }>().data.access_token;
  const client = await instance.inject({
    method: 'POST', url: '/api/admin/v1/clients',
    headers: { authorization: `Bearer ${token}` }, payload: { name: 'public-api-test' },
  });
  const clientId = client.json<{ data: { id: string } }>().data.id;
  const key = await instance.inject({
    method: 'POST', url: `/api/admin/v1/clients/${clientId}/keys`,
    headers: { authorization: `Bearer ${token}` }, payload: { name: 'test-key' },
  });
  return key.json<{ data: { api_key: string } }>().data.api_key;
}
