-- =============================================================================
-- 0001 — Initial schema
-- =============================================================================
-- Physical stock identity is NON-NEGOTIABLY: location + sku + batch + expiry.
-- The trigger-maintained `identity_key` column mirrors stockIdentityKey() in
-- src/ledger.ts exactly: `${location}|${sku}|${batch ?? ''}|${YYYY-MM-DD}`.
-- binId (location|sku|batch) is NEVER used as a unique key: two expiry dates
-- at the same location are two separate physical stock records.
--
-- All date-only columns use DATE (never timezone-sensitive timestamps) so
-- Excel dates such as 2030-09-02 round-trip without a one-day shift.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity key maintenance. PostgreSQL rejects date→text in GENERATED columns
-- (date_out depends on DateStyle), so identity_key is maintained by a BEFORE
-- INSERT/UPDATE trigger instead. Format matches stockIdentityKey() exactly.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_identity_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.identity_key := NEW.location || '|' || NEW.sku || '|'
                   || coalesce(NEW.batch, '') || '|'
                   || to_char(NEW.expiry_date, 'YYYY-MM-DD');
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- stock — current physical stock, one row per physical identity
-- -----------------------------------------------------------------------------
CREATE TABLE stock (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location        text NOT NULL,
  sku             text NOT NULL,
  description     text NOT NULL DEFAULT '',
  batch           text,
  expiry_date     date NOT NULL,
  quantity        integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  upp             integer NOT NULL DEFAULT 1 CHECK (upp >= 1),
  uom             text,
  aisle           text NOT NULL DEFAULT '',
  bay             integer,
  level           text,
  position        integer,
  is_full_pallet  boolean NOT NULL DEFAULT false,
  gr_date         date,
  identity_key    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_stock_identity UNIQUE (identity_key)
);

CREATE TRIGGER trg_stock_identity
  BEFORE INSERT OR UPDATE ON stock
  FOR EACH ROW EXECUTE FUNCTION compute_identity_key();

CREATE INDEX idx_stock_sku       ON stock (sku);
CREATE INDEX idx_stock_location  ON stock (location);
CREATE INDEX idx_stock_expiry    ON stock (expiry_date);
CREATE INDEX idx_stock_batch     ON stock (batch);
CREATE INDEX idx_stock_loc_sku   ON stock (location, sku);

-- -----------------------------------------------------------------------------
-- stock_transactions — immutable ledger; every stock change has exactly one
-- (or two, for relocations) transaction row here. Never UPDATE, never DELETE.
-- Balance rule: stock.quantity = SUM(quantity_delta) per identity_key.
-- -----------------------------------------------------------------------------
CREATE TABLE stock_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_type  text NOT NULL CHECK (transaction_type IN
                      ('INITIAL_IMPORT','INBOUND','OUTBOUND','PICK','RELOC_IN','RELOC_OUT','ADJUSTMENT')),
  transaction_date  date NOT NULL DEFAULT CURRENT_DATE,
  sku               text NOT NULL,
  location          text NOT NULL,
  batch             text,
  expiry_date       date NOT NULL,
  quantity_delta    integer NOT NULL CHECK (quantity_delta <> 0),
  reference_type    text CHECK (reference_type IN
                      ('INITIAL_IMPORT','INBOUND','OUTBOUND','MOVEMENT','ADJUSTMENT')),
  reference_id      text,
  wave_id           uuid,
  movement_id       uuid,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL DEFAULT 'system',
  identity_key      text NOT NULL
);

CREATE TRIGGER trg_stx_identity
  BEFORE INSERT OR UPDATE ON stock_transactions
  FOR EACH ROW EXECUTE FUNCTION compute_identity_key();

CREATE INDEX idx_stx_identity ON stock_transactions (identity_key);
CREATE INDEX idx_stx_sku      ON stock_transactions (sku);
CREATE INDEX idx_stx_date     ON stock_transactions (transaction_date);
CREATE INDEX idx_stx_type     ON stock_transactions (transaction_type);
CREATE INDEX idx_stx_wave     ON stock_transactions (wave_id);
CREATE INDEX idx_stx_movement ON stock_transactions (movement_id);

-- Idempotency backstop: one reference can produce at most one transaction of
-- each type per physical identity. (A REPLENISH movement produces one RELOC_OUT
-- at the source and one RELOC_IN at the destination — distinct types/locations.)
CREATE UNIQUE INDEX ux_stx_reference ON stock_transactions
  (reference_type, reference_id, transaction_type, identity_key)
  WHERE reference_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- waves — outbound run groupings ("NO" column). wave_no ordering is NOT
-- chronological; planned_slot / planned_date determine execution order.
-- -----------------------------------------------------------------------------
CREATE TABLE waves (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wave_no          text NOT NULL,
  planned_date     date NOT NULL DEFAULT CURRENT_DATE,
  shipment_numbers text[] NOT NULL DEFAULT '{}',
  truck            text,
  destination      text NOT NULL DEFAULT '',
  planned_slot     text,
  status           text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','COMPLETED','RESCHEDULED','CANCELLED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_waves_date_no UNIQUE (planned_date, wave_no)
);

