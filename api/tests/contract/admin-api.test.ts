import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app.js';
import { BOOTSTRAP_PASSWORD, testConfig } from '../helpers.js';

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('admin API', () => {
  it('requires bootstrap password change before client management', async () => {
    app = await createApp({ config: await testConfig() });
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/v1/auth/login',
      payload: { username: 'admin', password: BOOTSTRAP_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json<{ data: { access_token: string; must_change_password: boolean } }>();
    expect(loginBody.data.must_change_password).toBe(true);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/v1/clients',
      headers: { authorization: `Bearer ${loginBody.data.access_token}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const changed = await app.inject({
      method: 'PUT',
      url: '/api/admin/v1/auth/password',
      headers: { authorization: `Bearer ${loginBody.data.access_token}` },
      payload: { current_password: BOOTSTRAP_PASSWORD, new_password: 'replacement-password-456' },
    });
    expect(changed.statusCode).toBe(200);
    const changedBody = changed.json<{ data: { access_token: string } }>();

    const createdClient = await app.inject({
      method: 'POST',
      url: '/api/admin/v1/clients',
      headers: { authorization: `Bearer ${changedBody.data.access_token}` },
      payload: { name: 'contract-test' },
    });
    expect(createdClient.statusCode).toBe(201);
  });

  it('returns a full API key once and masks it afterward', async () => {
    app = await createApp({ config: await testConfig() });
    const login = await app.inject({
      method: 'POST', url: '/api/admin/v1/auth/login',
      payload: { username: 'admin', password: BOOTSTRAP_PASSWORD },
    });
    const initialToken = login.json<{ data: { access_token: string } }>().data.access_token;
    const changed = await app.inject({
      method: 'PUT', url: '/api/admin/v1/auth/password',
      headers: { authorization: `Bearer ${initialToken}` },
      payload: { current_password: BOOTSTRAP_PASSWORD, new_password: 'replacement-password-456' },
    });
    const token = changed.json<{ data: { access_token: string } }>().data.access_token;
    const client = await app.inject({
      method: 'POST', url: '/api/admin/v1/clients', headers: { authorization: `Bearer ${token}` },
      payload: { name: 'client' },
    });
    const clientId = client.json<{ data: { id: string } }>().data.id;
    const created = await app.inject({
      method: 'POST', url: `/api/admin/v1/clients/${clientId}/keys`,
      headers: { authorization: `Bearer ${token}` }, payload: { name: 'key' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ data: { api_key: string } }>().data.api_key).toMatch(/^mp_/u);
    const listed = await app.inject({
      method: 'GET', url: `/api/admin/v1/clients/${clientId}/keys`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.stringify(listed.json())).not.toContain('api_key');
    expect(JSON.stringify(listed.json())).not.toContain(created.json<{ data: { api_key: string } }>().data.api_key);
  });

  it('records controlled platform test failures and enforces cooldown', async () => {
    app = await createApp({ config: await testConfig() });
    const login = await app.inject({
      method: 'POST', url: '/api/admin/v1/auth/login',
      payload: { username: 'admin', password: BOOTSTRAP_PASSWORD },
    });
    const initialToken = login.json<{ data: { access_token: string } }>().data.access_token;
    const changed = await app.inject({
      method: 'PUT', url: '/api/admin/v1/auth/password',
      headers: { authorization: `Bearer ${initialToken}` },
      payload: { current_password: BOOTSTRAP_PASSWORD, new_password: 'replacement-password-456' },
    });
    const token = changed.json<{ data: { access_token: string } }>().data.access_token;
    const headers = { authorization: `Bearer ${token}` };
    const first = await app.inject({
      method: 'POST', url: '/api/admin/v1/platforms/acfun/test', headers,
      payload: { text: 'not a share URL' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ data: { success: boolean; error_category: string } }>().data)
      .toMatchObject({ success: false, error_category: 'url_not_found' });

    const second = await app.inject({
      method: 'POST', url: '/api/admin/v1/platforms/acfun/test', headers, payload: {},
    });
    expect(second.statusCode).toBe(429);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('PLATFORM_TEST_COOLDOWN');

    const platforms = await app.inject({
      method: 'GET', url: '/api/admin/v1/platforms', headers,
    });
    const acfun = platforms.json<{ data: { id: string; last_test: unknown }[] }>()
      .data.find((platform) => platform.id === 'acfun');
    expect(acfun?.last_test).not.toBeNull();
  });
});
