import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';
import {
  cargarTasas, guardarTasas, calcularLinea, totalizar, deduccionesDe,
  abonarDeducciones, factorDelPeriodo, TASAS_2026,
  type TasasPlanilla, type ResultadoLinea,
} from '../services/planillaCR.js';
import { hashPin, empleadoPorPin, marcar, hoyCR } from '../services/fichaje.js';
import {
  opcionesRegistro, verificarRegistro, opcionesFichaje, verificarFichaje,
} from '../services/fichajeBiometria.js';

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
  // ── Lo que agrega la migración 149 ──
  // Mismo motivo que arriba: sin declararlo, el formulario manda los hijos y
  // el cónyuge, la respuesta viene «ok» y la retención sigue saliendo alta.
  dependents_children: z.number().int().min(0).optional(),
  has_spouse: z.boolean().optional(),
  tax_exempt: z.boolean().optional(),
});

/** Los campos que solo existen con la migración 149 corrida. */
const CAMPOS_EMP_149 = ['dependents_children', 'has_spouse', 'tax_exempt'];

const sinCampos149 = (fila: Record<string, any>) => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fila)) if (!CAMPOS_EMP_149.includes(k)) out[k] = v;
  return out;
};

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

    const fila = { ...limpiarFechas(parsed.data), tenant_id: tenantId };
    let { data, error } = await db.from('employees').insert(fila).select().single();
    /* Sin la migración 149 esas tres columnas no existen y PostgREST rechaza
       el insert COMPLETO. El empleado se crea igual sin ellas: no poder dar
       de alta a nadie por los créditos del impuesto sería peor que no tener
       los créditos. */
    if (error && sinColumna(error)) {
      ({ data, error } = await db.from('employees').insert(sinCampos149(fila)).select().single());
    }
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

    const campos = limpiarFechas(parsed.data);
    let { data, error } = await db.from('employees')
      .update(campos).eq('id', id).eq('tenant_id', tenantId).select().single();
    if (error && sinColumna(error)) {
      ({ data, error } = await db.from('employees')
        .update(sinCampos149(campos)).eq('id', id).eq('tenant_id', tenantId).select().single());
    }
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
/**
 * LOS PORCENTAJES, ahora derivados del desglose.
 *
 * Antes eran la fuente de la verdad: dos números sueltos. Ahora salen de
 * sumar los rubros configurados, así que no pueden contradecir al desglose
 * que se le muestra al empleado. Se siguen devolviendo porque la pantalla
 * los usa para el resumen de arriba.
 *
 * El INS va APARTE y no entra en `patronal`: es una póliza del INS con
 * tarifa según la actividad del negocio, no una carga de la CCSS. Meterlo
 * adentro era justo lo que no dejaba ajustarlo.
 */
export function resumenCargas(t: TasasPlanilla) {
  const suma = (xs: Array<{ pct: number }>) => xs.reduce((s, x) => s + (Number(x.pct) || 0), 0);
  return {
    obrero: Math.round(suma(t.obrero) * 1e6) / 1e8,
    patronal: Math.round(suma(t.patronal) * 1e6) / 1e8,
    ins: Math.round(Number(t.ins.activo ? t.ins.pct : 0) * 1e6) / 1e8,
    vigente: t.vigente,
  };
}

/** Días que se usan para prorratear un salario mensual. */
const DIAS_DEL_MES = 30;

const redondo = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * EL DESGLOSE, CUANDO LA COLUMNA TODAVÍA NO EXISTE.
 *
 * PostgREST rechaza el insert COMPLETO si una sola clave no corresponde a
 * una columna. Sin esto, un negocio que no ha corrido la migración 149 no
 * podría guardar NINGUNA planilla: el módulo entero se caería por una
 * columna de desglose que es un agregado, no lo esencial.
 *
 * Así que se intenta con el desglose y, si la columna no está, se guarda sin
 * él. Lo que se paga —bruto, cuotas, neto— se guarda siempre.
 */
const CAMPOS_149 = [
  'employee_charges_detail', 'income_tax', 'income_tax_detail', 'deductions_detail',
  'employer_charges', 'employer_charges_detail', 'ins_amount', 'contribution_base',
  'other_deductions_detail', 'rates_snapshot',
];

