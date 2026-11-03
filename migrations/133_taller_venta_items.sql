-- 133 · VARIOS ARTÍCULOS EN UNA MISMA VENTA
--
-- Hasta ahora una venta era UN artículo. Pero el cliente que llega se lleva
-- dos llaveros, un buje y paga un envío: eso es UNA venta, no tres. Anotarlo
-- como tres apuntes obligaba a repetir el cliente y el medio de pago, y hacía
-- imposible saber cuánto gastó esa persona de una sola vez.
--
-- Ahora `taller_ventas` es la cabeza (cliente, medio de pago, envío, total) y
-- las líneas viven acá.
--
-- ── Lo que ya estaba anotado ──────────────────────────────────────────────
-- Las ventas viejas tenían su artículo en las columnas de la cabeza. Esta
-- migración les crea su línea, para que TODAS las ventas se lean igual y
-- ninguna pantalla tenga que preguntarse si es vieja o nueva.

CREATE TABLE IF NOT EXISTS public.taller_venta_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  venta_id    UUID NOT NULL REFERENCES public.taller_ventas(id) ON DELETE CASCADE,
  producto_id UUID REFERENCES public.taller_catalogo(id) ON DELETE SET NULL,
  -- El nombre y la variante se guardan COMO TEXTO: si mañana cambia el
  -- catálogo, el apunte viejo tiene que seguir diciendo qué fue lo que se
  -- vendió y a qué precio.
  descripcion TEXT NOT NULL,
  variante    TEXT,
  cantidad    NUMERIC(12,2) NOT NULL DEFAULT 1,
  precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal    NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS taller_venta_items_venta ON public.taller_venta_items (venta_id);
CREATE INDEX IF NOT EXISTS taller_venta_items_tenant ON public.taller_venta_items (tenant_id, producto_id);

-- Las ventas que ya existían pasan a tener su línea.
INSERT INTO public.taller_venta_items
  (tenant_id, venta_id, producto_id, descripcion, variante, cantidad, precio_unitario, subtotal)
SELECT v.tenant_id, v.id, v.producto_id, v.descripcion, v.variante,
       v.cantidad, v.precio_unitario,
       ROUND(COALESCE(v.cantidad, 1) * COALESCE(v.precio_unitario, 0), 2)
FROM public.taller_ventas v
WHERE NOT EXISTS (SELECT 1 FROM public.taller_venta_items i WHERE i.venta_id = v.id);

COMMENT ON TABLE public.taller_venta_items IS 'Las líneas de una venta del taller. El envío NO es una línea: va en la cabeza.';
COMMENT ON COLUMN public.taller_ventas.descripcion IS 'Resumen de la venta («Llavero y 2 más»). El detalle está en taller_venta_items.';

NOTIFY pgrst, 'reload schema';
