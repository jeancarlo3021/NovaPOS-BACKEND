-- MÓDULO CONTABLE — Etapa 1 (datos) y Etapa 2 (partida doble).
--
-- ══ POR QUÉ LAS DOS COSAS EN LA MISMA MIGRACIÓN ═══════════════════════════
-- La contabilidad no se puede armar sobre los datos que hay hoy. Medido:
--   · `expenses` no guarda el impuesto → sin eso no hay crédito fiscal, y el
--     gasto entra por el bruto: el IVA pagado se pierde como si fuera costo.
--   · `purchases` tampoco → lo mismo con las compras.
--   · `stock_movements` no guarda el COSTO de la salida → sin eso no hay
--     costo de ventas, y un estado de resultados con ingresos y sin costos
--     muestra una ganancia que no existe.
-- Poner las tablas contables sin cerrar esos huecos daría una contabilidad
-- prolija y equivocada, que es peor que no tenerla.

-- ══════════════════════════════════════════════════════════════════════════
-- ETAPA 1 — LOS DATOS QUE FALTABAN
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.expenses
  -- El impuesto, aparte del monto. `amount` sigue siendo el TOTAL para no
  -- romper nada de lo que ya lo lee; el impuesto se guarda al lado.
  ADD COLUMN IF NOT EXISTS tax_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplier_id    UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  -- Tipo de documento de Hacienda: 01 factura, 04 tiquete, 03 NC…
  ADD COLUMN IF NOT EXISTS document_type  TEXT,
  -- Clave de 50 dígitos del comprobante electrónico que respalda el gasto.
  ADD COLUMN IF NOT EXISTS fe_clave       TEXT;

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS tax_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS document_type  TEXT,
  ADD COLUMN IF NOT EXISTS fe_clave       TEXT;

ALTER TABLE public.stock_movements
  -- Costo UNITARIO al momento del movimiento. Es la pieza que falta para el
  -- costo de ventas: el costo de hoy del producto no sirve, porque lo que se
  -- vendió en marzo se vendió al costo de marzo.
  ADD COLUMN IF NOT EXISTS unit_cost      NUMERIC(14,4);

CREATE INDEX IF NOT EXISTS expenses_clave_idx  ON public.expenses (tenant_id, fe_clave);
CREATE INDEX IF NOT EXISTS purchases_clave_idx ON public.purchases (tenant_id, fe_clave);

-- ══════════════════════════════════════════════════════════════════════════
-- ETAPA 2 — CATÁLOGO DE CUENTAS Y PARTIDA DOBLE
-- ══════════════════════════════════════════════════════════════════════════

/**
 * EL CATÁLOGO DE CUENTAS, uno por negocio.
 *
 * Por negocio y no uno solo compartido: una soda y una ferretería no tienen
 * las mismas cuentas, y el contador de cada uno quiere poder agregar las
 * suyas sin tocarle el catálogo a nadie más.
 */
CREATE TABLE IF NOT EXISTS public.chart_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Código jerárquico: 1 activo, 11 circulante, 1101 caja…
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  -- activo | pasivo | patrimonio | ingreso | gasto
  type        TEXT NOT NULL,
  /**
   * Si acepta movimientos.
   *
   * Las cuentas de agrupación (1, 11) NO: existen para sumar a sus hijas. Sin
   * esta marca, alguien carga un asiento en «Activo» y el balance cuadra pero
   * no dice nada.
   */
  postable    BOOLEAN NOT NULL DEFAULT TRUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS chart_accounts_tenant_idx ON public.chart_accounts (tenant_id, code);

/**
 * EL LIBRO DIARIO. Un asiento por hecho económico.
 *
 * `source_type` + `source_id` atan el asiento a lo que lo generó (una venta,
 * un gasto). Es lo que permite dos cosas que sin eso no se pueden: no
 * contabilizar dos veces la misma factura, y poder ir del número del balance
 * al documento que lo originó.
 */
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  numero      INTEGER NOT NULL,
  fecha       DATE NOT NULL,
  descripcion TEXT NOT NULL,
  -- venta | gasto | compra | manual | apertura | ajuste
  source_type TEXT,
  source_id   UUID,
  /** Un asiento anulado NO se borra: se marca y se contra-asienta. */
  anulado     BOOLEAN NOT NULL DEFAULT FALSE,
  anula_a     UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, numero)
);

-- Un documento se contabiliza UNA sola vez. El índice lo garantiza aunque dos
-- procesos corran a la vez, que es justo cuando pasa.
CREATE UNIQUE INDEX IF NOT EXISTS journal_source_unico
  ON public.journal_entries (tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND anulado = FALSE;

CREATE INDEX IF NOT EXISTS journal_fecha_idx ON public.journal_entries (tenant_id, fecha);

CREATE TABLE IF NOT EXISTS public.journal_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    UUID NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  code        TEXT NOT NULL,              -- código de la cuenta
  debe        NUMERIC(14,2) NOT NULL DEFAULT 0,
  haber       NUMERIC(14,2) NOT NULL DEFAULT 0,
  detalle     TEXT,
  -- Ni negativos ni una línea que sea las dos cosas: eso no es partida doble.
  CONSTRAINT journal_lines_signos CHECK (debe >= 0 AND haber >= 0 AND (debe = 0 OR haber = 0))
);

CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON public.journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_cuenta_idx ON public.journal_lines (tenant_id, code);

NOTIFY pgrst, 'reload schema';
