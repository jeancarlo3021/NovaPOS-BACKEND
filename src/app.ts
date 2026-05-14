import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { auth } from './middleware/auth.js';
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
import plans           from './routes/plans.js';
import tenants         from './routes/tenants.js';
import hacienda        from './routes/hacienda.js';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: process.env.FRONTEND_URL?.split(',') ?? '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Health check — no auth, no Supabase — responds immediately
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

const api = new Hono();
api.use('*', auth);
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
api.route('/plans',            plans);
api.route('/tenants',          tenants);
api.route('/hacienda',         hacienda);

app.route('/api', api);

export default app;
