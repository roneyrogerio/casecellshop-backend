-- Up Migration
-- Estado do ERP simulado: produtos e faturas. Só o módulo src/erp/sim/ acessa este schema.
CREATE SCHEMA IF NOT EXISTS erp_sim;

CREATE TABLE erp_sim.products (
  sku         text PRIMARY KEY,
  name        text    NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  on_hand     integer NOT NULL CHECK (on_hand >= 0)
);

-- A referência única é a H1b: criar duas vezes devolve a mesma fatura.
CREATE TABLE erp_sim.invoices (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference   text        NOT NULL UNIQUE,
  items       jsonb       NOT NULL,
  total_cents bigint      NOT NULL CHECK (total_cents >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE erp_sim.invoices;
DROP TABLE erp_sim.products;
