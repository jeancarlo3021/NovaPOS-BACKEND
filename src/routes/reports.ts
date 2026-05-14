import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const reports = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// GET /sales — aggregated sales from invoices (?from=, ?to=)
reports.get('/sales', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');

    let query = db
      .from('invoices')
      .select('id, total_amount, subtotal, tax_amount, discount, payment_method, created_at, status')
      .eq('tenant_id', tenantId)
      .neq('status', 'voided')
      .order('created_at', { ascending: false });

    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const totalRevenue = data?.reduce((sum, inv) => sum + (inv.total_amount ?? 0), 0) ?? 0;
    const totalCount = data?.length ?? 0;
    const avgTicket = totalCount > 0 ? totalRevenue / totalCount : 0;

    // Group by payment method
    const byPaymentMethod: Record<string, number> = {};
    data?.forEach((inv) => {
      const method = inv.payment_method ?? 'cash';
      byPaymentMethod[method] = (byPaymentMethod[method] ?? 0) + (inv.total_amount ?? 0);
    });

    return ok(c, {
      total_revenue: totalRevenue,
      total_invoices: totalCount,
      average_ticket: avgTicket,
      by_payment_method: byPaymentMethod,
      invoices: data,
    });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /expenses — aggregated expenses (?from=, ?to=)
reports.get('/expenses', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');

    let query = db
      .from('expenses')
      .select('id, amount, category, date, description')
      .eq('tenant_id', tenantId)
      .order('date', { ascending: false });

    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const totalExpenses = data?.reduce((sum, e) => sum + (e.amount ?? 0), 0) ?? 0;

    // Group by category
    const byCategory: Record<string, number> = {};
    data?.forEach((e) => {
      const cat = e.category ?? 'Other';
      byCategory[cat] = (byCategory[cat] ?? 0) + (e.amount ?? 0);
    });

    return ok(c, {
      total_expenses: totalExpenses,
      total_count: data?.length ?? 0,
      by_category: byCategory,
      expenses: data,
    });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /stock — products with stock levels
reports.get('/stock', async (c) => {
  try {
    const tenantId = c.get('tenantId');

    const { data, error } = await db
      .from('products')
      .select('id, name, stock, min_stock, cost, price, categories(name), unit_types(name)')
      .eq('tenant_id', tenantId)
      .order('stock', { ascending: true });

    if (error) throw new Error(error.message);

    const lowStock = data?.filter(
      (p) => p.min_stock != null && (p.stock ?? 0) <= (p.min_stock ?? 0)
    );
    const outOfStock = data?.filter((p) => (p.stock ?? 0) === 0);

    return ok(c, {
      products: data,
      low_stock_count: lowStock?.length ?? 0,
      out_of_stock_count: outOfStock?.length ?? 0,
      low_stock_products: lowStock,
    });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /profit — sales minus expenses (?from=, ?to=)
reports.get('/profit', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');

    // Sales
    let salesQuery = db
      .from('invoices')
      .select('total_amount')
      .eq('tenant_id', tenantId)
      .neq('status', 'voided');

    if (from) salesQuery = salesQuery.gte('created_at', from);
    if (to) salesQuery = salesQuery.lte('created_at', to);

    const { data: salesData, error: salesError } = await salesQuery;
    if (salesError) throw new Error(salesError.message);

    // Expenses
    let expQuery = db
      .from('expenses')
      .select('amount')
      .eq('tenant_id', tenantId);

    if (from) expQuery = expQuery.gte('date', from);
    if (to) expQuery = expQuery.lte('date', to);

    const { data: expData, error: expError } = await expQuery;
    if (expError) throw new Error(expError.message);

    const totalRevenue = salesData?.reduce((sum, inv) => sum + (inv.total_amount ?? 0), 0) ?? 0;
    const totalExpenses = expData?.reduce((sum, e) => sum + (e.amount ?? 0), 0) ?? 0;
    const profit = totalRevenue - totalExpenses;

    return ok(c, {
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      profit,
      profit_margin: totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0,
    });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /cash-sessions — list sessions with totals (?from=, ?to=)
reports.get('/cash-sessions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to = c.req.query('to');

    let query = db
      .from('cash_sessions')
      .select('*, users(full_name, email)')
      .eq('tenant_id', tenantId)
      .order('opened_at', { ascending: false });

    if (from) query = query.gte('opened_at', from);
    if (to) query = query.lte('opened_at', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

export default reports;