const conDesglose = (base: Record<string, any>, extra: Record<string, any>) => ({ ...base, ...extra });

const soloBase = (fila: Record<string, any>) => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fila)) if (!CAMPOS_149.includes(k)) out[k] = v;
  return out;
};

const sinColumna = (e: any) =>
  !!e && /column .* does not exist|Could not find the .* column|schema cache/i.test(String(e.message ?? e));

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
  // ── El desglose, que antes no existía ──
  employee_charges_detail: any[];
  income_tax: number;
  income_tax_detail: any[];
  deductions_detail: any[];
  employer_charges: number;
  employer_charges_detail: any[];
  ins_amount: number;
  contribution_base: number;
  /** Avisos de la línea. No cambian ningún número: se muestran. */
  avisos: string[];
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
): Promise<{ lineas: LineaPlanilla[]; totales: any; tasas: TasasPlanilla; factor: number }> {
  let q = db.from('employees').select('*').eq('tenant_id', tenantId).eq('status', 'active');
  if (branchId) q = q.eq('branch_id', branchId);
  const { data: emps, error } = await q;
  if (error) throw new Error(error.message);
  const empleados = (emps ?? []) as any[];

  /* Las tasas del negocio (o las de 2026 por omisión) y las deducciones fijas
     de cada empleado: préstamos, solidarista, pensión alimentaria, embargos. */
  const tasas = await cargarTasas(tenantId);
  const deducciones = await deduccionesDe(tenantId, empleados.map(e => String(e.id)));

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

    /* Todo el cálculo de cargas, impuesto y deducciones vive en
       `planillaCR.ts`: acá solo se arma el bruto con los datos del sistema.
       Separarlo es lo que permite probar el cálculo sin inventar empleados,
       marcajes y facturas. */
    const r = calcularLinea({
      bruto,
      tasas,
      deducciones: deducciones.get(String(e.id)) ?? [],
      hijos: Number(e.dependents_children) || 0,
      conyuge: e.has_spouse === true,
      exento_renta: e.tax_exempt === true,
      desde: from, hasta: to,
    });

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
      /**
       * `advances` y `other_deductions` son los campos que la PANTALLA deja
       * ajustar a mano, y arrancan en cero.
       *
       * Las deducciones fijas del empleado —préstamo, solidarista, embargo—
       * NO van acá: van en `deductions_detail`. Si se copiaran a este campo,
       * al recalcular con los ajustes el motor las sumaría otra vez encima
       * de las fijas y el empleado aparecería con el doble de descuento.
       */
      advances: 0,
      other_deductions: 0,
      employee_charges: r.obrero,
      gross: bruto,
      net: r.neto,
      payment_method: e.payment_method ?? null,
      unpaid_days: sinGoce,
      notes: descuentoAusencia > 0
        ? `Se descontaron ${sinGoce} día(s) de ausencia sin goce (₡${descuentoAusencia})` : null,
      employee_charges_detail: r.obrero_detalle,
      income_tax: r.renta,
      income_tax_detail: r.renta_detalle,
      deductions_detail: r.deducciones_detalle,
      employer_charges: r.patronal,
      employer_charges_detail: r.patronal_detalle,
      ins_amount: r.ins,
      contribution_base: r.base_contributiva,
      avisos: r.avisos,
    };
  });

  /* Los totales se suman rubro por rubro: el total de SEM del período es la
     suma de los SEM de cada línea, no el bruto por la tasa. Con la base
     mínima contributiva activada esas dos cuentas NO dan lo mismo, y la que
     la CCSS cobra es la primera. */
  const totales = {
    /* Se totaliza lo que el motor calculó, sin volver a derivarlo de los
       campos de la línea: re-derivar es exactamente cómo se cuelan los
       dobles conteos. */
    ...totalizar(lineas.map(l => ({
      bruto: l.gross,
      obrero: l.employee_charges, obrero_detalle: l.employee_charges_detail,
      renta: l.income_tax, renta_detalle: l.income_tax_detail,
      deducciones: redondo((l.deductions_detail ?? []).reduce((t: number, d: any) => t + Number(d.monto || 0), 0)),
      deducciones_detalle: l.deductions_detail,
      patronal: l.employer_charges, patronal_detalle: l.employer_charges_detail,
      ins: l.ins_amount, neto: l.net,
      costo: redondo(l.gross + l.employer_charges + l.ins_amount),
      base_contributiva: l.contribution_base, bmc_ajustada: false, avisos: l.avisos,
    })) as ResultadoLinea[]),
    /** Lo que de verdad se vendió en el período, para medir la planilla contra eso. */
    sales_total: redondo([...ventasPorUsuario.values()].reduce((t, v) => t + v, 0)),
  };
  return { lineas, totales, tasas, factor: factorDelPeriodo(from, to) };
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

    const { lineas, totales, tasas, factor } = await armarPlanilla(tenantId, from, to, branchId);

    // ¿Ya hay una planilla guardada para este período? Para no pagar dos veces.
    const { data: existente } = await db.from('payroll_runs')
      .select('id, status, paid_at')
      .eq('tenant_id', tenantId).eq('period_start', from).eq('period_end', to)
      .maybeSingle();

    return ok(c, {
      from, to, branch_id: branchId, lineas, totales,
      cargas: resumenCargas(tasas),
      /* Las tasas completas van a la pantalla: es lo que permite mostrar el
         desglose con su nombre y su porcentaje sin que el navegador los
         adivine ni los tenga duplicados. */
      tasas,
      /** Cuánto del mes cubre el período: una quincena es 0,5. */
      factor,
      existente: existente ?? null,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/* ── El orden de estas rutas importa ──────────────────────────────────────
   `/payroll/settings` tiene que registrarse ANTES de `/payroll/:id`: si va
   después, el comodín `:id` se come la palabra «settings» y pedir las tasas
   devuelve «planilla no encontrada». No es una preferencia de estilo, es la
   diferencia entre que la pantalla de tasas cargue o no. */

// ══════════════════════════════════════════════════════════════════════════
// LAS TASAS DE LA PLANILLA
// ══════════════════════════════════════════════════════════════════════════

/** GET /payroll/settings — las tasas del negocio, o las de 2026 por omisión. */
hr.get('/payroll/settings', async (c) => {
  try {
    const tasas = await cargarTasas(c.get('tenantId'));
    return ok(c, {
      tasas,
      resumen: resumenCargas(tasas),
      /* Las de fábrica van también, para poder volver a ellas sin tener que
         escribir nueve porcentajes a mano. */
      por_omision: TASAS_2026,
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

const TasaSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pct: z.number().min(0).max(100),
  nota: z.string().optional().nullable(),
});

const AjustesSchema = z.object({
  vigente: z.string().optional(),
  obrero: z.array(TasaSchema).optional(),
  patronal: z.array(TasaSchema).optional(),
  ins: z.object({
    pct: z.number().min(0).max(100),
    label: z.string().optional(),
    nota: z.string().optional(),
    activo: z.boolean().optional(),
  }).optional(),
  renta: z.object({
    activo: z.boolean().optional(),
    base: z.enum(['bruto', 'bruto_menos_ccss']).optional(),
    tramos: z.array(z.object({
      desde: z.number().min(0),
      hasta: z.number().min(0).nullable(),
      pct: z.number().min(0).max(100),
    })).optional(),
    credito_hijo: z.number().min(0).optional(),
    credito_conyuge: z.number().min(0).optional(),
  }).optional(),
  bmc: z.object({
    aplicar: z.boolean().optional(),
    sem: z.number().min(0).optional(),
    ivm: z.number().min(0).optional(),
  }).optional(),
});

/** PUT /payroll/settings — cambiar las tasas. */
hr.put('/payroll/settings', async (c) => {
  try {
    const parsed = AjustesSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? 'Datos inválidos', 422);

    const cfg: any = parsed.data;
    /* Los tramos tienen que ir en orden y sin huecos: si no, un salario cae
       en dos tramos o en ninguno y el impuesto sale mal sin avisar. */
    if (Array.isArray(cfg.renta?.tramos)) {
      const t = [...cfg.renta.tramos].sort((a: any, b: any) => a.desde - b.desde);
      for (let i = 0; i < t.length; i++) {
        if (t[i].hasta != null && t[i].hasta <= t[i].desde) {
          return fail(c, `El tramo que empieza en ${t[i].desde} termina antes de empezar.`, 422);
        }
        if (i > 0 && t[i - 1].hasta !== t[i].desde) {
          return fail(c, `Los tramos del impuesto tienen un hueco o se solapan entre `
            + `${t[i - 1].hasta} y ${t[i].desde}: cada uno tiene que empezar donde termina el anterior.`, 422);
        }
      }
      if (t.length && t[t.length - 1].hasta != null) {
        return fail(c, 'El último tramo tiene que quedar abierto (sin tope): si no, un salario '
          + 'por encima de ese monto no paga impuesto.', 422);
      }
      cfg.renta.tramos = t;
    }

    const tasas = await guardarTasas(c.get('tenantId'), cfg, c.get('userId'));
    return ok(c, { tasas, resumen: resumenCargas(tasas) });
  } catch (err: any) { return fail(c, err.message, 422); }
});

/**
 * POST /payroll/recalcular — la planilla con los ajustes hechos a mano.
 *
 * ── Por qué esto es un endpoint y no una cuenta en el navegador ──────────
 * La pantalla deja ajustar bonificaciones y adelantos. Para mostrar el neto
 * correcto habría que repetir en el navegador los tramos del impuesto, los
 * créditos familiares, las deducciones de cada empleado y la base mínima
 * contributiva. Dos implementaciones del mismo cálculo se separan: una se
 * arregla y la otra no, y nadie sabe cuál de los dos netos es el que se va a
 * pagar.
 *
 * Hay UN motor, y vive en el servidor. La pantalla pregunta.
 */
hr.post('/payroll/recalcular', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({} as any));
    const from = String(b?.period_start ?? '').slice(0, 10);
    const to = String(b?.period_end ?? '').slice(0, 10);
    if (!from || !to) return fail(c, 'Faltan las fechas del período.', 422);
    const items: any[] = Array.isArray(b?.items) ? b.items : [];
    if (!items.length) return fail(c, 'No hay líneas que recalcular.', 422);

    const tasas = await cargarTasas(tenantId);
    const empIds = items.map(i => i.employee_id).filter(Boolean) as string[];
    const dedPorEmp = await deduccionesDe(tenantId, empIds);

    const fichas = new Map<string, any>();
    if (empIds.length) {
      try {
        const { data } = await db.from('employees')
          .select('id, dependents_children, has_spouse, tax_exempt')
          .eq('tenant_id', tenantId).in('id', empIds);
        for (const e of ((data ?? []) as any[])) fichas.set(String(e.id), e);
      } catch { /* sin la migración 149 */ }
    }

    const calculadas = items.map(i => {
      const bruto = redondo(
        (Number(i.base_amount) || 0) + (Number(i.commission_amount) || 0) + (Number(i.bonuses) || 0));
      const ficha = i.employee_id ? fichas.get(String(i.employee_id)) : null;
      const r = calcularLinea({
        bruto, tasas,
        deducciones: i.employee_id ? (dedPorEmp.get(String(i.employee_id)) ?? []) : [],
        adelantos: Number(i.advances) || 0,
        otros: Number(i.other_deductions) || 0,
        hijos: Number(ficha?.dependents_children) || 0,
        conyuge: ficha?.has_spouse === true,
        exento_renta: ficha?.tax_exempt === true,
        desde: from, hasta: to,
      });
      return { i, r };
    });

    const lineas = calculadas.map(({ i, r }) => ({
      ...i,
      gross: r.bruto,
      employee_charges: r.obrero,
      employee_charges_detail: r.obrero_detalle,
      income_tax: r.renta,
      income_tax_detail: r.renta_detalle,
      other_deductions_total: r.deducciones,
      deductions_detail: r.deducciones_detalle,
      employer_charges: r.patronal,
      employer_charges_detail: r.patronal_detalle,
      ins_amount: r.ins,
      contribution_base: r.base_contributiva,
      net: r.neto,
      avisos: r.avisos,
    }));

    return ok(c, {
      from, to, lineas,
      totales: totalizar(calculadas.map(x => x.r)),
      cargas: resumenCargas(tasas),
      tasas,
      factor: factorDelPeriodo(from, to),
    });
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

    /**
     * Se recalcula TODO acá: el navegador manda las líneas, pero las cargas,
     * el impuesto y las deducciones no se le creen a nadie de afuera.
     *
     * Lo que sí se respeta del navegador es lo que una persona ajustó a mano:
     * el salario base, la comisión, las bonificaciones y los adelantos. Las
     * cuotas y el impuesto se derivan de eso.
     */
    const tasas = await cargarTasas(tenantId);
    const empIds = items.map(i => i.employee_id).filter(Boolean) as string[];
    const dedPorEmp = await deduccionesDe(tenantId, empIds);

    /* Los datos del expediente que entran en el impuesto. Vienen de la base y
       no del navegador: cuántos hijos declara alguien no se manda por JSON. */
    const fichas = new Map<string, any>();
    if (empIds.length) {
      try {
        const { data } = await db.from('employees')
          .select('id, dependents_children, has_spouse, tax_exempt')
          .eq('tenant_id', tenantId).in('id', empIds);
        for (const e of ((data ?? []) as any[])) fichas.set(String(e.id), e);
      } catch { /* sin la migración 149: sin créditos ni exenciones */ }
    }

    const calculadas = items.map(i => {
      const bruto = redondo(i.base_amount + (i.commission_amount ?? 0) + (i.bonuses ?? 0));
      const ficha = i.employee_id ? fichas.get(String(i.employee_id)) : null;
      const r = calcularLinea({
        bruto, tasas,
        deducciones: i.employee_id ? (dedPorEmp.get(String(i.employee_id)) ?? []) : [],
        adelantos: i.advances ?? 0,
        otros: i.other_deductions ?? 0,
        hijos: Number(ficha?.dependents_children) || 0,
        conyuge: ficha?.has_spouse === true,
        exento_renta: ficha?.tax_exempt === true,
        desde: period_start, hasta: period_end,
      });
      return { linea: { ...i, tenant_id: tenantId, gross: bruto }, r };
    });

    const tot = totalizar(calculadas.map(x => x.r));

    const filaRun = conDesglose({
      tenant_id: tenantId,
      branch_id: branch_id ?? null,
      period_start, period_end, notes: notes ?? null,
      status: 'draft',
      gross: tot.gross,
      employee_charges: tot.employee_charges,
      other_deductions: tot.other_deductions,
      employer_charges: tot.employer_charges,
      net: tot.net,
      total_cost: tot.total_cost,
      employees_count: tot.employees_count,
      created_by: c.get('userId') ?? null,
    }, {
      employee_charges_detail: tot.employee_charges_detail,
      employer_charges_detail: tot.employer_charges_detail,
      other_deductions_detail: tot.other_deductions_detail,
      income_tax: tot.income_tax,
      ins_amount: tot.ins_amount,
      /* Las tasas del día, congeladas. Cuando el IVM suba en enero, esta
         planilla tiene que seguir explicando con qué números se hizo. */
      rates_snapshot: tasas,
    });

    let { data: run, error } = await db.from('payroll_runs').insert(filaRun).select().single();
    if (error && sinColumna(error)) {
      ({ data: run, error } = await db.from('payroll_runs').insert(soloBase(filaRun)).select().single());
    }
    if (error) throw new Error(error.message);

    const filas = calculadas.map(({ linea, r }) => conDesglose({
      ...linea, run_id: (run as any).id,
      employee_charges: r.obrero,
      net: r.neto,
    }, {
      employee_charges_detail: r.obrero_detalle,
      income_tax: r.renta,
      income_tax_detail: r.renta_detalle,
      deductions_detail: r.deducciones_detalle,
      employer_charges: r.patronal,
      employer_charges_detail: r.patronal_detalle,
      ins_amount: r.ins,
      contribution_base: r.base_contributiva,
    }));

    let eItems = (await db.from('payroll_items').insert(filas)).error;
    if (eItems && sinColumna(eItems)) {
      /* Sin la migración 149 las columnas del desglose no existen. La
         planilla se guarda igual con los totales —que es lo que se paga— en
         vez de fallar entera; el desglose aparece cuando la migración corra. */
      eItems = (await db.from('payroll_items').insert(filas.map(soloBase))).error;
    }
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
          + `cargas patronales ₡${(run as any).employer_charges}`
          + ((run as any).ins_amount ? ` · INS riesgos del trabajo ₡${(run as any).ins_amount}` : '')
          + ((run as any).income_tax ? ` · renta retenida ₡${(run as any).income_tax}` : ''),
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

    /**
     * Los préstamos bajan su saldo ACÁ y no al calcular.
     *
     * Una planilla en borrador se recalcula varias veces antes de pagarse. Si
     * el saldo bajara en cada cálculo, el préstamo quedaría saldado sin que
     * nadie le haya rebajado nada.
     */
    let abonos = { abonadas: 0, saldadas: 0 };
    try {
      const { data: items } = await db.from('payroll_items')
        .select('deductions_detail').eq('run_id', id);
      abonos = await abonarDeducciones(tenantId, (items ?? []) as any[]);
    } catch { /* sin la migración 149 no hay deducciones que abonar */ }

    return ok(c, { ...(data as any), expense_id: expenseId, abonos });
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
/* ───────────────────────── FICHAJE ─────────────────────────────────────── */

/**
 * POST /attendance/mark — marcar con CÓDIGO.
 *
 * El código identifica a la persona en el servidor. El endpoint viejo
 * (`/attendance/clock-in`) recibía el `employee_id` en el cuerpo y marcaba sin
 * preguntar: con la pantalla abierta en la entrada del local, cualquiera podía
 * marcarle la hora a un compañero que todavía no llegaba. Se deja andando por
 * compatibilidad, pero lo que usa la pantalla nueva es esto.
 */
hr.post('/attendance/mark', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const body = await c.req.json().catch(() => ({} as any));
    const pin = String(body?.pin ?? '').trim();
    if (!/^\d{4,8}$/.test(pin)) return fail(c, 'El código es de 4 a 8 dígitos', 422);

    const empleado = await empleadoPorPin(tenantId, pin);
    // Mismo mensaje para «no existe» y «está inactivo»: decir cuál de las dos
    // es ayuda a quien está probando códigos ajenos.
    if (!empleado) return fail(c, 'Código no reconocido', 404);

    const r = await marcar({
      tenantId,
      empleado: { id: empleado.id, full_name: empleado.full_name, position: empleado.position },
      metodo: 'pin',
      device: String(body?.device ?? '').slice(0, 80) || null,
    });
    return ok(c, r, 201);
  } catch (err: any) { return fail(c, err.message, 400); }
});

/** PUT /employees/:id/pin — poner o cambiar el código de un empleado. */
hr.put('/employees/:id/pin', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({} as any));
    const pin = String(body?.pin ?? '').trim();
    if (!/^\d{4,8}$/.test(pin)) return fail(c, 'El código es de 4 a 8 dígitos', 422);

    // Dos empleados con el mismo código harían que el fichaje marcara al que
    // apareciera primero en la lista. Se revisa antes de guardar.
    const yaEs = await empleadoPorPin(tenantId, pin);
    if (yaEs && String(yaEs.id) !== String(id)) {
      return fail(c, `Ese código ya lo usa ${yaEs.full_name}. Elegí otro.`, 409);
    }

    const { error } = await db.from('employees')
      .update({ attendance_pin_hash: hashPin(pin), attendance_pin_set_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId);
    if (error) {
      if (/attendance_pin_hash/i.test(error.message)) {
        return fail(c, 'Falta correr la migración 125 (fichaje) en la base.', 400);
      }
      throw new Error(error.message);
    }
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/* ── Huella / FaceID ──────────────────────────────────────────────────────
 * Cuatro pasos: el empleado REGISTRA su aparato (una vez, identificándose con
 * su código) y después FICHA con el dedo. El navegador exige HTTPS.
 */

/** POST /attendance/biometria/registro/opciones — body: { pin } */
hr.post('/attendance/biometria/registro/opciones', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const { pin } = await c.req.json().catch(() => ({} as any));
    // Se registra el aparato CON EL CÓDIGO: si bastara con estar logueado,
    // cualquiera registraría su dedo a nombre de otro empleado.
    const empleado = await empleadoPorPin(tenantId, String(pin ?? ''));
    if (!empleado) return fail(c, 'Código no reconocido', 404);
    const options = await opcionesRegistro(c, tenantId, empleado);
    return ok(c, { options, employee_id: empleado.id, nombre: empleado.full_name });
  } catch (err: any) { return fail(c, err.message, 400); }
});

/** POST /attendance/biometria/registro — body: { employee_id, respuesta, etiqueta } */
hr.post('/attendance/biometria/registro', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({} as any));
    await verificarRegistro(c, tenantId, String(b?.employee_id ?? ''), b?.respuesta, b?.etiqueta);
    return ok(c, { ok: true });
  } catch (err: any) { return fail(c, err.message, 400); }
});

