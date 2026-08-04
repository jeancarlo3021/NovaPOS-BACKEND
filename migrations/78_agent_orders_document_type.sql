-- Tipo de comprobante elegido por el AGENTE al armar el pedido.
--
-- El agente es quien habla con el cliente y sabe si pide factura electrónica o
-- solo un tiquete. Sin esto, el cajero tenía que preguntar de nuevo al cobrar.
-- Valores: 'ticket' | 'tiquete_electronico' | 'factura_electronica'.
ALTER TABLE agent_orders ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'ticket';
