import { defineConfig } from '@playwright/test';

/**
 * Config Playwright para tests de API HTTP del BACKEND Hono.
 *
 * Usa el `request` fixture de Playwright (no Chromium real), así corre
 * rápido y sin GUI. Levanta el backend con `npm run dev` antes de testear.
 *
 * Comandos:
 *   npm run test:api           → corre los tests
 *   npm run test:api:ui        → modo interactivo
 *   npm run test:api:install   → primera vez (Playwright no necesita browser
 *                                pero igual instala dependencias del sistema)
 *
 * Variables env opcionales:
 *   API_BASE_URL  → URL del backend (default http://localhost:3001)
 *   AUTH_TOKEN    → Bearer token de Supabase para tests autenticados.
 *                   Si no se pasa, los tests que necesiten auth se skipean.
 */
export default defineConfig({
  testDir: './tests/api',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  timeout: 15_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: process.env.API_BASE_URL || 'http://localhost:3001',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  },

  // Levanta el backend antes (si no está ya corriendo).
  // Si preferís correr el server vos mismo en otra terminal, comentá este
  // bloque y los tests apuntan a baseURL directamente (más rápido y debugeable).
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3001/health',  // 127.0.0.1 explícito evita problemas IPv6
    reuseExistingServer: true,             // si ya hay un dev server, lo reutiliza
    timeout: 90_000,                       // tsx watch + supabase init puede tardar
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
