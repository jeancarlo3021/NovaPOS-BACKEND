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
});

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
      .insert({ ...parsed.data, tenant_id: tenantId })
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
      .update(parsed.data)
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

export default hr;