/** POST /attendance/biometria/opciones — desafío para fichar. */
hr.post('/attendance/biometria/opciones', async (c) => {
  try {
    return ok(c, await opcionesFichaje(c, c.get('tenantId')));
  } catch (err: any) { return fail(c, err.message, 400); }
});

/** POST /attendance/biometria/marcar — body: { respuesta } */
hr.post('/attendance/biometria/marcar', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const b = await c.req.json().catch(() => ({} as any));
    const empleado = await verificarFichaje(c, tenantId, b?.respuesta);
    const r = await marcar({
      tenantId,
      empleado: { id: empleado.id, full_name: empleado.full_name, position: empleado.position },
      metodo: 'biometria',
      device: String(b?.device ?? '').slice(0, 80) || null,
    });
    return ok(c, r, 201);
  } catch (err: any) { return fail(c, err.message, 400); }
});

/** GET /attendance/today — quién marcó hoy, para la pantalla del tablero. */
hr.get('/attendance/today', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const dia = hoyCR();
    const { data: regs } = await db.from('attendance_records')
      .select('employee_id, clock_in, clock_out, hours_worked')
      .eq('tenant_id', tenantId).eq('date', dia);
    const ids = (regs ?? []).map((r: any) => r.employee_id);
    const { data: emps } = ids.length
      ? await db.from('employees').select('id, full_name, position').in('id', ids)
      : { data: [] as any[] };
    const porId = new Map((emps ?? []).map((e: any) => [String(e.id), e]));
    return ok(c, {
      date: dia,
      marcajes: (regs ?? []).map((r: any) => ({
        employee_id: r.employee_id,
        nombre: porId.get(String(r.employee_id))?.full_name ?? 'Empleado',
        puesto: porId.get(String(r.employee_id))?.position ?? null,
        entrada: r.clock_in, salida: r.clock_out, horas: r.hours_worked,
      })).sort((a: any, b: any) => String(a.entrada).localeCompare(String(b.entrada))),
    });
  } catch (err: any) { return fail(c, err.message, 500); }
});

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

