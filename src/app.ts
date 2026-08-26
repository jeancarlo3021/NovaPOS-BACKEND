import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { auth } from './middleware/auth.js';
import { enforceActiveTenant } from './middleware/tenantStatus.js';
import authRoutes      from './routes/auth.js';
import webhooks        from './routes/webhooks.js';
import cron            from './routes/cron.js';
import feExternal      from './routes/feExternal.js';
import products        from './routes/products.js';
import categories      from './routes/categories.js';
import unitTypes       from './routes/unitTypes.js';
import suppliers       from './routes/suppliers.js';
import purchases       from './routes/purchases.js';
import invoices        from './routes/invoices.js';
import expenses        from './routes/expenses.js';
import promotions      from './routes/promotions.js';
import cashSessions    from './routes/cashSessions.js';
import accountsPayable from './routes/accountsPayable.js';
import accountsReceivable from './routes/accountsReceivable.js';
import reports         from './routes/reports.js';
import users           from './routes/users.js';
import activity        from './routes/activity.js';
import teams           from './routes/teams.js';
import shifts          from './routes/shifts.js';
import plans           from './routes/plans.js';
import tenants         from './routes/tenants.js';
import hacienda        from './routes/hacienda.js';
import settings        from './routes/settings.js';
import admin           from './routes/admin.js';
import branches        from './routes/branches.js';
import warehouses      from './routes/warehouses.js';
import transfers       from './routes/transfers.js';
import customers       from './routes/customers.js';
import proformas       from './routes/proformas.js';
import modifiers       from './routes/modifiers.js';
import tenantGroups    from './routes/tenantGroups.js';
import stockAdjustments from './routes/stockAdjustments.js';
import hr              from './routes/hr.js';
import email           from './routes/email.js';
import customerPrices   from './routes/customerPrices.js';
import routing          from './routes/routing.js';
import cabys            from './routes/cabys.js';
import taxWithholdings  from './routes/taxWithholdings.js';
import recipesRoute     from './routes/recipes.js';
import productKitsRoute from './routes/productKits.js';
import agendaTasksRoute from './routes/agendaTasks.js';
import warrantiesRoute  from './routes/warranties.js';
import leadsRoute       from './routes/leads.js';
import demoRequestsRoute from './routes/demoRequests.js';
import { digitalMenu, publicMenu } from './routes/digitalMenu.js';
import windowOrders     from './routes/windowOrders.js';
import exchangeRate     from './routes/exchangeRate.js';
import tableOrders      from './routes/tableOrders.js';
import salesAgents      from './routes/salesAgents.js';
import agentOrders      from './routes/agentOrders.js';
import returnsRoute     from './routes/returns.js';
import accountant       from './routes/accountant.js';

// basePath('/api') matches Vercel's catch-all at api/[[...route]].ts
const app = new Hono().basePath('/api');

