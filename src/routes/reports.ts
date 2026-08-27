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

// GET /delivery — ventas por DELIVERY agrupadas por SEMANA (lunes-domingo).
// Devuelve total vendido, comisión (%) y neto por semana, y el detalle.
reports.get('/delivery', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    let q = db.from('invoices')
      // fe_clave / fe_nc_clave: la pantalla necesita saber si la venta salió a
      // Hacienda para avisar que anularla emite una Nota de Crédito.
      .select('id, invoice_number, customer_name, total, subtotal, tax_amount, delivery_commission_pct, delivery_net, delivery_platform, issued_at, fe_clave, fe_nc_clave')
      .eq('tenant_id', tenantId).eq('is_delivery', true).neq('status', 'cancelled')
      .order('issued_at', { ascending: false }).limit(5000);
    if (from) q = q.gte('issued_at', from);
    if (to)   q = q.lte('issued_at', to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];

    // Comisiones configuradas en Ajustes → Delivery (fuente de verdad del %).
    const { data: dcfg } = await db.from('settings').select('config')
      .eq('tenant_id', tenantId).eq('type', 'delivery').maybeSingle();
    const dc: any = dcfg?.config ?? {};
    const settingsPct: Record<string, number> = {
      Uber: Number(dc.uber_pct ?? 0), Didi: Number(dc.didi_pct ?? 0),
      PedidosYa: Number(dc.pedidosya_pct ?? 0), Otro: Number(dc.otro_pct ?? 0),
    };
    // % de comisión de una factura: el guardado al vender; si no se capturó
    // (ventas viejas o sin plataforma en el modal), se toma el de Ajustes según
    // la plataforma. Así el reporte SIEMPRE refleja la comisión configurada.
    const pctOf = (r: any) => {
      const stored = Number(r.delivery_commission_pct ?? 0);
      if (stored > 0) return stored;
      const pl = (r.delivery_platform && String(r.delivery_platform).trim()) || '';
      return Number(settingsPct[pl] ?? 0);
    };

    // Lunes (YYYY-MM-DD) de la semana de una fecha.
    const weekMonday = (iso: string): string => {
      const d = new Date(iso);
      const day = (d.getDay() + 6) % 7;   // 0 = lunes
      d.setDate(d.getDate() - day);
      return d.toISOString().slice(0, 10);
    };

    // Recalcula comisión/neto por fila desde el % (no del delivery_net guardado,
    // que puede venir nulo) y deja los valores en la fila para el detalle del front.
    for (const r of rows) {
      const pct = pctOf(r);
      const commission = Math.round(Number(r.total ?? 0) * pct / 100);
      r.delivery_commission_pct = pct;
      r.delivery_net = Number(r.total ?? 0) - commission;
    }

    const netOf = (r: any) => Number(r.delivery_net ?? r.total ?? 0);
    // IVA de la factura; si no viniera, se deriva del total (total - base).
    const ivaOf = (r: any) => Number(r.tax_amount ?? Math.max(0, Number(r.total ?? 0) - Number(r.subtotal ?? 0)));
    const total = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
    const net = rows.reduce((s, r) => s + netOf(r), 0);
    const iva = rows.reduce((s, r) => s + ivaOf(r), 0);

    const acc = () => ({ count: 0, total: 0, net: 0, iva: 0 });
    const finalize = <T extends { total: number; net: number; iva: number }>(g: T) =>
      ({ ...g, commission: g.total - g.net, netNoIva: g.net - g.iva });

    const byWeek: Record<string, { week: string; count: number; total: number; net: number; iva: number }> = {};
    for (const r of rows) {
      const wk = weekMonday(r.issued_at ?? new Date().toISOString());
      if (!byWeek[wk]) byWeek[wk] = { week: wk, ...acc() };
      byWeek[wk].count++;
      byWeek[wk].total += Number(r.total ?? 0);
      byWeek[wk].net += netOf(r);
      byWeek[wk].iva += ivaOf(r);
    }
    const weeks = Object.values(byWeek)
      .map(finalize)
      .sort((a, b) => (a.week < b.week ? 1 : -1));

    // Desglose por PLATAFORMA (Uber, Didi, PedidosYa, Otro, o "Sin plataforma").
    const byPlatform: Record<string, { platform: string; count: number; total: number; net: number; iva: number }> = {};
    for (const r of rows) {
      const pl = (r.delivery_platform && String(r.delivery_platform).trim()) || 'Sin plataforma';
      if (!byPlatform[pl]) byPlatform[pl] = { platform: pl, ...acc() };
      byPlatform[pl].count++;
      byPlatform[pl].total += Number(r.total ?? 0);
      byPlatform[pl].net += netOf(r);
      byPlatform[pl].iva += ivaOf(r);
    }
    const platforms = Object.values(byPlatform)
      .map(finalize)
      .sort((a, b) => b.total - a.total);

    return ok(c, {
      count: rows.length, total, net, iva, commission: total - net, netNoIva: net - iva,
      weeks, platforms, invoices: rows,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /vouchers — comprobantes de PAGOS y ANULACIONES en un rango.
// Devuelve cada factura con su medio de pago, comprobante (voucher), moneda,
// clave FE, y si fue anulada (con su Nota de Crédito). El front lo separa en
// "Pagos" y "Anulaciones".
reports.get('/vouchers', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));

    let q = db.from('invoices')
      .select('id, invoice_number, customer_name, total, payment_method, payments, voucher_number, currency, exchange_rate, status, fe_clave, fe_nc_clave, cashier_name, issued_at, created_at')
      .eq('tenant_id', tenantId)
      .order('issued_at', { ascending: false }).limit(2000);
    if (from) q = q.gte('issued_at', from);
    if (to)   q = q.lte('issued_at', to);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];

    const voids = rows.filter(r => r.status === 'cancelled');
    const payments = rows.filter(r => r.status !== 'cancelled');

    const totalPagos = payments.reduce((s, r) => s + Number(r.total ?? 0), 0);
    const totalAnulado = voids.reduce((s, r) => s + Number(r.total ?? 0), 0);
    // Desglose de pagos por método (incluye splits de pago mixto).
    const byMethod: Record<string, number> = {};
    for (const r of payments) {
      const splits = Array.isArray(r.payments) && r.payments.length > 0
        ? r.payments : [{ method: r.payment_method ?? 'cash', amount: r.total }];
      for (const s of splits) byMethod[s.method ?? 'cash'] = (byMethod[s.method ?? 'cash'] ?? 0) + Number(s.amount ?? 0);
    }

    return ok(c, {
      payments, voids,
      summary: {
        payments_count: payments.length, payments_total: totalPagos,
        voids_count: voids.length, voids_total: totalAnulado,
        by_method: byMethod,
      },
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

// GET /taxes — reporte de impuestos (IVA débito fiscal) con CIERRE MENSUAL.
// Agrupa las ventas por mes: base (subtotal), IVA (tax_amount) y total. Sirve
// para la declaración de IVA y para "cerrar" cada mes.
// GET /taxes/breakdown — desglose de IVA POR TARIFA de cada comprobante (una fila
// por factura, columnas por tarifa). El IVA no se guarda en la factura: sale de la
// tarifa de cada producto, así que se reconstruye leyendo los ítems.
// Mismos filtros que /taxes: from, to, environment.
/**
 * Trae TODAS las filas de una consulta, por páginas.
 *
 * Supabase corta en 1000 filas por consulta, sin avisar y sin importar el
 * `.limit()` que uno ponga. En el reporte de IVA eso significaba que a un
 * negocio con más de mil facturas en el período le faltaban comprobantes en la
 * declaración — y el faltante no se veía por ningún lado.
 */
async function fetchAllRows<T = any>(
  make: (from: number, to: number) => any,
): Promise<{ data: T[]; error: any }> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) return { data: all, error };
    const chunk = (data ?? []) as T[];
    all.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return { data: all, error: null };
}

reports.get('/taxes/breakdown', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));
    const environment = String(c.req.query('environment') || 'production');

    // `customer_identification` puede no existir como columna: se pide y, si falla,
    // se reintenta sin ella (la cedula se resuelve desde el cliente).
    const build = (withIdent: boolean) => {
      let q = db.from('invoices')
        .select('id, invoice_number, customer_name, customer_id, subtotal, tax_amount, total, '
          + 'issued_at, status, document_type, fe_clave, fe_nc_clave, fe_nd_clave, fe_environment'
          + (withIdent ? ', customer_identification' : ''))
        .eq('tenant_id', tenantId);
      if (from) q = q.gte('issued_at', from);
      if (to)   q = q.lte('issued_at', to);
      if (environment === 'sandbox') q = q.eq('fe_environment', 'sandbox');
      else if (environment !== 'all') q = q.or('fe_environment.is.null,fe_environment.neq.sandbox');
      return q;
    };
    // Paginado: sin esto, pasadas las 1000 facturas el desglose salía cortado.
    let { data: invs, error } = await fetchAllRows((a, b) => build(true).range(a, b));
    if (error && /customer_identification/i.test(error.message)) {
      ({ data: invs, error } = await fetchAllRows((a, b) => build(false).range(a, b)));
    }
    if (error) throw new Error(error.message);
    const rows = (invs ?? []) as any[];
    if (rows.length === 0) return ok(c, { rows: [], rates: [0, 1, 2, 4, 13] });

    // Cedula del cliente (cuando la factura no la guarda).
    const custIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))];
    const cedByCustomer = new Map<string, string>();
    for (let i = 0; i < custIds.length; i += 200) {
      const { data } = await db.from('customers').select('id, identification').in('id', custIds.slice(i, i + 200) as string[]);
      for (const cu of (data ?? []) as any[]) if (cu.identification) cedByCustomer.set(cu.id, String(cu.identification));
    }

    const ids = rows.map(r => r.id);
    const items: any[] = [];
    // Las LÍNEAS también se paginan: 200 facturas pueden traer más de 1000
    // líneas, y ese corte silencioso dejaba comprobantes con la base incompleta
    // — el IVA por tarifa salía mal sin ninguna señal.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data } = await fetchAllRows((a, b) => db.from('invoice_items')
        .select('invoice_id, product_id, subtotal').in('invoice_id', chunk).range(a, b));
      items.push(...(data ?? []));
    }
    const pids = [...new Set(items.map(it => it.product_id).filter(Boolean))];
    const rateByProduct = new Map<string, number>();
    for (let i = 0; i < pids.length; i += 200) {
      const { data } = await db.from('products').select('id, iva_rate').in('id', pids.slice(i, i + 200) as string[]);
      for (const p of (data ?? []) as any[]) rateByProduct.set(p.id, Number(p.iva_rate ?? 13));
    }

    const acc = new Map<string, { base: Record<string, number>; iva: Record<string, number> }>();
    const seen = new Set<number>();
    for (const it of items) {
      const rate = it.product_id ? (rateByProduct.get(it.product_id) ?? 13) : 13;
      seen.add(rate);
      const a = acc.get(it.invoice_id) ?? { base: {}, iva: {} };
      const base = Number(it.subtotal ?? 0);
      a.base[rate] = (a.base[rate] ?? 0) + base;
      a.iva[rate]  = (a.iva[rate] ?? 0) + Math.round(base * (rate / 100) * 100) / 100;
      acc.set(it.invoice_id, a);
    }
    const rates = [...new Set([0, 1, 2, 4, 13, ...seen])].sort((a, b) => a - b);

    const out = rows.map(r => {
      const a = acc.get(r.id) ?? { base: {}, iva: {} };
      const row: Record<string, any> = {
        invoice_id: r.id,
        fecha: r.issued_at ?? '',
        tipo: r.document_type ?? '',
        numero: r.invoice_number ?? '',
        cliente: r.customer_name ?? '',
        cedula: r.customer_identification ?? (r.customer_id ? (cedByCustomer.get(r.customer_id) ?? '') : ''),
        clave: String(r.fe_clave ?? ''),
        anulada: r.status === 'cancelled' ? 'Sí' : 'No',
        tiene_nc: r.fe_nc_clave ? 'Sí' : 'No',
        tiene_nd: r.fe_nd_clave ? 'Sí' : 'No',
      };
      for (const rate of rates) {
        row[`base_${rate}`] = Math.round((a.base[rate] ?? 0) * 100) / 100;
        row[`iva_${rate}`]  = Math.round((a.iva[rate] ?? 0) * 100) / 100;
      }
      row.subtotal  = Number(r.subtotal ?? 0);
      row.iva_total = Number(r.tax_amount ?? 0);
      row.total     = Number(r.total ?? 0);
      return row;
    });
    return ok(c, { rows: out, rates });
  } catch (err: any) { return fail(c, err.message, 500); }
});

