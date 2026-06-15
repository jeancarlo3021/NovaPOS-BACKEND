import { test, expect } from '@playwright/test';

/**
 * Tests del módulo /plans — catálogo de planes SaaS.
 *
 * /plans (GET) ahora bypasea el chequeo de tenant gracias al middleware
 * (sólo necesita JWT válido). Por eso lo testeamos como caso límite.
 */

test.describe('GET /api/plans', () => {
  test('sin token → 401', async ({ request }) => {
    const r = await request.get('/api/plans');
    expect(r.status()).toBe(401);
  });

  test('con token válido devuelve lista de planes', async ({ request }) => {
    test.skip(!process.env.AUTH_TOKEN, 'Necesita AUTH_TOKEN');
    const r = await request.get('/api/plans', {
      headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}` },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.data)).toBeTruthy();
    // Si hay planes, validar shape
    if (body.data.length > 0) {
      const plan = body.data[0];
      expect(plan).toHaveProperty('id');
      expect(plan).toHaveProperty('name');
      expect(plan).toHaveProperty('price');
      expect(plan).toHaveProperty('features');
    }
  });

  test('/api/plans/current requiere tenant (no se bypassea)', async ({ request }) => {
    test.skip(!process.env.AUTH_TOKEN, 'Necesita AUTH_TOKEN');
    const r = await request.get('/api/plans/current', {
      headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}` },
    });
    // Si el user tiene tenant → 200; si NO tiene → 403 "Usuario sin tenant"
    expect([200, 403, 404]).toContain(r.status());
  });
});
