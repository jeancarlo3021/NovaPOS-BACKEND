import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { auth } from './middleware/auth.js';
import { enforceActiveTenant } from './middleware/tenantStatus.js';
import authRoutes      from './routes/auth.js';
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
import modifiers       from './routes/modifiers.js';
import tenantGroups    from './routes/tenantGroups.js';
import stockAdjustments from './routes/stockAdjustments.js';
import hr              from './routes/hr.js';
import email           from './routes/email.js';

// basePath('/api') matches Vercel's catch-all at api/[[...route]].ts
const app = new Hono().basePath('/api');

app.use('*', logger());
app.use('*', cors({
  origin: process.env.FRONTEND_URL?.split(',') ?? '*',
  allowHeaders: ['Content-Type', 'Authorization', 'x-branch-id'],
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
  },
}));

// Auth routes — no auth required
app.route('/auth', authRoutes);

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
api.route('/modifiers',        modifiers);
api.route('/settings',         settings);
api.route('/admin',            admin);
api.route('/tenant-groups',    tenantGroups);
api.route('/stock-adjustments', stockAdjustments);
api.route('/hr',                hr);
api.route('/email',             email);

app.route('/', api);

export default app;