reports.get('/taxes', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const from = c.req.query('from');
    const to   = endOfDay(c.req.query('to'));
    // Ambiente: 'production' (default, excluye pruebas) · 'sandbox' (solo QA) · 'all'.
    const environment = String(c.req.query('environment') || 'production');

    const sel = 'id, invoice_number, customer_name, customer_id, total, subtotal, tax_amount, issued_at, status, document_type, fe_clave, fe_status, fe_nc_clave, fe_nd_clave, fe_environment';
    // Tres consultas (más robusto que un .or con is-not-null):
    //  1) Ventas VÁLIDAS (no anuladas).
    //  2) Facturas con NOTA DE CRÉDITO (aunque estén anuladas).
    //  3) Facturas con NOTA DE DÉBITO.
    // Cada consulta se ARMA de nuevo en cada página: un query builder de Supabase
    // es de un solo uso, y reutilizarlo entre páginas devuelve resultados raros.
    const baseQuery = (kind: 'ventas' | 'nc' | 'nd', selection: string) => {
      let q = db.from('invoices').select(selection).eq('tenant_id', tenantId);
      if (kind === 'ventas') q = q.neq('status', 'cancelled');
      if (kind === 'nc')     q = q.not('fe_nc_clave', 'is', null);
      if (kind === 'nd')     q = q.not('fe_nd_clave', 'is', null);
      if (from) q = q.gte('issued_at', from);
      if (to)   q = q.lte('issued_at', to);
      // Filtro por ambiente. 'production' incluye las filas SIN ambiente (ventas
      // corrientes y facturas históricas = reales). 'sandbox' solo las de prueba.
      if (environment === 'sandbox') q = q.eq('fe_environment', 'sandbox');
      else if (environment !== 'all') q = q.or('fe_environment.is.null,fe_environment.neq.sandbox');
      return q;
    };
    // Las tres consultas van PAGINADAS: con más de 1000 comprobantes en el
    // período, la declaración salía incompleta y nadie lo notaba.
    let [rVentas, rNc, rNd]: [any, any, any] = await Promise.all([
      fetchAllRows((a, b) => baseQuery('ventas', sel).range(a, b)),
      fetchAllRows((a, b) => baseQuery('nc', sel).range(a, b)),
      fetchAllRows((a, b) => baseQuery('nd', sel).range(a, b)),
    ]);
    // Si columnas nuevas aún no existen (migraciones sin correr), reintenta con el
    // set mínimo (muestra todo, sin ND ni ambiente).
    if ([rVentas, rNc, rNd].some(r => r.error && /fe_environment|fe_nd_clave|document_type/.test(r.error.message))) {
      const sel2 = 'id, invoice_number, customer_name, customer_id, total, subtotal, tax_amount, issued_at, status, fe_clave, fe_status, fe_nc_clave';
      const legacy = (kind: 'ventas' | 'nc') => {
        let q = db.from('invoices').select(sel2).eq('tenant_id', tenantId);
        if (kind === 'ventas') q = q.neq('status', 'cancelled');
        else q = q.not('fe_nc_clave', 'is', null);
        if (from) q = q.gte('issued_at', from);
        if (to)   q = q.lte('issued_at', to);
        return q;
      };
      [rVentas, rNc] = await Promise.all([
        fetchAllRows((a, b) => legacy('ventas').range(a, b)),
        fetchAllRows((a, b) => legacy('nc').range(a, b)),
      ]);
      rNd = { data: [], error: null };
    }
    if (rVentas.error) throw new Error(rVentas.error.message);
    if (rNc.error)     throw new Error(rNc.error.message);
    if (rNd.error)     rNd = { data: [], error: null };   // ND opcional

    // Una factura ELECTRÓNICA que Hacienda RECHAZÓ o dio ERROR no es un comprobante
    // válido → no debe aparecer en el reporte de impuestos. Las corrientes (sin
    // fe_clave) y las aceptadas/en proceso sí cuentan.
    const feFailed = (r: any) => !!r.fe_clave && (r.fe_status === 'rejected' || r.fe_status === 'error');

    // Ventas GROSS = válidas ∪ las que tienen NC (por id, sin duplicar). Toda venta
    // emitida cuenta como débito positivo; su NC (si tiene) resta aparte.
    const salesById = new Map<string, any>();
    for (const r of (rVentas.data ?? []) as any[]) { if (!feFailed(r)) salesById.set(r.id, r); }
    for (const r of (rNc.data ?? []) as any[]) { if (!feFailed(r)) salesById.set(r.id, r); }

    const invoices: Array<{ kind: 'venta' | 'nc' | 'nd'; document_type: string; invoice_number: string; customer_name: string; customer_id: string | null; customer_identification: string; issued_at: string; month: string; base: number; iva: number; total: number; electronic: boolean }> = [];
    const mkRow = (r: any, kind: 'venta' | 'nc' | 'nd') => {
      const month = String(r.issued_at ?? '').slice(0, 7) || 'sin-fecha';
      const sales = Number(r.total ?? 0);
      const iva = Number(r.tax_amount ?? 0);
      const base = Number(r.subtotal ?? (sales - iva));
      const sign = kind === 'nc' ? -1 : 1;   // NC resta; venta y ND suman
      // Tipo de documento para poder separar tiquete vs factura electrónica.
      const dt = kind === 'nc' ? 'nota_credito' : kind === 'nd' ? 'nota_debito'
        : (r.document_type || (r.fe_clave ? 'factura_electronica' : 'ticket'));
      invoices.push({
        kind, document_type: dt,
        invoice_number: r.invoice_number ?? '', customer_name: r.customer_name ?? '',
        customer_id: r.customer_id ?? null, customer_identification: '',
        issued_at: r.issued_at ?? '', month,
        base: base * sign, iva: iva * sign, total: sales * sign,
        electronic: kind === 'venta' ? !!r.fe_clave : true,
      });
    };
    for (const r of salesById.values()) mkRow(r, 'venta');
    for (const r of (rNc.data ?? []) as any[]) if (!feFailed(r)) mkRow(r, 'nc');
    for (const r of (rNd.data ?? []) as any[]) if (!feFailed(r)) mkRow(r, 'nd');
    invoices.sort((a, b) => (a.issued_at || '').localeCompare(b.issued_at || ''));

    // Cédula del cliente (identificación) — batch desde customers por customer_id.
    const custIds = [...new Set(invoices.map(i => i.customer_id).filter(Boolean))] as string[];
    if (custIds.length) {
      const { data: custs } = await db.from('customers').select('id, identification').in('id', custIds);
      const idMap = new Map<string, string>();
      for (const c2 of (custs ?? []) as any[]) idMap.set(c2.id, c2.identification ?? '');
      for (const inv of invoices) if (inv.customer_id) inv.customer_identification = idMap.get(inv.customer_id) ?? '';
    }

    // ── Compras (crédito fiscal): comprobantes electrónicos recibidos de proveedores.
    let purchases: Array<{ clave: string; issuer_name: string; issuer_id: string; document_type: string; doc_date: string; month: string; base: number; iva: number; total: number }> = [];
    try {
      let qp = db.from('received_documents')
        .select('clave, issuer_name, issuer_id, document_type, doc_date, total, tax')
        .eq('tenant_id', tenantId).neq('ack_status', 'rejected');
      if (from) qp = qp.gte('doc_date', from);
      if (to)   qp = qp.lte('doc_date', to);
      const rp: any = await qp;
      purchases = ((rp.data ?? []) as any[]).map(p => {
        // Una NOTA DE CRÉDITO del proveedor RESTA crédito fiscal: es plata que
        // se devolvió o un descuento posterior, así que el IVA soportado deja de
        // existir. Sumarla como una compra más —que es lo que se hacía— infla el
        // crédito y termina en una declaración con IVA de menos.
        //
        // El tipo va embebido en la clave (posiciones 30-31) y ya se guarda al
        // recibir el XML: 01 factura · 02 nota de débito · 03 nota de crédito.
        // La nota de DÉBITO suma, porque agrega monto a lo comprado.
        const sign = String(p.document_type ?? '') === '03' ? -1 : 1;
        const total = Number(p.total ?? 0) * sign;
        const iva = Number(p.tax ?? 0) * sign;
        return {
          clave: p.clave ?? '', issuer_name: p.issuer_name ?? '', issuer_id: p.issuer_id ?? '',
          document_type: p.document_type ?? '', doc_date: p.doc_date ?? '',
          month: String(p.doc_date ?? '').slice(0, 7) || 'sin-fecha',
          base: total - iva, iva, total,
        };
      }).sort((a, b) => (a.doc_date || '').localeCompare(b.doc_date || ''));
    } catch { purchases = []; }

    return ok(c, { invoices, purchases });
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
      .lte('issued_at', to || '2099-12-31')
      .order('issued_at', { ascending: false })
      .limit(5000);

    const invoiceIds = (invoices ?? []).map((i: any) => i.id);

    // Traer los ítems EN LOTES: un solo `.in()` con cientos/miles de ids genera una
    // URL gigante que falla en silencio (items vacío → reporte vacío aunque haya
    // ventas). Paginamos de a 200 para que siempre traiga todo.
    const items: any[] = [];
    const CHUNK = 200;
    let withName = true;   // si la columna product_name no existe aún (migración 70), reintentamos sin ella
    for (let i = 0; i < invoiceIds.length; i += CHUNK) {
      const chunk = invoiceIds.slice(i, i + CHUNK);
      const cols = withName
        ? 'invoice_id, product_id, product_name, quantity, unit_price, subtotal'
        : 'invoice_id, product_id, quantity, unit_price, subtotal';
      let part: any = null;
      let itErr: any = null;
      { const r = await db.from('invoice_items').select(cols).in('invoice_id', chunk); part = r.data; itErr = r.error; }
      if (itErr && withName && /product_name/i.test(String(itErr.message))) {
        withName = false;
        const r = await db.from('invoice_items')
          .select('invoice_id, product_id, quantity, unit_price, subtotal').in('invoice_id', chunk);
        part = r.data; itErr = r.error;
      }
      if (itErr) throw new Error(itErr.message);
      if (part) items.push(...part);
    }

    const { data: products } = await db.from('products').select('id, name');

    const groupMap: Record<string, any> = {};
    (items ?? []).forEach((item: any) => {
      const inv = (invoices ?? []).find((i: any) => i.id === item.invoice_id);
      const product = (products ?? []).find((p: any) => p.id === item.product_id);
      // Nombre autoritativo: el guardado en la venta (invoice_items.product_name),
      // que sobrevive aunque el producto se borre o se renombre. El producto actual
      // es solo respaldo. Agrupamos por product_id, o por nombre si no hay id (ítems
      // manuales / product_id null) para que no colapsen todos en "desconocido".
      const name = item.product_name || product?.name || 'Producto desconocido';
      const key = item.product_id || `name:${name}`;
      if (!groupMap[key]) {
        groupMap[key] = {
          product_id: item.product_id,
          product_name: name,
          total_qty: 0,
          total_revenue: 0,
          sales_count: 0,
          lines: [],
        };
      }
      groupMap[key].total_qty += item.quantity;
      groupMap[key].total_revenue += item.subtotal;
      if (inv) {
        groupMap[key].lines.push({
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
