import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

const hr = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

// ─── EMPLOYEES ───────────────────────────────────────────────────────────────

const EmployeeSchema = z.object({
  user_id: z.string().uuid().optional().nullable(),
  full_name: z.string().min(1),
  identification: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  position: z.string().min(1),
  department: z.string().min(1).default('Salón'),
  hourly_rate: z.number().optional().nullable(),
  monthly_salary: z.number().optional().nullable(),
  commission_pct: z.number().optional().nullable(),
  hire_date: z.string(),
  status: z.enum(['active', 'inactive', 'vacation', 'leave']).default('active'),
  health_cert_expires_at: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  // ── Lo que agrega la migración 115 ──
  // Sin declararlo acá, zod los descartaba en silencio: el formulario mandaba el
  // dato, la respuesta venía «ok» y el campo quedaba vacío en la base.
  branch_id: z.string().uuid().optional().nullable(),
  salary_type: z.enum(['monthly', 'hourly', 'commission']).optional(),
  commission_base: z.enum(['sales', 'salary']).optional(),
  payment_method: z.string().optional().nullable(),
  bank_account: z.string().optional().nullable(),
  birth_date: z.string().optional().nullable(),
  emergency_contact: z.string().optional().nullable(),
  emergency_phone: z.string().optional().nullable(),
  contract_type: z.string().optional().nullable(),
  contract_end_date: z.string().optional().nullable(),
  vacation_days_per_year: z.number().optional().nullable(),
  photo_url: z.string().optional().nullable(),
  terminated_at: z.string().optional().nullable(),
  termination_reason: z.string().optional().nullable(),
});

/**
 * Una fecha vacía es NULL, no ''.
 *
 * El formulario manda '' cuando el campo se deja en blanco y PostgreSQL rechaza
 * '' en una columna DATE con un error que no explica nada («invalid input syntax
 * for type date»). Guardar un empleado sin carné de salud fallaba por eso.
 */
const CAMPOS_FECHA = [
  'health_cert_expires_at', 'birth_date', 'contract_end_date', 'terminated_at',
] as const;
function limpiarFechas<T extends Record<string, any>>(d: T): T {
  const out: any = { ...d };
  for (const k of CAMPOS_FECHA) {
    if (k in out && (out[k] === '' || out[k] === undefined)) out[k] = null;
  }
  // `hire_date` NO admite null: se quita la clave para que la base ponga su
  // valor por omisión (hoy) en vez de rechazar el guardado.
  if (out.hire_date === '' || out.hire_date === null) delete out.hire_date;
  return out;
}

