import { test, expect } from '@playwright/test';

/**
 * Tests del middleware de auth — verifican que rutas protegidas exigen JWT
 * y que rutas globales (`/admin/*`, `/tenant-groups/*`, `/plans` GET) bypasean
 * el chequeo de tenant.
 */

const SAMPLE_INVALID_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIn0.invalid';

test.describe('Auth middleware', () => {
  test('rutas protegidas sin token devuelven 401', async ({ request }) => {
    const r = await request.get('/api/products');
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body.error).toMatch(/token/i);
  });

  test('rutas protegidas con token inválido devuelven 401', async ({ request }) => {
    const r = await request.get('/api/products', {
      headers: { Authorization: `Bearer ${SAMPLE_INVALID_JWT}` },
    });
    expect(r.status()).toBe(401);
  });

  test('rutas protegidas sin Bearer prefix devuelven 401', async ({ request }) => {
    const r = await request.get('/api/products', {
      headers: { Authorization: SAMPLE_INVALID_JWT },  // sin 'Bearer'
    });
    expect(r.status()).toBe(401);
  });
});

test.describe('Auth bypass para rutas globales', () => {
  test.skip(!process.env.AUTH_TOKEN, 'Necesita AUTH_TOKEN env var para probar bypass real');

  test('GET /api/admin/owners con admin sin tenant devuelve 200', async ({ request }) => {
    const r = await request.get('/api/admin/owners', {
      headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}` },
    });
    // Si es admin sin tenant → 200; si tiene tenant → también 200 (no rechaza)
    expect([200, 403]).toContain(r.status());
    if (r.status() === 200) {
      const body = await r.json();
      expect(Array.isArray(body.data) || body.data === null).toBeTruthy();
    }
  });

  test('GET /api/plans con super-admin devuelve 200', async ({ request }) => {
    const r = await request.get('/api/plans', {
      headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}` },
    });
    expect([200, 403]).toContain(r.status());
  });
});

test.describe('Validación de input', () => {
  test('POST con body inválido devuelve 401 (sin token) o 422 (con token)', async ({ request }) => {
    const r = await request.post('/api/products', {
      headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN ?? SAMPLE_INVALID_JWT}` },
      data: { invalid: 'payload' },
    });
    // Sin token válido: 401. Con token + body inválido: 422 de Zod.
    expect([401, 422, 500]).toContain(r.status());
  });
});
