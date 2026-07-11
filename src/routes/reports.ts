import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import { endOfDay } from '../utils/dateRange.js';

const reports = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

reports.get('/sales', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    let query = db.from('invoices')
      .select('id, invoice_number, customer_name, total, subtotal, tax_amount, discount_amount, payment_method, payments, currency, exchange_rate, issued_at, status')
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

    // Ventas cobradas en dólares (moneda de la venta = USD). Se reporta el total
    // en ₡ (moneda base) y el equivalente en $ según el tipo de cambio de cada venta.
    const usdRows = (data ?? []).filter((r: any) => r.currency === 'USD');
    const usd = {
      count: usdRows.length,
      total_crc: usdRows.reduce((s: number, r: any) => s + Number(r.total ?? 0), 0),
      total_usd: usdRows.reduce((s: number, r: any) => s + (Number(r.exchange_rate) > 0 ? Number(r.total ?? 0) / Number(r.exchange_rate) : 0), 0),
    };

    return ok(c, { total_revenue: totalRevenue, total_invoices: totalCount,
      average_ticket: totalCount > 0 ? totalRevenue / totalCount : 0,
      by_payment_method: byMethod, usd, invoices: data });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /taxes — reporte de impuestos (IVA débito fiscal) con CIERRE MENSUAL.
// Agrupa las ventas por mes: base (subtotal), IVA (tax_amount) y total. Sirve
// para la declaración de IVA y para "cerrar" cada mes.
reports.get('/taxes', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    const sel = 'id, invoice_number, customer_name, total, subtotal, tax_amount, issued_at, status, fe_clave, fe_nc_clave';
    // Dos consultas (más robusto que un .or con is-not-null):
    //  1) Ventas VÁLIDAS (no anuladas).
    //  2) Facturas con NOTA DE CRÉDITO (aunque estén anuladas).
    let qVentas = db.from('invoices').select(sel).eq('tenant_id', tenantId).neq('status', 'cancelled');
    let qNc     = db.from('invoices').select(sel).eq('tenant_id', tenantId).not('fe_nc_clave', 'is', null);
    if (from) { qVentas = qVentas.gte('issued_at', from); qNc = qNc.gte('issued_at', from); }
    if (to)   { qVentas = qVentas.lte('issued_at', to);   qNc = qNc.lte('issued_at', to); }
    const [rVentas, rNc] = await Promise.all([qVentas, qNc]);
    if (rVentas.error) throw new Error(rVentas.error.message);
    if (rNc.error)     throw new Error(rNc.error.message);

    // Ventas GROSS = válidas ∪ las que tienen NC (por id, sin duplicar). Toda venta
    // emitida cuenta como débito positivo; su NC (si tiene) resta aparte.
    const salesById = new Map<string, any>();
    for (const r of (rVentas.data ?? []) as any[]) salesById.set(r.id, r);
    for (const r of (rNc.data ?? []) as any[]) salesById.set(r.id, r);

    const invoices: Array<{ kind: 'venta' | 'nc'; invoice_number: string; customer_name: string; issued_at: string; month: string; base: number; iva: number; total: number; electronic: boolean }> = [];
    const mkRow = (r: any, kind: 'venta' | 'nc') => {
      const month = String(r.issued_at ?? '').slice(0, 7) || 'sin-fecha';
      const sales = Number(r.total ?? 0);
      const iva = Number(r.tax_amount ?? 0);
      const base = Number(r.subtotal ?? (sales - iva));
      const sign = kind === 'nc' ? -1 : 1;
      invoices.push({
        kind, invoice_number: r.invoice_number ?? '', customer_name: r.customer_name ?? '',
        issued_at: r.issued_at ?? '', month,
        base: base * sign, iva: iva * sign, total: sales * sign,
        electronic: kind === 'nc' ? true : !!r.fe_clave,
      });
    };
    for (const r of salesById.values()) mkRow(r, 'venta');
    for (const r of (rNc.data ?? []) as any[]) mkRow(r, 'nc');
    invoices.sort((a, b) => (a.issued_at || '').localeCompare(b.issued_at || ''));

    return ok(c, { invoices });
  } catch (err: any) { return fail(c, err.message, 500); }
});

