# Tests de API con Playwright

Tests del **backend Hono** (endpoints REST). No usa Chromium — usa el `request`
fixture de Playwright directamente.

---

## Instalación (1 sola vez)

```bash
# Desde /home/jk/NovaPos-Backend/NovaPOS-BACKEND
npm install
```

> **NO necesita Chromium** — estos tests usan el fixture `request` (HTTP only),
> no abren browser. Por eso no hay `:install`.

## Correr los tests

```bash
# Headless
npm run test:api

# Interactivo
npm run test:api:ui

# Un archivo
npx playwright test tests/api/health.spec.ts

# Por nombre
npx playwright test --grep "responde 200"
```

## Estructura

| Archivo | Cubre |
|---|---|
| `health.spec.ts`        | `/health`, env vars cargadas, CORS preflight |
| `auth.spec.ts`          | middleware: rechazos 401, bypass para `/admin/*`, `/plans` |
| `plans.spec.ts`         | catálogo de planes SaaS, `/plans/current` |
| `tenant-groups.spec.ts` | CRUD de grupos multi-empresa, FE plans, billing |

## Tests autenticados (opcional)

Algunos tests requieren un JWT real de Supabase. Si no se provee, se **skipean
automáticamente** (no fallan). Para correrlos:

1. Loguéate en el frontend.
2. DevTools → Application → Local Storage → busca la key `sb-...-auth-token`.
3. Copiá el `access_token` (es el JWT que está dentro del JSON).
4. Exportá la variable y corré:

```bash
export AUTH_TOKEN="eyJhbGciOi..."
npm run test:api
```

⚠️ **NUNCA** comitear el token. Tiene 1h de vida útil — re-generálo si caduca.

## CI

```yaml
- name: Install
  working-directory: ./NovaPos-Backend/NovaPOS-BACKEND
  run: npm ci

- name: Install Playwright deps
  working-directory: ./NovaPos-Backend/NovaPOS-BACKEND
  run: npx playwright install --with-deps

- name: Run API tests
  working-directory: ./NovaPos-Backend/NovaPOS-BACKEND
  env:
    SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
    SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    AUTH_TOKEN: ${{ secrets.E2E_AUTH_TOKEN }}
  run: npm run test:api
```

## Cómo agregar un test

```typescript
import { test, expect } from '@playwright/test';

test.describe('Mi endpoint', () => {
  test('responde algo', async ({ request }) => {
    const r = await request.get('/api/mi-endpoint', {
      headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}` },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.data).toBeDefined();
  });
});
```

Tips:
- `request.get/post/put/patch/delete` — todos disponibles.
- `r.status()` para chequear códigos específicos.
- `r.headers()` para verificar Content-Type, CORS, etc.
- Usá `test.skip(condition, 'razón')` para skipear sin fallar.
