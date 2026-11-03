-- 131 · TALLER 3D y ENVÍOS DEL EQUIPO
--
-- Dos módulos para un taller de impresión 3D:
--
--  · Taller 3D — lo que se vendió y lo que se gastó HOY, anotado a mano (en
--    este negocio la venta no pasa por la caja: se cotiza por WhatsApp y se
--    cobra por SINPE), y la cola de impresiones con su planificador.
--  · Envíos del equipo — lo que cada empleado deja anotado para mandar y a
--    quién hay que contactar.
--
-- Por qué tablas propias y no `invoices`/`expenses`: una factura mueve
-- inventario, consecutivos, cuentas por cobrar e impuestos. Lo que se anota acá
-- es una bitácora del día; meterlo en facturas obligaría a inventar clientes y
-- consecutivos para cada apunte, y ensuciaría los reportes fiscales con cosas
-- que no son comprobantes.

-- ── Ventas del día ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.taller_ventas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  fecha          DATE NOT NULL,
  descripcion    TEXT NOT NULL,
  cliente        TEXT,
  -- Cantidad y precio van aparte del total para poder desglosar: «3 llaveros a
  -- ₡2.500» dice mucho más que «₡7.500».
  cantidad       NUMERIC(12,2) NOT NULL DEFAULT 1,
  precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  total          NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- efectivo | sinpe | tarjeta | transferencia | otro
  medio_pago     TEXT NOT NULL DEFAULT 'efectivo',
  -- impresion | diseno | material | reparacion | otro
  categoria      TEXT NOT NULL DEFAULT 'impresion',
  notas          TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS taller_ventas_dia ON public.taller_ventas (tenant_id, fecha);

-- ── Gastos del día ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.taller_gastos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  fecha       DATE NOT NULL,
  descripcion TEXT NOT NULL,
  -- filamento | resina | electricidad | repuestos | envio | otro
  categoria   TEXT NOT NULL DEFAULT 'filamento',
  monto       NUMERIC(12,2) NOT NULL DEFAULT 0,
  medio_pago  TEXT NOT NULL DEFAULT 'efectivo',
  proveedor   TEXT,
  notas       TEXT,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS taller_gastos_dia ON public.taller_gastos (tenant_id, fecha);

-- ── Las impresoras ─────────────────────────────────────────────────────────
-- Cada una es una máquina real. El planificador reparte el trabajo entre las
-- que estén activas: con una sola, la cola es una fila; con tres, tres filas.
CREATE TABLE IF NOT EXISTS public.impresoras (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  nombre     TEXT NOT NULL,
  notas      TEXT,
  activa     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS impresoras_tenant ON public.impresoras (tenant_id, activa);

-- ── La cola de impresión ───────────────────────────────────────────────────
-- `horas` es lo que dura UNA unidad. El planificador calcula inicio y fin
-- reales; nadie los escribe a mano, porque en cuanto entra un trabajo urgente
-- todo lo de atrás se corre y escribirlo a mano sería mentira a los dos días.
CREATE TABLE IF NOT EXISTS public.impresiones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  pieza         TEXT NOT NULL,
  cliente       TEXT,
  customer_id   UUID,
  cantidad      INTEGER NOT NULL DEFAULT 1,
  horas         NUMERIC(8,2) NOT NULL DEFAULT 1,
  material      TEXT,
  color         TEXT,
  -- 0 normal · 1 urgente. El urgente se planifica primero, no se cuela a mitad
  -- de una impresión ya empezada: parar una pieza a medias la arruina.
  prioridad     INTEGER NOT NULL DEFAULT 0,
  -- en_cola | programado | imprimiendo | listo | entregado | cancelado
  estado        TEXT NOT NULL DEFAULT 'en_cola',
  impresora_id  UUID REFERENCES public.impresoras(id) ON DELETE SET NULL,
  inicio        TIMESTAMPTZ,
  fin           TIMESTAMPTZ,
  entrega_estimada DATE,
  -- Para cuándo lo necesita el cliente. Si el plan no llega, se avisa.
  fecha_limite  DATE,
  notas         TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS impresiones_cola ON public.impresiones (tenant_id, estado, prioridad DESC, created_at);
CREATE INDEX IF NOT EXISTS impresiones_dia ON public.impresiones (tenant_id, entrega_estimada);

-- ── Envíos que deja anotados el equipo ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.envios_pendientes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  cliente       TEXT NOT NULL,
  customer_id   UUID,
  telefono      TEXT,
  direccion     TEXT,
  detalle       TEXT,
  -- correos | uber | mensajero | retiro | otro
  medio         TEXT NOT NULL DEFAULT 'correos',
  -- pendiente | enviado | entregado | cancelado
  estado        TEXT NOT NULL DEFAULT 'pendiente',
  fecha         DATE NOT NULL,
  -- Quién lo anotó. Es el dato que faltaba para poder preguntar después.
  registrado_por     UUID,
  registrado_nombre  TEXT,
  despachado_por     UUID,
  despachado_nombre  TEXT,
  despachado_at      TIMESTAMPTZ,
  guia          TEXT,
  impresion_id  UUID REFERENCES public.impresiones(id) ON DELETE SET NULL,
  notas         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS envios_dia ON public.envios_pendientes (tenant_id, fecha, estado);

-- ── Clientes a los que hay que escribirles ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contactos_pendientes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  cliente     TEXT NOT NULL,
  customer_id UUID,
  telefono    TEXT,
  motivo      TEXT,
  -- pendiente | hecho
  estado      TEXT NOT NULL DEFAULT 'pendiente',
  fecha       DATE NOT NULL,
  registrado_por    UUID,
  registrado_nombre TEXT,
  hecho_por   UUID,
  hecho_nombre TEXT,
  hecho_at    TIMESTAMPTZ,
  resultado   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contactos_dia ON public.contactos_pendientes (tenant_id, fecha, estado);

NOTIFY pgrst, 'reload schema';
