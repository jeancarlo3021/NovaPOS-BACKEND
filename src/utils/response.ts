import type { Context } from 'hono';

export const ok = (c: Context, data: unknown, status = 200) =>
  c.json({ data, error: null }, status as any);

export const fail = (c: Context, message: string, status = 400) =>
  c.json({ data: null, error: message }, status as any);
