-- Arregla los DUPLICADOS de la bandeja de recepción.
--
-- Contexto: la tabla YA tiene un constraint único (tenant_id, clave), pero los
-- duplicados entraron porque la clave estaba corrupta (float "5.06e+49" del bug de
-- parseTagValue) y al reprocesar los correos entraban con la clave correcta (50 díg)
-- → claves distintas → no chocaban con el constraint.
--
-- Solución: deduplicar por la clave REAL (la de 50 díg, tomada del XML si la columna
-- quedó corrupta), CONSERVANDO la fila ya procesada; y después reparar la clave.

-- 1) DEDUPLICAR por la clave REAL. Se calcula: si la columna `clave` ya son 50 díg,
--    esa; si no, la que está dentro del XML; si no se puede, la propia (no se fusiona).
--    Entre duplicados se conserva la fila NO pendiente (aceptada/rechazada) y, como
--    desempate, la más antigua.
DELETE FROM received_documents
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      row_number() OVER (
        PARTITION BY tenant_id, COALESCE(
          NULLIF(
            CASE WHEN clave ~ '^\d{50}$' THEN clave
                 ELSE (regexp_match(xml, '<Clave>\s*(\d{50})\s*</Clave>'))[1] END,
            ''),
          clave)
        ORDER BY
          (COALESCE(ack_status, 'pending') = 'pending') ASC,   -- primero las procesadas
          created_at ASC
      ) AS rn
    FROM received_documents
  ) t
  WHERE t.rn > 1
);

-- 2) REPARAR la clave corrupta con la real del XML (ya sin riesgo de colisión: el
--    paso 1 quitó los duplicados que compartían clave real).
UPDATE received_documents
SET clave = (regexp_match(xml, '<Clave>\s*(\d{50})\s*</Clave>'))[1]
WHERE clave !~ '^\d{50}$'
  AND xml IS NOT NULL
  AND xml ~ '<Clave>\s*\d{50}\s*</Clave>';

-- 3) El constraint único (tenant_id, clave) ya existe → no hay que crearlo. De acá en
--    adelante la BD rechaza duplicados y el código lo trata como 'dup'.
