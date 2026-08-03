-- Id del DOCUMENTO en Alanube (ULID) de las notas de crédito/débito.
--
-- `fe_nc_clave` guarda la clave de 50 díg de Hacienda, pero para CONSULTAR el
-- estado en Alanube hace falta su id interno (ULID), que se perdía al emitir.
-- Sin él, una nota cuyo webhook se perdió quedaba clavada en "en proceso" para
-- siempre, sin forma de reconsultarla.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_nc_doc_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fe_nd_doc_id TEXT;