// GET /employees
hr.get('/employees', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db
      .from('employees')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// GET /employees/me — empleado vinculado al usuario actual (auto-detección)
hr.get('/employees/me', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const { data } = await db
      .from('employees')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .maybeSingle();
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /employees
hr.post('/employees', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = EmployeeSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('employees')
      .insert({ ...limpiarFechas(parsed.data), tenant_id: tenantId })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PUT /employees/:id
hr.put('/employees/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json();
    const parsed = EmployeeSchema.partial().safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('employees')
      .update(limpiarFechas(parsed.data))
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /employees/:id
hr.delete('/employees/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db
      .from('employees')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// ─── ATTENDANCE ──────────────────────────────────────────────────────────────

// GET /attendance?employee_id=&from=&to=
hr.get('/attendance', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const empId = c.req.query('employee_id');
    const from = c.req.query('from');
    const to = c.req.query('to');

    let query = db
      .from('attendance_records')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('date', { ascending: false });

    if (empId) query = query.eq('employee_id', empId);
    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /attendance/clock-in
hr.post('/attendance/clock-in', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { employee_id } = await c.req.json();
    if (!employee_id) return fail(c, 'employee_id requerido', 422);

    const today = new Date().toISOString().slice(0, 10);

    // Verificar si ya marcó hoy
    const { data: existing } = await db
      .from('attendance_records')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('employee_id', employee_id)
      .eq('date', today)
      .maybeSingle();

    if (existing) return ok(c, existing);

    const { data, error } = await db
      .from('attendance_records')
      .insert({
        tenant_id: tenantId,
        employee_id,
        date: today,
        clock_in: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /attendance/clock-out
hr.post('/attendance/clock-out', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { employee_id } = await c.req.json();
    if (!employee_id) return fail(c, 'employee_id requerido', 422);

    const today = new Date().toISOString().slice(0, 10);

    const { data: existing, error: e1 } = await db
      .from('attendance_records')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('employee_id', employee_id)
      .eq('date', today)
      .maybeSingle();
    if (e1) throw new Error(e1.message);
    if (!existing) return fail(c, 'No hay marcaje de entrada para hoy', 404);
    if (existing.clock_out) return ok(c, existing);

    const out = new Date();
    const inDate = new Date(existing.clock_in);
    const hours = Math.max(0, (out.getTime() - inDate.getTime()) / 3_600_000);

    const { data, error } = await db
      .from('attendance_records')
      .update({
        clock_out: out.toISOString(),
        hours_worked: Math.round(hours * 100) / 100,
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// ─── LEAVE REQUESTS ──────────────────────────────────────────────────────────

const LeaveSchema = z.object({
  employee_id: z.string().uuid(),
  employee_name: z.string().optional().nullable(),
  type: z.enum(['vacation', 'sick', 'personal', 'maternity', 'other']),
  start_date: z.string(),
  end_date: z.string(),
  days: z.number().int().positive(),
  reason: z.string().min(1),
});

// GET /leave-requests?status=pending&employee_id=
hr.get('/leave-requests', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const status = c.req.query('status');
    const empId = c.req.query('employee_id');

    let query = db
      .from('leave_requests')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (empId) query = query.eq('employee_id', empId);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// POST /leave-requests
hr.post('/leave-requests', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json();
    const parsed = LeaveSchema.safeParse(body);
    if (!parsed.success) return fail(c, parsed.error.message, 422);

    const { data, error } = await db
      .from('leave_requests')
      .insert({ ...parsed.data, tenant_id: tenantId, status: 'pending' })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return ok(c, data, 201);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// PATCH /leave-requests/:id/status (approve/reject)
hr.patch('/leave-requests/:id/status', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { status, approved_by } = await c.req.json();
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return fail(c, 'Estado inválido', 422);
    }

    const { data, error } = await db
      .from('leave_requests')
      .update({
        status,
        approved_by: approved_by ?? null,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// DELETE /leave-requests/:id
hr.delete('/leave-requests/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { error } = await db
      .from('leave_requests')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) {
    return fail(c, err.message, 500);
  }
});

// ─── PLANILLA ────────────────────────────────────────────────────────────────

/**
 * Cargas sociales de Costa Rica (2026).
 *
 * El obrero es lo que se le DESCUENTA al empleado; el patronal es lo que el
 * negocio paga ENCIMA del salario. Los dos salen del mismo bruto, y la
 * diferencia entre «salarios» y «lo que cuesta la planilla» es justo el
 * patronal: un negocio que presupuesta solo los salarios se queda corto más de
 * un cuarto del monto, todos los meses.
 *
 * Son porcentajes de ley y cambian: van acá, en un solo lugar, para poder
 * actualizarlos sin tocar el cálculo.
 */
export const CARGAS = {
  /** CCSS + BPDC que se le retiene al empleado. */
  obrero: 0.1067,
  /** CCSS, INS, asignaciones, BPDC, INA que paga el negocio. */
  patronal: 0.2667,
};

/** Días que se usan para prorratear un salario mensual. */
const DIAS_DEL_MES = 30;

const redondo = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

interface LineaPlanilla {
  employee_id: string;
  employee_name: string;
  position: string | null;
  salary_type: string;
  base_amount: number;
  hours: number | null;
  hourly_rate: number | null;
  commission_pct: number | null;
  commission_sales: number;
  commission_amount: number;
  bonuses: number;
  advances: number;
  other_deductions: number;
  employee_charges: number;
  gross: number;
  net: number;
  payment_method: string | null;
  unpaid_days: number;
  notes: string | null;
}

/**
 * Arma la planilla de un período con DATOS REALES del sistema.
 *
 * Esto es lo que antes no existía: la pantalla multiplicaba el salario del
 * expediente y mostraba el resultado. Acá:
 *
 *   · Las HORAS de quien cobra por hora salen de los marcajes de asistencia.
 *   · La COMISIÓN sale de las ventas que esa persona facturó en el período
 *     —cruzando el usuario del empleado con el cajero o el agente de la
 *     factura—, no de un porcentaje de su propio salario.
 *   · Las ausencias SIN GOCE del período se descuentan.
 */
async function armarPlanilla(
  tenantId: string,
  from: string,
  to: string,
  branchId?: string | null,
): Promise<{ lineas: LineaPlanilla[]; totales: any }> {
  let q = db.from('employees').select('*').eq('tenant_id', tenantId).eq('status', 'active');
  if (branchId) q = q.eq('branch_id', branchId);
  const { data: emps, error } = await q;
  if (error) throw new Error(error.message);
  const empleados = (emps ?? []) as any[];

  // ── Horas trabajadas del período (para los que cobran por hora) ──
  const horas = new Map<string, number>();
  {
    const { data } = await db.from('attendance_records')
      .select('employee_id, hours_worked')
      .eq('tenant_id', tenantId).gte('date', from).lte('date', to);
    for (const r of (data ?? []) as any[]) {
      horas.set(String(r.employee_id), (horas.get(String(r.employee_id)) ?? 0) + Number(r.hours_worked || 0));
    }
  }

  // ── Ventas del período por usuario, para la comisión ──
  const ventasPorUsuario = new Map<string, number>();
  {
    const PAGE = 1000;
    for (let desde = 0; ; desde += PAGE) {
      const { data, error: e } = await db.from('invoices')
        .select('cashier_id, sales_agent_id, total, status, issued_at')
        .eq('tenant_id', tenantId)
        .gte('issued_at', `${from}T00:00:00`).lte('issued_at', `${to}T23:59:59`)
        .order('id', { ascending: true }).range(desde, desde + PAGE - 1);
      if (e) break;   // sin ventas no se cae la planilla: la comisión queda en 0
      const chunk = (data ?? []) as any[];
      for (const inv of chunk) {
        if (inv.status === 'cancelled') continue;
        // Una venta cuenta UNA vez: si trae agente, es del agente; si no, del cajero.
        const quien = inv.sales_agent_id ?? inv.cashier_id;
        if (!quien) continue;
        ventasPorUsuario.set(String(quien), (ventasPorUsuario.get(String(quien)) ?? 0) + Number(inv.total || 0));
      }
      if (chunk.length < PAGE) break;
    }
  }

  // ── Ausencias SIN GOCE aprobadas que caen en el período ──
  const diasSinGoce = new Map<string, number>();
  {
    const { data } = await db.from('leave_requests')
      .select('employee_id, days, paid, status, start_date, end_date')
      .eq('tenant_id', tenantId).eq('status', 'approved')
      .lte('start_date', to).gte('end_date', from);
    for (const l of (data ?? []) as any[]) {
      if (l.paid === false) {
        diasSinGoce.set(String(l.employee_id),
          (diasSinGoce.get(String(l.employee_id)) ?? 0) + Number(l.days || 0));
      }
    }
  }

  const lineas: LineaPlanilla[] = empleados.map(e => {
    const tipo = String(e.salary_type ?? 'monthly');
    const hs = horas.get(String(e.id)) ?? 0;
    const tarifa = Number(e.hourly_rate || 0);

    let base = 0;
    if (tipo === 'hourly') base = redondo(hs * tarifa);
    else if (tipo === 'commission') base = 0;
    else base = Number(e.monthly_salary || 0);

    // Ausencia sin goce: se descuenta del salario fijo (al de por hora ya no se
    // le pagaron esas horas, así que descontarlo otra vez sería cobrárselo dos veces).
    const sinGoce = diasSinGoce.get(String(e.id)) ?? 0;
    const descuentoAusencia = tipo === 'monthly' && sinGoce > 0
      ? redondo((base / DIAS_DEL_MES) * sinGoce) : 0;
    base = redondo(base - descuentoAusencia);

    const pct = Number(e.commission_pct || 0);
    const sobreVentas = String(e.commission_base ?? 'sales') === 'sales';
    const ventas = e.user_id ? (ventasPorUsuario.get(String(e.user_id)) ?? 0) : 0;
    const comisionSobre = sobreVentas ? ventas : base;
    const comision = pct > 0 ? redondo(comisionSobre * (pct / 100)) : 0;

    const bruto = redondo(base + comision);
    const obrero = redondo(bruto * CARGAS.obrero);
    const neto = redondo(bruto - obrero);

    return {
      employee_id: String(e.id),
      employee_name: String(e.full_name ?? ''),
      position: e.position ?? null,
      salary_type: tipo,
      base_amount: base,
      hours: tipo === 'hourly' ? redondo(hs) : null,
      hourly_rate: tipo === 'hourly' ? tarifa : null,
      commission_pct: pct || null,
      commission_sales: redondo(sobreVentas ? ventas : 0),
      commission_amount: comision,
      bonuses: 0,
      advances: 0,
      other_deductions: 0,
      employee_charges: obrero,
      gross: bruto,
      net: neto,
      payment_method: e.payment_method ?? null,
      unpaid_days: sinGoce,
      notes: descuentoAusencia > 0
        ? `Se descontaron ${sinGoce} día(s) de ausencia sin goce (₡${descuentoAusencia})` : null,
    };
  });

  const suma = (f: (l: LineaPlanilla) => number) => redondo(lineas.reduce((t, l) => t + f(l), 0));
  const bruto = suma(l => l.gross);
  const patronal = redondo(bruto * CARGAS.patronal);
  const totales = {
    gross: bruto,
    employee_charges: suma(l => l.employee_charges),
    other_deductions: suma(l => l.advances + l.other_deductions),
    employer_charges: patronal,
    net: suma(l => l.net),
    total_cost: redondo(bruto + patronal),
    employees_count: lineas.length,
    /** Lo que de verdad se vendió en el período, para medir la planilla contra eso. */
    sales_total: redondo([...ventasPorUsuario.values()].reduce((t, v) => t + v, 0)),
  };
  return { lineas, totales };
}

/** GET /payroll/preview?from=&to=&branch_id= — la planilla calculada, sin guardar. */
hr.get('/payroll/preview', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const hoy = new Date();
    const from = c.req.query('from')
      ?? new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10);
    const to = c.req.query('to')
      ?? new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toISOString().slice(0, 10);
    const branchId = c.req.query('branch_id') || null;

    const { lineas, totales } = await armarPlanilla(tenantId, from, to, branchId);

    // ¿Ya hay una planilla guardada para este período? Para no pagar dos veces.
    const { data: existente } = await db.from('payroll_runs')
      .select('id, status, paid_at')
      .eq('tenant_id', tenantId).eq('period_start', from).eq('period_end', to)
      .maybeSingle();

    return ok(c, { from, to, branch_id: branchId, lineas, totales, cargas: CARGAS, existente: existente ?? null });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** GET /payroll — planillas guardadas (las más recientes primero). */
hr.get('/payroll', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { data, error } = await db.from('payroll_runs').select('*')
      .eq('tenant_id', tenantId).order('period_start', { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    return ok(c, data ?? []);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** GET /payroll/:id — una planilla con sus líneas, tal como se guardó. */
hr.get('/payroll/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: run, error } = await db.from('payroll_runs').select('*')
      .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!run) return fail(c, 'Planilla no encontrada', 404);
    const { data: items } = await db.from('payroll_items').select('*')
      .eq('run_id', id).order('employee_name', { ascending: true });
    return ok(c, { ...(run as any), items: items ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

const PlanillaSchema = z.object({
  period_start: z.string(),
  period_end: z.string(),
  branch_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
  /** Las líneas tal como quedaron en pantalla: pueden venir ajustadas a mano. */
  items: z.array(z.object({
    employee_id: z.string().uuid().optional().nullable(),
    employee_name: z.string().min(1),
    position: z.string().optional().nullable(),
    salary_type: z.string().optional().nullable(),
    base_amount: z.number(),
    hours: z.number().optional().nullable(),
    hourly_rate: z.number().optional().nullable(),
    commission_pct: z.number().optional().nullable(),
    commission_sales: z.number().optional().default(0),
    commission_amount: z.number().optional().default(0),
    bonuses: z.number().optional().default(0),
    advances: z.number().optional().default(0),
    other_deductions: z.number().optional().default(0),
    payment_method: z.string().optional().nullable(),
    unpaid_days: z.number().optional().default(0),
    notes: z.string().optional().nullable(),
  })).min(1),
});

/**
 * POST /payroll — guarda la planilla del período.
 *
 * Los montos se guardan CONGELADOS. Si mañana alguien le sube el salario a un
 * empleado, la planilla de este mes sigue diciendo lo que se pagó este mes: es
 * un hecho, no una cuenta que se vuelve a hacer.
 */
hr.post('/payroll', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const parsed = PlanillaSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, parsed.error.message, 422);
    const { period_start, period_end, branch_id, notes, items } = parsed.data;

    const { data: ya } = await db.from('payroll_runs').select('id, status')
      .eq('tenant_id', tenantId).eq('period_start', period_start).eq('period_end', period_end)
      .maybeSingle();
    if (ya) {
      return fail(c, `Ese período ya tiene una planilla (${(ya as any).status}). `
        + 'Abrila y modificala, o borrala si estaba mal.', 409);
    }

    // Se recalculan los totales ACÁ: el navegador manda las líneas, pero las
    // sumas y las cargas no se le creen a nadie de afuera.
    const lineas = items.map(i => {
      const bruto = redondo(i.base_amount + (i.commission_amount ?? 0) + (i.bonuses ?? 0));
      const obrero = redondo(bruto * CARGAS.obrero);
      const descuentos = redondo((i.advances ?? 0) + (i.other_deductions ?? 0));
      return {
        ...i,
        tenant_id: tenantId,
        gross: bruto,
        employee_charges: obrero,
        net: redondo(bruto - obrero - descuentos),
      };
    });
    const bruto = redondo(lineas.reduce((t, l) => t + l.gross, 0));
    const patronal = redondo(bruto * CARGAS.patronal);

    const { data: run, error } = await db.from('payroll_runs').insert({
      tenant_id: tenantId,
      branch_id: branch_id ?? null,
      period_start, period_end, notes: notes ?? null,
      status: 'draft',
      gross: bruto,
      employee_charges: redondo(lineas.reduce((t, l) => t + l.employee_charges, 0)),
      other_deductions: redondo(lineas.reduce((t, l) => t + (l.advances ?? 0) + (l.other_deductions ?? 0), 0)),
      employer_charges: patronal,
      net: redondo(lineas.reduce((t, l) => t + l.net, 0)),
      total_cost: redondo(bruto + patronal),
      employees_count: lineas.length,
      created_by: c.get('userId') ?? null,
    }).select().single();
    if (error) throw new Error(error.message);

    const { error: eItems } = await db.from('payroll_items')
      .insert(lineas.map(l => ({ ...l, run_id: (run as any).id })));
    if (eItems) {
      // Sin líneas la planilla no sirve de nada: se deshace para no dejar basura.
      await db.from('payroll_runs').delete().eq('id', (run as any).id);
      throw new Error(eItems.message);
    }

    return ok(c, run, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * POST /payroll/:id/pay — la planilla se pagó.
 *
 * Y ACÁ ESTÁ EL ENGANCHE con el resto del sistema: se registra el GASTO. Sin
 * esto, el gasto más grande del mes no aparecía en Gastos ni en la utilidad, y
 * el negocio veía una ganancia que no era.
 */
hr.post('/payroll/:id/pay', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const metodo = typeof body?.payment_method === 'string' ? body.payment_method : 'cash';
    /** Registrar el gasto se puede saltar (ej. el contador lo lleva aparte). */
    const conGasto = body?.register_expense !== false;

    const { data: run } = await db.from('payroll_runs').select('*')
      .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (!run) return fail(c, 'Planilla no encontrada', 404);
    if ((run as any).status === 'paid') return fail(c, 'Esa planilla ya está pagada', 409);

    let expenseId: string | null = (run as any).expense_id ?? null;
    if (conGasto && !expenseId) {
      // Categoría «Salarios»: si el negocio no la tiene, se crea.
      let categoryId: string | null = null;
      const { data: cat } = await db.from('expense_categories').select('id')
        .eq('tenant_id', tenantId).ilike('name', 'salarios').maybeSingle();
      categoryId = (cat as any)?.id ?? null;
      if (!categoryId) {
        const { data: nueva } = await db.from('expense_categories')
          .insert({ tenant_id: tenantId, name: 'Salarios' }).select('id').single();
        categoryId = (nueva as any)?.id ?? null;
      }

      /**
       * El gasto es el COSTO TOTAL, no el neto que recibe la gente.
       *
       * Lo que sale del negocio es el bruto más las cargas patronales. Registrar
       * solo el neto dejaría fuera más de un tercio de lo que de verdad cuesta
       * la planilla.
       */
      const { data: gasto, error: eGasto } = await db.from('expenses').insert({
        tenant_id: tenantId,
        category_id: categoryId,
        description: `Planilla ${(run as any).period_start} al ${(run as any).period_end}`,
        amount: Number((run as any).total_cost || 0),
        date: (run as any).period_end,
        payment_method: metodo,
        reference: `planilla:${id}`,
        notes: `${(run as any).employees_count} empleado(s) · neto ₡${(run as any).net} · `
          + `cargas patronales ₡${(run as any).employer_charges}`,
        branch_id: (run as any).branch_id ?? null,
        user_id: c.get('userId') ?? null,
      }).select('id').single();
      if (eGasto) throw new Error(`No se pudo registrar el gasto: ${eGasto.message}`);
      expenseId = (gasto as any)?.id ?? null;
    }

    const { data, error } = await db.from('payroll_runs').update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      approved_at: (run as any).approved_at ?? new Date().toISOString(),
      expense_id: expenseId,
    }).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error) throw new Error(error.message);
    return ok(c, { ...(data as any), expense_id: expenseId });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** DELETE /payroll/:id — solo si NO se pagó (lo pagado es historia). */
hr.delete('/payroll/:id', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { data: run } = await db.from('payroll_runs').select('status')
      .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (!run) return fail(c, 'Planilla no encontrada', 404);
    if ((run as any).status === 'paid') {
      return fail(c, 'Una planilla PAGADA no se borra: es el respaldo de lo que se pagó. '
        + 'Si fue un error, borrá el gasto y hacé el ajuste en la siguiente.', 409);
    }
    const { error } = await db.from('payroll_runs').delete().eq('id', id).eq('tenant_id', tenantId);
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/**
 * GET /alerts — lo de RRHH que necesita atención.
 *
 * Lo consume el menú de notificaciones del tablero: el carné de salud vencido o
 * el contrato que se acaba son cosas que se descubren tarde, cuando ya hay una
 * multa o un empleado trabajando sin papeles al día.
 */
hr.get('/alerts', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const hoy = new Date().toISOString().slice(0, 10);
    const en30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    /**
     * Si las columnas de la migración 115 todavía no están, se consulta sin
     * ellas.
     *
     * Sin esto la consulta falla completa y el endpoint devuelve CEROS: parecía
     * que el negocio no tiene empleados ni nada pendiente, que es la respuesta
     * más engañosa posible. Así, hasta que la migración corra, al menos avisa de
     * los carnés de salud.
     */
    let emps: any[] | null = null;
    {
      const completo = await db.from('employees')
        .select('id, full_name, health_cert_expires_at, contract_end_date, contract_type')
        .eq('tenant_id', tenantId).eq('status', 'active');
      if (completo.error) {
        const basico = await db.from('employees')
          .select('id, full_name, health_cert_expires_at')
          .eq('tenant_id', tenantId).eq('status', 'active');
        if (basico.error) throw new Error(basico.error.message);
        emps = basico.data as any[];
      } else {
        emps = completo.data as any[];
      }
    }
    const empleados = (emps ?? []) as any[];

    const carneVencido = empleados.filter(e => e.health_cert_expires_at && e.health_cert_expires_at < hoy);
    const carnePorVencer = empleados.filter(e =>
      e.health_cert_expires_at && e.health_cert_expires_at >= hoy && e.health_cert_expires_at <= en30);
    const contratoPorVencer = empleados.filter(e =>
      e.contract_end_date && e.contract_end_date >= hoy && e.contract_end_date <= en30);

    const { count: ausenciasPendientes } = await db.from('leave_requests')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('status', 'pending');

    return ok(c, {
      empleados_activos: empleados.length,
      carne_vencido: carneVencido.map(e => e.full_name),
      carne_por_vencer: carnePorVencer.map(e => e.full_name),
      contrato_por_vencer: contratoPorVencer.map(e => e.full_name),
      ausencias_pendientes: ausenciasPendientes ?? 0,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default hr;
