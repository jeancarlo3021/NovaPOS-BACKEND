-- BANCOS: cuentas separadas, tarjetas por liquidar y conciliación.
--
-- Resuelve los cinco huecos del análisis. El orden importa: sin cuentas
-- bancarias separadas no hay contra qué conciliar, y sin la cuenta de
-- tarjetas por liquidar el dinero en tránsito no tiene dónde esperar.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. CUENTAS BANCARIAS
-- ══════════════════════════════════════════════════════════════════════════
/**
 * Una fila por cuenta real del negocio.
 *
 * Antes todo caía en la cuenta contable 1102 «Bancos». Con BAC, Banco
 * Nacional y Popular los tres saldos vivían sumados, y comparar un estado de
 * cuenta contra un saldo que mezcla tres bancos es imposible por
 * construcción: la conciliación no fallaba, directamente no se podía hacer.
 *
 * Cada cuenta se ata a su propio código contable (1102-01, 1102-02…), que es
 * lo que permite tener un mayor por banco.
 */
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,              -- «BAC corriente», «BN colones»
  banco        TEXT,                       -- BAC, Banco Nacional, Popular…
  numero       TEXT,                       -- últimos dígitos, para identificarla
  moneda       TEXT NOT NULL DEFAULT 'CRC',
  /** Código en el catálogo de cuentas. Se crea solo al crear la cuenta. */
  code         TEXT NOT NULL,
  /**
   * Para qué métodos de cobro es la cuenta por omisión.
   *
   * Un SINPE y una transferencia pueden entrar a bancos distintos, y el
   * sistema no tiene forma de adivinarlo. Esto lo dice: {'sinpe','transfer'}.
   */
  metodos      TEXT[] NOT NULL DEFAULT '{}',
  activa       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS bank_accounts_tenant_idx ON public.bank_accounts (tenant_id, activa);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. LIQUIDACIONES DE TARJETA
-- ══════════════════════════════════════════════════════════════════════════
/**
 * El depósito que hace el procesador de tarjetas.
 *
 * Una venta con tarjeta NO entra al banco ese día ni por el monto completo:
 * el procesador deposita días después y neto de comisión. Medido en esta
 * base: 259 ventas con tarjeta al mes por ₡3,59 millones; a un 3% son unos
 * ₡107.600 mensuales de comisión que hoy no existen en los libros, y un
 * saldo de Bancos inflado mientras el depósito no llega.
 *
 * Cada fila es un depósito real del procesador, y su asiento mueve el dinero
 * de «Tarjetas por liquidar» a la cuenta bancaria, llevando la comisión a
 * gasto.
 */
CREATE TABLE IF NOT EXISTS public.card_settlements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  fecha           DATE NOT NULL,
  bank_account_id UUID REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  bruto           NUMERIC(14,2) NOT NULL,   -- lo que suman las ventas liquidadas
  comision        NUMERIC(14,2) NOT NULL DEFAULT 0,
  neto            NUMERIC(14,2) NOT NULL,   -- lo que de verdad entró al banco
  referencia      TEXT,
  notas           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS card_settlements_fecha_idx
  ON public.card_settlements (tenant_id, fecha DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. CIERRE DE CAJA: el faltante y el sobrante
-- ══════════════════════════════════════════════════════════════════════════
-- `cash_sessions` guardaba la apertura y el cierre pero NO lo esperado, así
-- que la diferencia no se podía contabilizar sin recalcularla desde las
-- ventas, y ese recálculo no lo hacía nadie.
ALTER TABLE public.cash_sessions
  ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS difference      NUMERIC(14,2);

COMMENT ON COLUMN public.cash_sessions.difference IS
  'Contado menos esperado. Negativo = faltante, positivo = sobrante.';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. CONCILIACIÓN BANCARIA
-- ══════════════════════════════════════════════════════════════════════════
-- Marcar qué movimientos ya aparecieron en el estado del banco. Sin esto, el
-- saldo contable y el real se separan y nadie sabe cuál de los dos está mal.
ALTER TABLE public.journal_lines
  ADD COLUMN IF NOT EXISTS conciliado     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS conciliado_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS journal_lines_concil_idx
  ON public.journal_lines (tenant_id, code, conciliado);

NOTIFY pgrst, 'reload schema';
