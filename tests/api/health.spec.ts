import { test, expect } from '@playwright/test';

/**
 * Tests del endpoint /health — el más simple. Si esto falla, el backend
 * directamente no arranca. Útil como smoke test en CI.
 */

test.describe('GET /health', () => {
  test('responde 200 con shape esperada', async ({ request }) => {
    const r = await request.get('/health');
    expect(r.ok()).toBeTruthy();
    expect(r.status()).toBe(200);

    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe('string');
    expect(body.env).toBeDefined();
  });

  test('env vars críticas están seteadas', async ({ request }) => {
    const r = await request.get('/health');
    const body = await r.json();
    expect(body.env.supabase_url).toBe(true);   // SUPABASE_URL existe
    expect(body.env.service_key).toBe(true);    // SUPABASE_SERVICE_ROLE_KEY existe
  });

  test('endpoint no requiere auth', async ({ request }) => {
    // Aunque mandes un token inválido, /health devuelve 200 (es público)
    const r = await request.get('/health', {
      headers: { Authorization: 'Bearer invalid' },
    });
    expect(r.status()).toBe(200);
  });
});

test.describe('CORS headers', () => {
  test('responde con CORS headers para Origin del frontend', async ({ request }) => {
    const r = await request.fetch('/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Content-Type, Authorization',
      },
    });
    // Pre-flight debería responder 204 o 200
    expect([200, 204]).toContain(r.status());
    const allowOrigin = r.headers()['access-control-allow-origin'];
    expect(allowOrigin).toBeTruthy();
  });
});
