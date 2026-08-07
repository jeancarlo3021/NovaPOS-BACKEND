-- Consecutivos de Hacienda: UNO POR TIPO DE COMPROBANTE.
--
-- ── El problema ────────────────────────────────────────────────────────────
-- Todos los comprobantes armaban su consecutivo con el MISMO `invoice_number`:
--
--   Factura 000145  → 001 00001 01 0000000145
--   Tiquete 000146  → 001 00001 04 0000000146
--   NC de la 145    → 001 00001 03 0000000145   ← el número de la FACTURA
--
-- Dos consecuencias, y la segunda es la grave:
--
--  1) Facturas y tiquetes comparten la secuencia, así que cada tipo queda con
--     huecos (145, 147, 150…). Hacienda espera numeración consecutiva por tipo.
--
--  2) La NC y la ND toman el número del documento que corrigen. Si a una misma
--     factura se le emite una NC y una ND —o dos NC— las dos salen con el mismo
--     consecutivo y Hacienda rechaza con -99 «numeración consecutiva repetida».
--
-- ── La solución ────────────────────────────────────────────────────────────
-- Un contador propio por (empresa, sucursal, terminal, tipo), servido por una
-- función atómica. Tiene que ser atómico de verdad: dos cajas facturando en el
-- mismo segundo con un SELECT-luego-UPDATE se llevan el mismo número.

CREATE TABLE IF NOT EXISTS public.fe_consecutivos (
  tenant_id   UUID    NOT NULL,
  sucursal    TEXT    NOT NULL DEFAULT '001',
  terminal    TEXT    NOT NULL DEFAULT '00001',
  tipo        TEXT    NOT NULL,          -- 01 factura · 02 ND · 03 NC · 04 tiquete
  last_number BIGINT  NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, sucursal, terminal, tipo)
);

COMMENT ON TABLE public.fe_consecutivos IS
  'Último consecutivo emitido por empresa/sucursal/terminal/tipo de comprobante.';

-- ── Función atómica ────────────────────────────────────────────────────────
-- `p_floor` es el consecutivo inicial configurado en Datos de FE (para seguir la
-- numeración de un sistema anterior): el resultado nunca queda por debajo.
--
-- El INSERT ... ON CONFLICT DO UPDATE toma el lock de la fila y hace el
-- incremento en una sola sentencia, así que dos cajas simultáneas obtienen
-- números distintos sin que haya que coordinarlas.
CREATE OR REPLACE FUNCTION public.next_fe_consecutivo(
  p_tenant   UUID,
  p_tipo     TEXT,
  p_floor    BIGINT DEFAULT 0,
  p_sucursal TEXT   DEFAULT '001',
  p_terminal TEXT   DEFAULT '00001'
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next BIGINT;
BEGIN
  INSERT INTO public.fe_consecutivos AS f (tenant_id, sucursal, terminal, tipo, last_number)
  VALUES (p_tenant, p_sucursal, p_terminal, p_tipo, GREATEST(p_floor, 1))
  ON CONFLICT (tenant_id, sucursal, terminal, tipo) DO UPDATE
    SET last_number = GREATEST(f.last_number + 1, p_floor),
        updated_at  = NOW()
  RETURNING f.last_number INTO v_next;

  RETURN v_next;
END;
$$;

-- ── Arranque desde lo ya emitido ───────────────────────────────────────────
-- Sin esto, el primer comprobante después de la migración volvería a 1 y
-- chocaría con todo lo ya enviado a Hacienda.
-- El CASE va repetido en el GROUP BY en vez de por número de columna: los
-- literales '001' y '00001' también cuentan como columnas, así que un ordinal
-- acá apunta al lugar equivocado.
INSERT INTO public.fe_consecutivos (tenant_id, sucursal, terminal, tipo, last_number)
SELECT
  i.tenant_id,
  '001', '00001',
  CASE
    WHEN i.document_type = 'tiquete_electronico' THEN '04'
    ELSE '01'
  END AS tipo,
  COALESCE(MAX(NULLIF(regexp_replace(COALESCE(i.invoice_number, ''), '\D', '', 'g'), '')::BIGINT), 0)
FROM public.invoices i
WHERE i.fe_clave IS NOT NULL
GROUP BY
  i.tenant_id,
  CASE
    WHEN i.document_type = 'tiquete_electronico' THEN '04'
    ELSE '01'
  END
ON CONFLICT (tenant_id, sucursal, terminal, tipo) DO NOTHING;

-- Las NC y ND arrancan del mayor número que ya se les haya asignado. Como antes
-- reusaban el de la factura, se parte del máximo global para no repetir ninguno.
INSERT INTO public.fe_consecutivos (tenant_id, sucursal, terminal, tipo, last_number)
SELECT i.tenant_id, '001', '00001', t.tipo,
       COALESCE(MAX(NULLIF(regexp_replace(COALESCE(i.invoice_number, ''), '\D', '', 'g'), '')::BIGINT), 0)
FROM public.invoices i
CROSS JOIN (VALUES ('02'), ('03')) AS t(tipo)
WHERE i.fe_nc_clave IS NOT NULL OR i.fe_nd_clave IS NOT NULL
GROUP BY i.tenant_id, t.tipo
ON CONFLICT (tenant_id, sucursal, terminal, tipo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