// ══════════════════════════════════════════════════════════════════════════
// LAS DEDUCCIONES DE CADA EMPLEADO
// ══════════════════════════════════════════════════════════════════════════

const TIPOS_DEDUCCION = [
  'prestamo', 'solidarista', 'cooperativa', 'pension_alimentaria',
  'embargo', 'ahorro', 'asociacion', 'otro',
] as const;

const DeduccionSchema = z.object({
  tipo: z.enum(TIPOS_DEDUCCION),
  label: z.string().min(1, 'Ponele un nombre a la deducción.'),
  modo: z.enum(['fijo', 'porcentaje']).default('fijo'),
  monto: z.number().min(0).optional().default(0),
  pct: z.number().min(0).max(100).optional().default(0),
  tope: z.number().min(0).optional().nullable(),
  saldo_total: z.number().min(0).optional().nullable(),
  desde: z.string().optional().nullable(),
  hasta: z.string().optional().nullable(),
  notas: z.string().optional().nullable(),
});

/** GET /employees/:id/deductions */
hr.get('/employees/:id/deductions', async (c) => {
  try {
    const { data, error } = await db.from('employee_deductions')
      .select('*').eq('tenant_id', c.get('tenantId')).eq('employee_id', c.req.param('id'))
      .order('created_at', { ascending: false });
    if (error) {
      if (sinColumna(error) || /does not exist|Could not find the table/i.test(error.message)) {
        return ok(c, { sin_tabla: true, deducciones: [] });
      }
      throw new Error(error.message);
    }
    return ok(c, { deducciones: data ?? [] });
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** POST /employees/:id/deductions */
hr.post('/employees/:id/deductions', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    const employeeId = c.req.param('id');
    const parsed = DeduccionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? 'Datos inválidos', 422);
    const d = parsed.data;

    if (d.modo === 'fijo' && d.monto <= 0) {
      return fail(c, 'Una deducción de monto fijo necesita un monto mayor que cero.', 422);
    }
    if (d.modo === 'porcentaje' && d.pct <= 0) {
      return fail(c, 'Una deducción por porcentaje necesita un porcentaje mayor que cero.', 422);
    }
    /* Un préstamo sin saldo no se detiene nunca. Se exige el total para que
       la última cuota sea lo que falta y la deducción se apague sola. */
    if (d.tipo === 'prestamo' && !(Number(d.saldo_total) > 0)) {
      return fail(c, 'Un préstamo necesita el monto total que se va a rebajar. Es lo que hace que '
        + 'la deducción se detenga sola cuando queda saldado, en vez de seguir rebajando para siempre.', 422);
    }

    const { data: emp } = await db.from('employees')
      .select('id').eq('tenant_id', tenantId).eq('id', employeeId).maybeSingle();
    if (!emp) return fail(c, 'Empleado no encontrado', 404);

    const { data, error } = await db.from('employee_deductions').insert({
      tenant_id: tenantId, employee_id: employeeId,
      tipo: d.tipo, label: d.label.trim(), modo: d.modo,
      monto: d.monto, pct: d.pct,
      tope: d.tope ?? null,
      saldo_total: d.saldo_total ?? null,
      saldo_restante: d.saldo_total ?? null,
      desde: d.desde || null, hasta: d.hasta || null,
      notas: d.notas || null,
      created_by: c.get('userId') ?? null,
    }).select().single();
    if (error) {
      if (/does not exist|Could not find the table/i.test(error.message)) {
        return fail(c, 'Falta correr la migración 149_planilla_deducciones.sql.', 422);
      }
      throw new Error(error.message);
    }
    return ok(c, data, 201);
  } catch (err: any) { return fail(c, err.message, 500); }
});