reports.get('/expenses', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

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
      .select('id, name, sku, stock_quantity, min_stock_level, cost_price, unit_price, category_id, unit_type_id, tracks_stock')
      .eq('tenant_id', tenantId).order('stock_quantity', { ascending: true });
    if (error) throw new Error(error.message);

    // Excluir productos que NO manejan inventario (stock infinito): no deben
    // contar como "bajo" ni "crítico", y tampoco aparecer en la lista.
    const tracked = (data ?? []).filter(p => (p as any).tracks_stock !== false);

    const lowStock   = tracked.filter(p => (p.stock_quantity ?? 0) <= (p.min_stock_level ?? 0));
    const outOfStock = tracked.filter(p => (p.stock_quantity ?? 0) === 0);

    return ok(c, {
      products: data,
      low_stock_count: lowStock.length,
      out_of_stock_count: outOfStock.length,
      low_stock_products: lowStock,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

reports.get('/profit', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    let salesQ = db.from('invoices').select('total, payment_method').eq('tenant_id', tenantId).neq('status', 'cancelled');
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

    // Revenue by payment method
    const methodMap: Record<string, { label: string; total: number; color: string }> = {
      cash:     { label: 'Efectivo',       total: 0, color: '#10b981' },
      card:     { label: 'Tarjeta',        total: 0, color: '#3b82f6' },
      sinpe:    { label: 'SINPE',          total: 0, color: '#8b5cf6' },
      transfer: { label: 'Transferencia',  total: 0, color: '#f59e0b' },
      check:    { label: 'Cheque',         total: 0, color: '#6b7280' },
    };

    (sales ?? []).forEach((s: any) => {
      const method = s.payment_method ?? 'cash';
      if (methodMap[method]) {
        methodMap[method].total += Number(s.total ?? 0);
      }
    });

    const revenueByMethod = Object.entries(methodMap)
      .filter(([, v]) => v.total > 0)
      .map(([method, v]) => ({ method, ...v }));

    return ok(c, {
      total_revenue: revenue,
      total_expenses: expenses,
      profit,
      profit_margin: revenue > 0 ? (profit / revenue) * 100 : 0,
      revenueByMethod
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

reports.get('/cash-sessions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    let query = db.from('cash_sessions').select('*').eq('tenant_id', tenantId)
      .order('opening_date', { ascending: false });
    if (from) query = query.gte('opening_date', from);
    if (to)   query = query.lte('opening_date', to);

    const { data: sessions, error } = await query;
    if (error) throw new Error(error.message);

    // Get invoices for each session to calculate sales by method
    const sessionIds = (sessions ?? []).map((s: any) => s.id);
    const { data: invoices } = await db.from('invoices')
      .select('cash_session_id, payment_method, total')
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled')
      .in('cash_session_id', sessionIds.length > 0 ? sessionIds : ['null']);

    // Resolver el vendedor (dueño) de cada sesión.
    const userIds = [...new Set((sessions ?? []).map((s: any) => s.user_id).filter(Boolean))] as string[];
    const { data: users } = userIds.length > 0
      ? await db.from('users').select('id, full_name, email, ticket_alias').in('id', userIds)
      : { data: [] as any[] };
    const nameOf = (uid: string | null): string => {
      if (!uid) return 'Sin vendedor';
      const u = (users ?? []).find((x: any) => x.id === uid);
      // El alias de ticket (control interno) tiene prioridad sobre el nombre real.
      return (u?.ticket_alias) || (u?.full_name) || (u?.email ? String(u.email).split('@')[0] : '') || 'Vendedor';
    };

    const enriched = (sessions ?? []).map((s: any) => {
      const sessionInvoices = (invoices ?? []).filter((inv: any) => inv.cash_session_id === s.id);
      const salesByMethod: Record<string, number> = { cash: 0, card: 0, sinpe: 0, check: 0, transfer: 0 };
      let totalSales = 0;

      sessionInvoices.forEach((inv: any) => {
        const method = inv.payment_method ?? 'cash';
        if (salesByMethod.hasOwnProperty(method)) {
          salesByMethod[method] += Number(inv.total ?? 0);
        }
        totalSales += Number(inv.total ?? 0);
      });

      const expectedClosing = (s.opening_amount ?? 0) + salesByMethod.cash;
      const discrepancy = s.status === 'closed' && s.closing_amount !== null
        ? (s.closing_amount ?? 0) - expectedClosing
        : null;

      return {
        ...s,
        cashier_name: nameOf(s.user_id),
        sales_total: totalSales,
        cash_sales: salesByMethod.cash,
        card_sales: salesByMethod.card,
        sinpe_sales: salesByMethod.sinpe,
        invoice_count: sessionInvoices.length,
        expected_closing: expectedClosing,
        discrepancy,
        duration_min: s.closing_date && s.opening_date
          ? Math.round((new Date(s.closing_date).getTime() - new Date(s.opening_date).getTime()) / 60000)
          : null,
      };
    });

    return ok(c, enriched);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /sellers — sales by seller
reports.get('/sellers', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    let query = db.from('invoices')
      .select('id, total, cash_session_id, cashier_id, cashier_name, issued_at')
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled')
      .order('issued_at', { ascending: false });
    if (from) query = query.gte('issued_at', from);
    if (to)   query = query.lte('issued_at', to);

    const { data: invoices, error } = await query;
    if (error) throw new Error(error.message);

    // Atribución del vendedor: priorizamos el cajero real de la factura
    // (cashier_id, kiosk o login normal). Si no hay, caemos al dueño de la
    // sesión de caja (facturas viejas sin cashier_id).
    const sessionIds = [...new Set((invoices ?? []).map((inv: any) => inv.cash_session_id).filter(Boolean))];
    const { data: sessions } = sessionIds.length > 0
      ? await db.from('cash_sessions').select('id, user_id').in('id', sessionIds)
      : { data: [] as any[] };

    // Resolver el uid efectivo por factura
    const uidForInvoice = (inv: any): string | null => {
      if (inv.cashier_id) return inv.cashier_id;
      const session = (sessions ?? []).find((s: any) => s.id === inv.cash_session_id);
      return session?.user_id ?? null;
    };

    const allUids = [...new Set((invoices ?? []).map(uidForInvoice).filter(Boolean))] as string[];
    const { data: users } = allUids.length > 0
      ? await db.from('users').select('id, email, full_name, ticket_alias').in('id', allUids)
      : { data: [] as any[] };

    const sellerMap: Record<string, { totalRevenue: number; totalInvoices: number; name?: string }> = {};
    (invoices ?? []).forEach((inv: any) => {
      const uid = uidForInvoice(inv);
      if (!uid) return;
      if (!sellerMap[uid]) sellerMap[uid] = { totalRevenue: 0, totalInvoices: 0, name: inv.cashier_name ?? undefined };
      sellerMap[uid].totalRevenue += Number(inv.total ?? 0);
      sellerMap[uid].totalInvoices += 1;
    });

    const sellers = Object.entries(sellerMap).map(([uid, stats]) => {
      const user = (users ?? []).find((u: any) => u.id === uid);
      const emailName = user?.email ? String(user.email).split('@')[0] : '';
      return {
        userId: uid,
        name: (user as any)?.ticket_alias || (user as any)?.full_name || stats.name || emailName || 'Vendedor',
        email: user?.email ?? '',
        totalRevenue: stats.totalRevenue,
        totalInvoices: stats.totalInvoices,
        avgTicket: stats.totalInvoices > 0 ? stats.totalRevenue / stats.totalInvoices : 0,
      };
    }).sort((a, b) => b.totalRevenue - a.totalRevenue);

    return ok(c, sellers);
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /products/sales — products sold grouped by product
reports.get('/products/sales', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    const { data: invoices } = await db.from('invoices')
      .select('id, invoice_number, issued_at, customer_name, payment_method, total')
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled')
      .gte('issued_at', from || '1900-01-01')
      .lte('issued_at', to || '2099-12-31');

    const invoiceIds = (invoices ?? []).map((i: any) => i.id);

    const { data: items } = await db.from('invoice_items')
      .select('product_id, quantity, unit_price, subtotal')
      .in('invoice_id', invoiceIds.length > 0 ? invoiceIds : ['null']);

    const { data: products } = await db.from('products').select('id, name');

    const groupMap: Record<string, any> = {};
    (items ?? []).forEach((item: any) => {
      const inv = (invoices ?? []).find((i: any) => i.id === item.invoice_id);
      if (!groupMap[item.product_id]) {
        const product = (products ?? []).find((p: any) => p.id === item.product_id);
        groupMap[item.product_id] = {
          product_id: item.product_id,
          product_name: product?.name ?? 'Producto desconocido',
          total_qty: 0,
          total_revenue: 0,
          sales_count: 0,
          lines: [],
        };
      }
      groupMap[item.product_id].total_qty += item.quantity;
      groupMap[item.product_id].total_revenue += item.subtotal;
      if (inv) {
        groupMap[item.product_id].lines.push({
          invoice_number: inv.invoice_number,
          issued_at: inv.issued_at,
          customer_name: inv.customer_name,
          payment_method: inv.payment_method,
          quantity: item.quantity,
          unit_price: item.unit_price,
          subtotal: item.subtotal,
        });
      }
    });

    Object.values(groupMap).forEach((g: any) => {
      g.sales_count = g.lines.length;
    });

    return ok(c, Object.values(groupMap));
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /products/purchases — products purchased grouped by product
reports.get('/products/purchases', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    const { data: purchases } = await db.from('purchases')
      .select('id, purchase_number, purchase_date, supplier_id, status')
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled')
      .gte('purchase_date', from || '1900-01-01')
      .lte('purchase_date', to || '2099-12-31');

    const purchaseIds = (purchases ?? []).map((p: any) => p.id);
    const supplierIds = [...new Set((purchases ?? []).map((p: any) => p.supplier_id))];

    const { data: items } = await db.from('purchase_items')
      .select('product_id, purchase_id, quantity, unit_price, subtotal')
      .in('purchase_id', purchaseIds.length > 0 ? purchaseIds : ['null']);

    const { data: products } = await db.from('products').select('id, name');
    const { data: suppliers } = await db.from('suppliers').select('id, name').in('id', supplierIds);

    const groupMap: Record<string, any> = {};
    (items ?? []).forEach((item: any) => {
      const purch = (purchases ?? []).find((p: any) => p.id === item.purchase_id);
      if (!groupMap[item.product_id]) {
        const product = (products ?? []).find((p: any) => p.id === item.product_id);
        groupMap[item.product_id] = {
          product_id: item.product_id,
          product_name: product?.name ?? 'Producto desconocido',
          total_qty: 0,
          total_cost: 0,
          purchase_count: 0,
          lines: [],
        };
      }
      groupMap[item.product_id].total_qty += item.quantity;
      groupMap[item.product_id].total_cost += item.subtotal;
      if (purch) {
        const supplier = (suppliers ?? []).find((s: any) => s.id === purch.supplier_id);
        groupMap[item.product_id].lines.push({
          purchase_number: purch.purchase_number,
          purchase_date: purch.purchase_date,
          supplier_name: supplier?.name ?? 'Proveedor desconocido',
          status: purch.status,
          quantity: item.quantity,
          unit_price: item.unit_price,
          subtotal: item.subtotal,
        });
      }
    });

    Object.values(groupMap).forEach((g: any) => {
      g.purchase_count = g.lines.length;
    });

    return ok(c, Object.values(groupMap));
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default reports;
