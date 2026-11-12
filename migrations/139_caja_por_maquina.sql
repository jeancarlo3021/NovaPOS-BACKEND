-- 139 · LA CAJA ES LA MÁQUINA: apertura y cierre por terminal
--
-- Hasta ahora la sesión de caja era POR USUARIO: cada cajero abría la suya y el
-- POS buscaba «la caja abierta de este usuario». En un negocio con una sola
-- computadora funciona, pero no es como trabaja un negocio con dos cajas:
--
--   · Dos cajeros en la MISMA máquina abrían dos cajas distintas sobre la misma
--     gaveta: el efectivo era uno y los arqueos dos, y ninguno cuadraba.
--   · Un cajero que atiende las dos cajas del local tenía una sola sesión para
--     ambas: la plata de las dos gavetas sumada en un solo cierre.
--   · Al relevar el turno, el que entraba no podía seguir la caja que estaba
--     abierta —no era «suya»— y abría otra con la gaveta ya empezada.
--
-- Una caja es un MUEBLE con plata adentro, no una persona. Lo que la identifica
-- es la máquina que la opera, que es el número de terminal que este sistema ya
-- usa para el consecutivo de Hacienda (ver hooks/useTerminal del frontend).
--
--     terminal    → qué máquina abrió esta caja (1, 2, 3…)
--     caja_nombre → cómo le dicen en el local («Caja 1», «Barra», «Terraza»)
--
-- El nombre se guarda COPIADO en la sesión, no por referencia: si mañana le
-- cambian el nombre a la caja, el arqueo de hace tres meses tiene que seguir
-- diciendo cómo se llamaba cuando se cerró.
--
-- Las dos columnas quedan NULAS para las cajas ya existentes y para los
-- negocios que no configuren máquinas: ahí la caja sigue siendo por usuario,
-- exactamente como antes.

ALTER TABLE public.cash_sessions
  ADD COLUMN IF NOT EXISTS terminal    INTEGER,
  ADD COLUMN IF NOT EXISTS caja_nombre TEXT;

COMMENT ON COLUMN public.cash_sessions.terminal IS
  'Máquina (terminal) que opera esta caja. NULL = caja por usuario, como antes.';
COMMENT ON COLUMN public.cash_sessions.caja_nombre IS
  'Nombre de la caja al momento de abrirla, copiado para que el histórico no cambie.';

-- Buscar «la caja abierta de esta máquina» es la consulta que corre en cada
-- carga del POS; sin índice son 2 por pantalla contra toda la tabla.
CREATE INDEX IF NOT EXISTS idx_cash_sessions_terminal
  ON public.cash_sessions (tenant_id, terminal, status);

NOTIFY pgrst, 'reload schema';
