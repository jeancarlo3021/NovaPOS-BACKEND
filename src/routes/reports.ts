import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const reports = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

reports.get('/sales', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    let query = db.from('invoices')
      .select('id, total, subtotal, tax_amount, discount_amount, payment_method, issued_at, status')
      .eq('tenant_id', tenantId).neq('status', 'cancelled')
      .order('issued_at', { ascending: false });
    if (from) query = query.gte('issued_at', from);
    if (to)   query = query.lte('issued_at', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const totalRevenue = data?.reduce((s, r) => s + Number(r.total ?? 0), 0) ?? 0;
    const totalCount   = data?.length ?? 0;
    const byMethod: Record<string, number> = {};
    data?.forEach(r => { const m = r.payment_method ?? 'cash'; byMethod[m] = (byMethod[m] ?? 0) + Number(r.total ?? 0); });

    return ok(c, { total_revenue: totalRevenue, total_invoices: totalCount,
      average_ticket: totalCount > 0 ? totalRevenue / totalCount : 0,
      by_payment_method: byMethod, invoices: data });
  } catch (err: any) { return fail(c, err.message, 500); }
});

reports.get('/expenses', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    let query = db.from('expenses').select('id, amount, category_id, date, description, payment_method, type')
      .eq('tenant_id', tenantId);
    if (from) query = query.gte('date', from);
    if (to)   query = query.lte('date', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const total = data?.reduce((s, r) => s + Number(r.amount ?? 0), 0) ?? 0;
    return ok(c, { total_expenses: total, count: data?.length ?? 0, expenses: data });
  } catch (err: any) { return fail(c, err.message, 500); }
});

reports.get('/stock', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('products')
      .select('id, name, sku, stock_quantity, min_stock_level, cost_price, unit_price, category_id, unit_type_id')
      .eq('tenant_id', tenantId).order('stock_quantity', { ascending: true });
    if (error) throw new Error(error.message);

    const lowStock   = data?.filter(p => (p.stock_quantity ?? 0) <= (p.min_stock_level ?? 0));
    const outOfStock = data?.filter(p => (p.stock_quantity ?? 0) === 0);

    return ok(c, { products: data, low_stock_count: lowStock?.length ?? 0,
      out_of_stock_count: outOfStock?.length ?? 0, low_stock_products: lowStock });
  } catch (err: any) { return fail(c, err.message, 500); }
});

reports.get('/profit', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    let salesQ = db.from('invoices').select('total').eq('tenant_id', tenantId).neq('status', 'cancelled');
    if (from) salesQ = salesQ.gte('issued_at', from);
    if (to)   salesQ = salesQ.lte('issued_at', to);

    let expQ = db.from('expenses').select('amount').eq('tenant_id', tenantId);
    if (from) expQ = expQ.gte('date', from);
    if (to)   expQ = expQ.lte('date', to);

    const [{ data: sales, error: sErr }, { data: exps, error: eErr }] = await Promise.all([salesQ, expQ]);
    if (sErr) throw new Error(sErr.message);
    if (eErr) throw new Error(eErr.message);

    const revenue  = sales?.reduce((s, r) => s + Number(r.total ?? 0), 0) ?? 0;
    const expenses = exps?.reduce((s, r) => s + Number(r.amount ?? 0), 0) ?? 0;
    const profit   = revenue - expenses;

    return ok(c, { total_revenue: revenue, total_expenses: expenses, profit,
      profit_margin: revenue > 0 ? (profit / revenue) * 100 : 0 });
  } catch (err: any) { return fail(c, err.message, 500); }
});

reports.get('/cash-sessions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = c.req.query('to');

    let query = db.from('cash_sessions').select('*').eq('tenant_id', tenantId)
      .order('opening_date', { ascending: false });
    if (from) query = query.gte('opening_date', from);
    if (to)   query = query.lte('opening_date', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default reports;