/** PUT /deductions/:id — cambiar una deducción (incluido apagarla). */
hr.put('/deductions/:id', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const campos: Record<string, any> = {};
    for (const k of ['label', 'modo', 'monto', 'pct', 'tope', 'saldo_restante', 'desde', 'hasta', 'activo', 'notas']) {
      if (body[k] !== undefined) campos[k] = body[k];
    }
    if (!Object.keys(campos).length) return fail(c, 'No hay nada que cambiar.', 422);
    const { data, error } = await db.from('employee_deductions')
      .update(campos).eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'))
      .select().single();
    if (error) throw new Error(error.message);
    return ok(c, data);
  } catch (err: any) { return fail(c, err.message, 422); }
});

/**
 * DELETE /deductions/:id
 *
 * Borra de verdad, y está bien: una deducción es una instrucción a futuro,
 * no un hecho. Lo que de verdad se rebajó ya quedó congelado en la planilla
 * de cada mes, así que borrarla no cambia ningún pago pasado.
 */
hr.delete('/deductions/:id', async (c) => {
  try {
    const { error } = await db.from('employee_deductions')
      .delete().eq('id', c.req.param('id')).eq('tenant_id', c.get('tenantId'));
    if (error) throw new Error(error.message);
    return ok(c, { deleted: true });
  } catch (err: any) { return fail(c, err.message, 422); }
});

export default hr;
