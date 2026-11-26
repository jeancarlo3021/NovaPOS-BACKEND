-- CONTABILIDAD — LAS RAMAS QUE FALTABAN
--
-- Hasta aquí el módulo tenía catálogo, diario, mayor y los tres informes.
-- Eso cubre el REGISTRO, pero no el ciclo contable completo: faltaban las
-- dos cosas que un contador hace sí o sí y que no se pueden calcular al aire
-- porque hay que GUARDAR una decisión:
--
--   · los ACTIVOS FIJOS, porque la depreciación de este mes depende de qué
--     vida útil se le asignó al equipo cuando se compró, y eso es un dato,
--     no una fórmula;
--   · el CIERRE DE PERIODO, porque «este mes ya está cerrado» es un hecho
--     con fecha y responsable, y sin guardarlo cualquiera mete un asiento en
--     un mes ya declarado y el informe que se presentó deja de ser cierto.
--
-- El IVA, la antigüedad de saldos y el flujo de caja NO llevan tabla: se
-- calculan de lo que ya está registrado. Una tabla ahí solo sería una copia
-- que se desactualiza.

-- ══════════════════════════════════════════════════════════════════════════
-- ACTIVOS FIJOS
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fixed_assets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  nombre         TEXT NOT NULL,
  -- mobiliario | computo | vehiculo | maquinaria | edificio | otro
  categoria      TEXT NOT NULL DEFAULT 'otro',
  fecha_compra   DATE NOT NULL,
  costo          NUMERIC(14,2) NOT NULL,
  /**
   * Valor residual: lo que se espera que valga al final de su vida útil.
   *
   * Se deprecia (costo − residual), no el costo. Un vehículo que al final
   * se vende por chatarra no se deprecia hasta cero.
   */
  valor_residual NUMERIC(14,2) NOT NULL DEFAULT 0,
  /** Vida útil en MESES. En meses y no en años porque la depreciación se
   *  corre por mes, y 3 años son 36 cuotas exactas sin redondeos raros. */
  vida_meses     INTEGER NOT NULL,
  -- Las cuentas del catálogo que mueve este activo.
  cuenta_activo  TEXT NOT NULL DEFAULT '1201',
  cuenta_acum    TEXT NOT NULL DEFAULT '1290',
  cuenta_gasto   TEXT NOT NULL DEFAULT '5208',
  notas          TEXT,
  /** Baja: vendido, robado, descartado. No se borra el activo, porque su
   *  depreciación ya está en meses cerrados y hay que poder explicarla. */
  baja_fecha     DATE,
  baja_motivo    TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fixed_assets_tenant_idx ON public.fixed_assets (tenant_id, fecha_compra);

/**
 * La depreciación YA CORRIDA, un renglón por activo y por mes.
 *
 * El índice único es la pieza importante: sin él, correr la depreciación dos
 * veces en el mismo mes duplica el gasto y nadie lo nota hasta el cierre.
 */
CREATE TABLE IF NOT EXISTS public.fixed_asset_depreciation (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  asset_id   UUID NOT NULL REFERENCES public.fixed_assets(id) ON DELETE CASCADE,
  periodo    TEXT NOT NULL,                 -- 'YYYY-MM'
  monto      NUMERIC(14,2) NOT NULL,
  entry_id   UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, periodo)
);

CREATE INDEX IF NOT EXISTS fad_tenant_idx ON public.fixed_asset_depreciation (tenant_id, periodo);

-- ══════════════════════════════════════════════════════════════════════════
-- CIERRE DE PERIODO
-- ══════════════════════════════════════════════════════════════════════════

/**
 * Un mes cerrado.
 *
 * Guardar el cierre hace dos cosas: deja el asiento que manda el resultado a
 * resultados acumulados, y cierra la puerta a asientos nuevos con fecha de
 * ese mes. Lo segundo es lo que vale: el informe que se presentó a Hacienda
 * sigue dando el mismo número el mes que viene.
 */
CREATE TABLE IF NOT EXISTS public.accounting_periods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  periodo     TEXT NOT NULL,                -- 'YYYY-MM'
  utilidad    NUMERIC(14,2) NOT NULL DEFAULT 0,
  ingresos    NUMERIC(14,2) NOT NULL DEFAULT 0,
  gastos      NUMERIC(14,2) NOT NULL DEFAULT 0,
  entry_id    UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  cerrado_por UUID,
  cerrado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, periodo)
);

CREATE INDEX IF NOT EXISTS accounting_periods_idx ON public.accounting_periods (tenant_id, periodo);

NOTIFY pgrst, 'reload schema';