CREATE INDEX idx_waves_status ON waves (status);
CREATE INDEX idx_waves_date   ON waves (planned_date);

-- -----------------------------------------------------------------------------
-- inbound — receipts. Only COMPLETED inbound affects stock (via post_inbound).
-- -----------------------------------------------------------------------------
CREATE TABLE inbound (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_date  date NOT NULL DEFAULT CURRENT_DATE,
  reference_no  text NOT NULL,
  sku           text NOT NULL,
  description   text NOT NULL DEFAULT '',
  location      text NOT NULL,
  batch         text,
  expiry_date   date NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  upp           integer NOT NULL DEFAULT 1 CHECK (upp >= 1),
  uom           text,
  status        text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','COMPLETED','CANCELLED')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  completed_by  text,
  CONSTRAINT ux_inbound_reference UNIQUE (reference_no)
);

CREATE INDEX idx_inbound_status ON inbound (status);
CREATE INDEX idx_inbound_date   ON inbound (inbound_date);
CREATE INDEX idx_inbound_sku    ON inbound (sku);

-- -----------------------------------------------------------------------------
-- outbound — shipment demand/execution rows.
-- origin: ALLOCATION  = written by the planner, stock is deducted by posting
--                       its PICK movements (never by post_outbound — that would
--                       double-deduct).
--         MANUAL/IMPORT = entered directly; post_outbound deducts stock once.
-- PLANNED outbound NEVER touches stock.
-- -----------------------------------------------------------------------------
CREATE TABLE outbound (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbound_date    date NOT NULL DEFAULT CURRENT_DATE,
  shipment_number  text NOT NULL,
  wave_id          uuid REFERENCES waves(id),
  wave_no          text,
  truck            text,
  destination      text NOT NULL DEFAULT '',
  sku              text NOT NULL,
  description      text NOT NULL DEFAULT '',
  location         text,
  batch            text,
  expiry_date      date,
  quantity         integer NOT NULL CHECK (quantity > 0),
  origin           text NOT NULL DEFAULT 'MANUAL'
                     CHECK (origin IN ('ALLOCATION','MANUAL','IMPORT')),
  status           text NOT NULL DEFAULT 'PLANNED'
                     CHECK (status IN ('PLANNED','COMPLETED','RESCHEDULED','CANCELLED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  completed_by     text
);

CREATE INDEX idx_outbound_status   ON outbound (status);
CREATE INDEX idx_outbound_wave     ON outbound (wave_id);
CREATE INDEX idx_outbound_sku      ON outbound (sku);
CREATE INDEX idx_outbound_date     ON outbound (outbound_date);
CREATE INDEX idx_outbound_shipment ON outbound (shipment_number);

-- -----------------------------------------------------------------------------
-- movements — planned and actual physical movements. Execution is tracked at
-- MOVEMENT level: a wave can be PENDING while some movements are COMPLETED and
-- others RESCHEDULED. Stock changes happen ONLY when a movement is posted.
-- -----------------------------------------------------------------------------
CREATE TABLE movements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wave_id               uuid REFERENCES waves(id),
  wave_no               text,
  shipment_number       text,
  movement_type         text NOT NULL
                          CHECK (movement_type IN ('PICK','RELOC_OUT','RELOC_IN','REPLENISH')),
  sku                   text NOT NULL,
  description           text NOT NULL DEFAULT '',
  source_location       text NOT NULL,
  destination_location  text,
  batch                 text,
  expiry_date           date NOT NULL,
  quantity              integer NOT NULL CHECK (quantity > 0),
  pick_type             text CHECK (pick_type IN ('PALLET','CASE')),
  breaks_pallet         boolean NOT NULL DEFAULT false,
  seq                   integer,
  status                text NOT NULL DEFAULT 'PLANNED'
                          CHECK (status IN ('PLANNED','COMPLETED','RESCHEDULED','CANCELLED')),
  reference_id          text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  completed_by          text
);

CREATE INDEX idx_movements_wave    ON movements (wave_id);
CREATE INDEX idx_movements_status  ON movements (status);
CREATE INDEX idx_movements_sku     ON movements (sku);
CREATE INDEX idx_movements_source  ON movements (source_location);
CREATE INDEX idx_movements_dest    ON movements (destination_location);
CREATE INDEX idx_movements_expiry  ON movements (expiry_date);

-- -----------------------------------------------------------------------------
-- execution_events — status-transition audit trail. History is never erased:
-- a rescheduled wave keeps its original plan plus every transition.
-- -----------------------------------------------------------------------------
CREATE TABLE execution_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (entity_type IN ('WAVE','MOVEMENT','INBOUND','OUTBOUND')),
  entity_id    uuid NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  reason       text,
  actor        text NOT NULL DEFAULT 'system',
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_exec_events_entity ON execution_events (entity_type, entity_id);
CREATE INDEX idx_exec_events_time   ON execution_events (occurred_at);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_stock_updated_at
  BEFORE UPDATE ON stock FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_waves_updated_at
  BEFORE UPDATE ON waves FOR EACH ROW EXECUTE FUNCTION set_updated_at();