app.use('*', logger());
// Orígenes permitidos: los de FRONTEND_URL (normalizados sin '/' final) + cualquier
// localhost/127.0.0.1 (desarrollo). Sin esto, un frontend local recibía "NetworkError"
// porque el navegador aprueba el OPTIONS pero bloquea el request real por CORS.
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL?.split(',') ?? [])
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin;                      // curl / server-to-server: sin restricción
    const clean = origin.replace(/\/+$/, '');
    if (ALLOWED_ORIGINS.includes(clean)) return origin;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean)) return origin;  // dev local
    return ALLOWED_ORIGINS[0] ?? '';                 // no permitido
  },
  allowHeaders: ['Content-Type', 'Authorization', 'x-branch-id', 'x-terminal'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Health check — no auth, no Supabase, responds immediately
app.get('/health', (c) => c.json({
  ok: true,
  ts: new Date().toISOString(),
  env: {
    supabase_url:  !!process.env.SUPABASE_URL,
    service_key:   !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    anon_key:      !!process.env.SUPABASE_ANON_KEY,
    frontend_url:  process.env.FRONTEND_URL ?? '(not set)',
    // Diagnóstico de recepción por correo: ¿están cargadas las variables?
    cron_secret:   !!process.env.CRON_SECRET,
    imap_host:     !!process.env.IMAP_HOST,
    imap_user:     !!process.env.IMAP_USER,
    imap_pass:     !!process.env.IMAP_PASS,
    // Tokens de Alanube por ambiente (para diagnosticar "Company not found").
    alanube_token_production: !!process.env.ALANUBE_API_TOKEN_PRODUCTION,
    alanube_token_sandbox:    !!process.env.ALANUBE_API_TOKEN_SANDBOX,
    // Pasarela de FE externa (/fe-external, ej. JKM). Se reportan por separado:
    // la SERVICE key es la que valida los tokens de sesión propios, la anon solo
    // sirve para el modo Supabase Auth. Juntarlas escondía cuál faltaba.
    fe_external_url:         !!process.env.FE_EXTERNAL_SUPABASE_URL,
    fe_external_service_key: !!process.env.FE_EXTERNAL_SUPABASE_SERVICE_KEY,
    fe_external_anon_key:    !!process.env.FE_EXTERNAL_SUPABASE_ANON_KEY,
    // Correo (Resend) — para diagnosticar "no llega el correo".
    resend_api_key: !!process.env.RESEND_API_KEY,
    email_from:     process.env.EMAIL_FROM ?? '(default onboarding@resend.dev)',
  },
}));

// Auth routes — no auth required
app.route('/auth', authRoutes);

// Webhooks entrantes (Alanube) — públicos, validados por secreto propio
app.route('/webhooks', webhooks);

// Cron externo (cron-job.org) — público, protegido por CRON_SECRET
app.route('/cron', cron);

// Pasarela de FE para apps EXTERNAS (ej. JKM, que corre sobre su propio proyecto
// de Supabase). NO usa el auth de NovaPOS: valida el JWT del proyecto Supabase de
// la app externa y es completamente SIN ESTADO (no toca la base de NovaPOS).
// Ver routes/feExternal.ts.
app.route('/fe-external', feExternal);

// Menú digital PÚBLICO — lo abre el cliente escaneando el QR de la mesa, sin
// sesión. Va acá arriba, fuera del grupo con `auth`, porque justamente su razón
// de ser es que no haga falta iniciar sesión para verlo.
app.route('/public-menu', publicMenu);

const api = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();
api.use('*', auth);
api.use('*', enforceActiveTenant);
api.route('/products',         products);
api.route('/categories',       categories);
api.route('/unit-types',       unitTypes);
api.route('/suppliers',        suppliers);
api.route('/purchases',        purchases);
api.route('/invoices',         invoices);
api.route('/expenses',         expenses);
api.route('/promotions',       promotions);
api.route('/cash-sessions',    cashSessions);
api.route('/accounts-payable', accountsPayable);
api.route('/accounts-receivable', accountsReceivable);
api.route('/reports',          reports);
api.route('/users',            users);
api.route('/activity',         activity);
api.route('/teams',            teams);
api.route('/shifts',           shifts);
api.route('/plans',            plans);
api.route('/tenants',          tenants);
api.route('/hacienda',         hacienda);
api.route('/branches',         branches);
api.route('/warehouses',       warehouses);
api.route('/transfers',        transfers);
api.route('/customers',        customers);
api.route('/proformas',        proformas);
api.route('/modifiers',        modifiers);
api.route('/settings',         settings);
api.route('/admin',            admin);
api.route('/tenant-groups',    tenantGroups);
api.route('/stock-adjustments', stockAdjustments);
api.route('/hr',                hr);
api.route('/email',             email);
api.route('/customer-prices',   customerPrices);
api.route('/routes',            routing);
api.route('/cabys',             cabys);
api.route('/exchange-rate',     exchangeRate);
api.route('/tax-withholdings',  taxWithholdings);
api.route('/recipes',           recipesRoute);
api.route('/product-kits',       productKitsRoute);
api.route('/agenda-tasks',       agendaTasksRoute);
api.route('/warranties',         warrantiesRoute);
api.route('/leads',              leadsRoute);
api.route('/demo-requests',      demoRequestsRoute);
api.route('/digital-menu',      digitalMenu);
api.route('/window-orders',     windowOrders);
api.route('/table-orders',       tableOrders);
api.route('/sales-agents',       salesAgents);
api.route('/agent-orders',       agentOrders);
api.route('/returns',            returnsRoute);
api.route('/accountant',         accountant);

app.route('/', api);

export default app;
