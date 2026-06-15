import { test, expect } from '@playwright/test';

/**
 * Tests del módulo de grupos de empresas.
 *
 * Tests "unauth" verifican que el middleware bloquea. Los tests con AUTH_TOKEN
 * validan flujos CRUD reales — necesitan ese env var con un JWT de Supabase
 * válido (lo podés sacar de la sesión actual del navegador: DevTools →
 * Application → Local Storage → buscá la key sb-...-auth-token y copiá
 * el access_token).
 */

const NEEDS_AUTH = !process.env.AUTH_TOKEN;

test.describe('Tenant groups — sin auth', () => {
  test('GET /api/tenant-groups sin token devuelve 401', async ({ request }) => {
    const r = await request.get('/api/tenant-groups');
    expect(r.status()).toBe(401);
  });

  test('POST /api/tenant-groups sin token devuelve 401', async ({ request }) => {
    const r = await request.post('/api/tenant-groups', {
      data: { name: 'Grupo Test' },
    });
    expect(r.status()).toBe(401);
  });
});

test.describe('Tenant groups — con auth', () => {
  test.skip(NEEDS_AUTH, 'Necesita AUTH_TOKEN env var');

  const authHeader = () => ({ Authorization: `Bearer ${process.env.AUTH_TOKEN}` });

  test('GET / lista grupos del user', async ({ request }) => {
    const r = await request.get('/api/tenant-groups', { headers: authHeader() });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('GET /?scope=all funciona para super-admin', async ({ request }) => {
    const r = await request.get('/api/tenant-groups?scope=all', { headers: authHeader() });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('GET /fe-plans/catalog devuelve catálogo de planes FE', async ({ request }) => {
    const r = await request.get('/api/tenant-groups/fe-plans/catalog', { headers: authHeader() });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.data)).toBeTruthy();
    // Catálogo seedeado en migration 13: al menos 4 planes
    if (body.data.length > 0) {
      const fp = body.data[0];
      expect(fp).toHaveProperty('id');
      expect(fp).toHaveProperty('code');
      expect(fp).toHaveProperty('name');
      expect(fp).toHaveProperty('monthly_quota');
      expect(fp).toHaveProperty('monthly_price');
    }
  });

  test('GET /my/tenants devuelve tenants accesibles', async ({ request }) => {
    const r = await request.get('/api/tenant-groups/my/tenants', { headers: authHeader() });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('POST / valida que el nombre tenga mínimo 2 chars', async ({ request }) => {
    const r = await request.post('/api/tenant-groups', {
      headers: authHeader(),
      data: { name: 'X' },     // muy corto
    });
    expect([422, 400]).toContain(r.status());
  });

  test('Ciclo completo: crear → leer → actualizar → eliminar', async ({ request }) => {
    const groupName = `E2E Test ${Date.now()}`;

    // 1. Crear
    const create = await request.post('/api/tenant-groups', {
      headers: authHeader(),
      data: {
        name: groupName,
        billing_email: 'e2e@test.com',
        notes: 'Creado por test E2E',
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = (await create.json()).data;
    expect(created.name).toBe(groupName);
    const id = created.id;

    try {
      // 2. Leer
      const read = await request.get(`/api/tenant-groups/${id}`, { headers: authHeader() });
      expect(read.ok()).toBeTruthy();
      const detail = (await read.json()).data;
      expect(detail.group.name).toBe(groupName);
      expect(Array.isArray(detail.members)).toBeTruthy();

      // 3. Update
      const upd = await request.patch(`/api/tenant-groups/${id}`, {
        headers: authHeader(),
        data: { notes: 'Notas actualizadas' },
      });
      expect(upd.ok()).toBeTruthy();
      const updated = (await upd.json()).data;
      expect(updated.notes).toBe('Notas actualizadas');

      // 4. Billing (debería ser 0 — sin sucursales)
      const bill = await request.get(`/api/tenant-groups/${id}/billing`, { headers: authHeader() });
      expect(bill.ok()).toBeTruthy();
      const billing = (await bill.json()).data;
      expect(billing.branches).toBe(0);
      expect(Number(billing.grand_total)).toBe(0);
    } finally {
      // 5. Eliminar (cleanup, siempre)
      const del = await request.delete(`/api/tenant-groups/${id}`, { headers: authHeader() });
      expect(del.ok()).toBeTruthy();

      // 6. Confirmar que ya no existe
      const gone = await request.get(`/api/tenant-groups/${id}`, { headers: authHeader() });
      expect([403, 404]).toContain(gone.status());
    }
  });
});
