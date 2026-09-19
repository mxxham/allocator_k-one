-- =============================================================================
-- 0002 — Transactional stock posting functions (RPCs)
-- =============================================================================
-- Principles enforced here:
--   * PLANNED != EXECUTED — planning writes rows; only these functions move
--     stock, and only on an actual status transition to COMPLETED.
--   * Idempotency — every posting is a compare-and-set on status
--     (UPDATE ... WHERE status = 'PLANNED' ... RETURNING). Posting twice
--     changes stock exactly once and returns result = 'ALREADY_POSTED'.
--   * Atomicity — each function body runs as one transaction: a replenishment
--     (source -N, destination +N) either fully happens or fully rolls back.
--   * No negative stock — decrements are guarded (quantity + delta >= 0) with
--     a readable INSUFFICIENT_STOCK error, in addition to the CHECK constraint.
--   * Auditability — every stock mutation inserts stock_transactions rows and
--     every status transition inserts an execution_events row.
--
-- Error messages are pipe-delimited codes (e.g. 'INSUFFICIENT_STOCK|...') so
-- the TypeScript layer maps them to user-readable text without leaking raw
-- PostgreSQL errors.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: apply a signed delta to one physical identity.
-- Decrements require an existing row with sufficient quantity.
-- Increments upsert; p_meta supplies descriptive columns on first insert.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_stock_delta(
  p_location  text,
  p_sku       text,
  p_batch     text,
  p_expiry    date,
  p_delta     integer,
  p_meta      jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ident   text := p_location || '|' || p_sku || '|' || coalesce(p_batch, '') || '|' || p_expiry;
  v_current integer;
  v_upp     integer;
  v_updated integer;
BEGIN
  IF p_delta = 0 THEN
    RETURN;
  END IF;

  IF p_delta < 0 THEN
    UPDATE stock
       SET quantity       = quantity + p_delta,
           is_full_pallet = (quantity + p_delta >= upp)
     WHERE identity_key = v_ident
       AND quantity + p_delta >= 0;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
      SELECT quantity INTO v_current FROM stock WHERE identity_key = v_ident;
      IF v_current IS NULL THEN
        RAISE EXCEPTION 'STOCK_NOT_FOUND|%', v_ident;
      END IF;
      RAISE EXCEPTION 'INSUFFICIENT_STOCK|%|available=%|requested=%',
        v_ident, v_current, -p_delta;
    END IF;
  ELSE
    INSERT INTO stock (
      location, sku, batch, expiry_date, quantity, description, upp, uom,
      aisle, bay, level, position, is_full_pallet, gr_date
    ) VALUES (
      p_location, p_sku, p_batch, p_expiry, p_delta,
      coalesce(p_meta->>'description', ''),
      greatest(coalesce((p_meta->>'upp')::integer, 1), 1),
      p_meta->>'uom',
      coalesce(p_meta->>'aisle', ''),
      (p_meta->>'bay')::integer,
      p_meta->>'level',
      (p_meta->>'position')::integer,
      false,
      CASE WHEN p_meta->>'gr_date' IS NULL THEN NULL ELSE (p_meta->>'gr_date')::date END
    )
    ON CONFLICT (identity_key) DO UPDATE
      SET quantity       = stock.quantity + EXCLUDED.quantity,
          is_full_pallet = (stock.quantity + EXCLUDED.quantity >= stock.upp);

    -- Keep is_full_pallet correct after a fresh insert too.
    UPDATE stock
       SET is_full_pallet = (quantity >= upp)
     WHERE identity_key = v_ident
       AND is_full_pallet <> (quantity >= upp);
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Helper: record one immutable ledger row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_stock_transaction(
  p_type        text,
  p_location    text,
  p_sku         text,
  p_batch       text,
  p_expiry      date,
  p_delta       integer,
  p_ref_type    text,
  p_ref_id      text,
  p_wave_id     uuid,
  p_movement_id uuid,
  p_notes       text,
  p_actor       text,
  p_date        date DEFAULT CURRENT_DATE
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO stock_transactions (
    transaction_type, transaction_date, sku, location, batch, expiry_date,
    quantity_delta, reference_type, reference_id, wave_id, movement_id,
    notes, created_by
  ) VALUES (
    p_type, p_date, p_sku, p_location, p_batch, p_expiry,
    p_delta, p_ref_type, p_ref_id, p_wave_id, p_movement_id,
    p_notes, p_actor
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- Helper: audit a status transition.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_execution_event(
  p_entity_type text,
  p_entity_id   uuid,
  p_from        text,
  p_to          text,
  p_reason      text,
  p_actor       text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO execution_events (entity_type, entity_id, from_status, to_status, reason, actor)
  VALUES (p_entity_type, p_entity_id, p_from, p_to, p_reason, p_actor);
END;
$$;

-- -----------------------------------------------------------------------------
-- post_movement — execute ONE movement against physical stock.
--   PICK        : source  -qty
--   RELOC_OUT   : source  -qty
--   RELOC_IN    : destination +qty
--   REPLENISH   : source -qty AND destination +qty (atomic, two transactions)
-- Idempotent: a COMPLETED movement returns ALREADY_POSTED without any effect.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION post_movement(
  p_movement_id uuid,
  p_actor       text DEFAULT 'system',
  p_post_date   date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m movements%ROWTYPE;
BEGIN
  SELECT * INTO m FROM movements WHERE id = p_movement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOVEMENT_NOT_FOUND|%', p_movement_id;
  END IF;

  IF m.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('result', 'ALREADY_POSTED', 'movement_id', m.id);
  END IF;
  IF m.status <> 'PLANNED' THEN
    RAISE EXCEPTION 'MOVEMENT_NOT_EXECUTABLE|%|status=%', m.id, m.status;
  END IF;

  IF m.movement_type IN ('PICK', 'RELOC_OUT') THEN
    PERFORM apply_stock_delta(m.source_location, m.sku, m.batch, m.expiry_date, -m.quantity);
    PERFORM record_stock_transaction(
      m.movement_type, m.source_location, m.sku, m.batch, m.expiry_date, -m.quantity,
      'MOVEMENT', m.id::text, m.wave_id, m.id, NULL, p_actor, p_post_date);

  ELSIF m.movement_type = 'RELOC_IN' THEN
    IF m.destination_location IS NULL THEN
      RAISE EXCEPTION 'DESTINATION_REQUIRED|%', m.id;
    END IF;
    PERFORM apply_stock_delta(m.destination_location, m.sku, m.batch, m.expiry_date, m.quantity,
      jsonb_build_object('description', m.description));
    PERFORM record_stock_transaction(
      'RELOC_IN', m.destination_location, m.sku, m.batch, m.expiry_date, m.quantity,
      'MOVEMENT', m.id::text, m.wave_id, m.id, NULL, p_actor, p_post_date);

  ELSIF m.movement_type = 'REPLENISH' THEN
    IF m.destination_location IS NULL THEN
      RAISE EXCEPTION 'DESTINATION_REQUIRED|%', m.id;
    END IF;
    -- Source decrement first: if stock is insufficient the whole function
    -- (and therefore the destination increment) rolls back.
    PERFORM apply_stock_delta(m.source_location, m.sku, m.batch, m.expiry_date, -m.quantity);
    PERFORM record_stock_transaction(
      'RELOC_OUT', m.source_location, m.sku, m.batch, m.expiry_date, -m.quantity,
      'MOVEMENT', m.id::text, m.wave_id, m.id, 'REPLENISH ' || m.source_location || ' -> ' || m.destination_location,
      p_actor, p_post_date);

    PERFORM apply_stock_delta(m.destination_location, m.sku, m.batch, m.expiry_date, m.quantity,
      jsonb_build_object('description', m.description));
    PERFORM record_stock_transaction(
      'RELOC_IN', m.destination_location, m.sku, m.batch, m.expiry_date, m.quantity,
      'MOVEMENT', m.id::text, m.wave_id, m.id, 'REPLENISH ' || m.source_location || ' -> ' || m.destination_location,
      p_actor, p_post_date);
  END IF;

  UPDATE movements
     SET status = 'COMPLETED', completed_at = now(), completed_by = p_actor
   WHERE id = m.id AND status = 'PLANNED';

  PERFORM record_execution_event('MOVEMENT', m.id, 'PLANNED', 'COMPLETED', NULL, p_actor);

  RETURN jsonb_build_object('result', 'POSTED', 'movement_id', m.id,
                            'movement_type', m.movement_type, 'quantity', m.quantity);
END;
$$;

-- -----------------------------------------------------------------------------
-- set_movement_status — non-completing transitions (RESCHEDULED / CANCELLED /
-- back to PLANNED). NEVER touches stock. COMPLETED must go through
-- post_movement so stock can never be bypassed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_movement_status(
  p_movement_id uuid,
  p_status      text,
  p_actor       text DEFAULT 'system',
  p_reason      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m movements%ROWTYPE;
BEGIN
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'USE_POST_MOVEMENT|%', p_movement_id;
  END IF;
  IF p_status NOT IN ('PLANNED', 'RESCHEDULED', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_STATUS|%', p_status;
  END IF;

  SELECT * INTO m FROM movements WHERE id = p_movement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOVEMENT_NOT_FOUND|%', p_movement_id;
  END IF;
  IF m.status = p_status THEN
    RETURN jsonb_build_object('result', 'NO_CHANGE', 'movement_id', m.id, 'status', m.status);
  END IF;
  IF m.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'MOVEMENT_ALREADY_COMPLETED|%', m.id;
  END IF;
  IF m.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'MOVEMENT_CANCELLED|%', m.id;
  END IF;

  UPDATE movements SET status = p_status WHERE id = m.id;
  PERFORM record_execution_event('MOVEMENT', m.id, m.status, p_status, p_reason, p_actor);

  RETURN jsonb_build_object('result', 'UPDATED', 'movement_id', m.id,
                            'from_status', m.status, 'to_status', p_status);
END;
$$;

-- -----------------------------------------------------------------------------
-- set_wave_status — wave-level transitions that do NOT post stock:
-- RESCHEDULED (optionally with a new slot/date), CANCELLED (cascades to its
-- PLANNED movements so nothing can be posted afterwards), back to PENDING.
-- COMPLETED must go through complete_wave.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_wave_status(
  p_wave_id  uuid,
  p_status   text,
  p_actor    text DEFAULT 'system',
  p_reason   text DEFAULT NULL,
  p_new_slot text DEFAULT NULL,
  p_new_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w waves%ROWTYPE;
  v_cascade integer := 0;
BEGIN
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'USE_COMPLETE_WAVE|%', p_wave_id;
  END IF;
  IF p_status NOT IN ('PENDING', 'RESCHEDULED', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_STATUS|%', p_status;
  END IF;

  SELECT * INTO w FROM waves WHERE id = p_wave_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WAVE_NOT_FOUND|%', p_wave_id;
  END IF;

  IF p_status = w.status AND p_new_slot IS NULL AND p_new_date IS NULL THEN
    RETURN jsonb_build_object('result', 'NO_CHANGE', 'wave_id', w.id, 'status', w.status);
  END IF;
  IF w.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'WAVE_ALREADY_COMPLETED|%', w.id;
  END IF;
  IF w.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'WAVE_CANCELLED|%', w.id;
  END IF;

  IF p_status = 'CANCELLED' THEN
    -- Cascade: planned movements of a cancelled wave can never be posted.
    WITH cancelled AS (
      UPDATE movements SET status = 'CANCELLED'
       WHERE wave_id = w.id AND status = 'PLANNED'
      RETURNING id
    )
    SELECT count(*) INTO v_cascade FROM cancelled;

    UPDATE outbound SET status = 'CANCELLED', completed_at = now(), completed_by = p_actor
     WHERE wave_id = w.id AND status = 'PLANNED';
  END IF;

  UPDATE waves
     SET status       = p_status,
         planned_slot = coalesce(p_new_slot, planned_slot),
         planned_date = coalesce(p_new_date, planned_date)
   WHERE id = w.id;

  PERFORM record_execution_event('WAVE', w.id, w.status, p_status, p_reason, p_actor);

  RETURN jsonb_build_object('result', 'UPDATED', 'wave_id', w.id,
                            'from_status', w.status, 'to_status', p_status,
                            'movements_cancelled', v_cascade);
END;
$$;

-- -----------------------------------------------------------------------------
-- complete_wave — the truck actually shipped.
-- Posts every remaining PLANNED movement of the wave (each one idempotent),
-- marks ALLOCATION-origin outbound COMPLETED (stock was already deducted by
-- the movements — never double-deducts), and marks the wave COMPLETED.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_wave(
  p_wave_id   uuid,
  p_actor     text DEFAULT 'system',
  p_post_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w waves%ROWTYPE;
  mv RECORD;
  v_posted integer := 0;
  v_outbound integer := 0;
BEGIN
  SELECT * INTO w FROM waves WHERE id = p_wave_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WAVE_NOT_FOUND|%', p_wave_id;
  END IF;
  IF w.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('result', 'ALREADY_POSTED', 'wave_id', w.id);
  END IF;
  IF w.status = 'RESCHEDULED' THEN
    RAISE EXCEPTION 'WAVE_RESCHEDULED|%', w.id;
  END IF;
  IF w.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'WAVE_CANCELLED|%', w.id;
  END IF;

  FOR mv IN
    SELECT id FROM movements
     WHERE wave_id = w.id AND status = 'PLANNED'
     ORDER BY coalesce(seq, 0), created_at
  LOOP
    PERFORM post_movement(mv.id, p_actor, p_post_date);
    v_posted := v_posted + 1;
  END LOOP;

  WITH done AS (
    UPDATE outbound
       SET status = 'COMPLETED', completed_at = now(), completed_by = p_actor
     WHERE wave_id = w.id AND status = 'PLANNED' AND origin = 'ALLOCATION'
    RETURNING id
  )
  SELECT count(*) INTO v_outbound FROM done;

  UPDATE waves SET status = 'COMPLETED' WHERE id = w.id;
  PERFORM record_execution_event('WAVE', w.id, w.status, 'COMPLETED', NULL, p_actor);

  RETURN jsonb_build_object('result', 'POSTED', 'wave_id', w.id,
                            'movements_posted', v_posted,
                            'outbound_completed', v_outbound);
END;
$$;

-- -----------------------------------------------------------------------------
-- post_inbound — PENDING -> COMPLETED, +qty once. Idempotent.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION post_inbound(
  p_inbound_id uuid,
  p_actor      text DEFAULT 'system',
  p_post_date  date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i inbound%ROWTYPE;
  v_date date;
BEGIN
  SELECT * INTO i FROM inbound WHERE id = p_inbound_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INBOUND_NOT_FOUND|%', p_inbound_id;
  END IF;
  IF i.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('result', 'ALREADY_POSTED', 'inbound_id', i.id);
  END IF;
  IF i.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'INBOUND_CANCELLED|%', i.id;
  END IF;

  v_date := coalesce(p_post_date, i.inbound_date);

  PERFORM apply_stock_delta(i.location, i.sku, i.batch, i.expiry_date, i.quantity,
    jsonb_build_object('description', i.description, 'upp', i.upp, 'uom', i.uom));
  PERFORM record_stock_transaction(
    'INBOUND', i.location, i.sku, i.batch, i.expiry_date, i.quantity,
    'INBOUND', i.id::text, NULL, NULL, i.reference_no, p_actor, v_date);

  UPDATE inbound
     SET status = 'COMPLETED', completed_at = now(), completed_by = p_actor
   WHERE id = i.id AND status = 'PENDING';

  PERFORM record_execution_event('INBOUND', i.id, 'PENDING', 'COMPLETED', NULL, p_actor);

  RETURN jsonb_build_object('result', 'POSTED', 'inbound_id', i.id, 'quantity', i.quantity);
END;
$$;

-- -----------------------------------------------------------------------------
-- post_outbound — PLANNED -> COMPLETED, -qty once. Idempotent.
-- Only for MANUAL/IMPORT outbound: ALLOCATION-origin rows are settled by
-- posting their movements (see complete_wave); posting them here too would
-- double-deduct, so it is rejected.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION post_outbound(
  p_outbound_id uuid,
  p_actor       text DEFAULT 'system',
  p_post_date   date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o outbound%ROWTYPE;
  v_date date;
BEGIN
  SELECT * INTO o FROM outbound WHERE id = p_outbound_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_FOUND|%', p_outbound_id;
  END IF;
  IF o.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('result', 'ALREADY_POSTED', 'outbound_id', o.id);
  END IF;
  IF o.origin = 'ALLOCATION' THEN
    RAISE EXCEPTION 'OUTBOUND_POSTED_VIA_MOVEMENTS|%', o.id;
  END IF;
  IF o.status <> 'PLANNED' THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_EXECUTABLE|%|status=%', o.id, o.status;
  END IF;
  IF o.location IS NULL OR o.expiry_date IS NULL THEN
    RAISE EXCEPTION 'OUTBOUND_IDENTITY_REQUIRED|%', o.id;
  END IF;

  v_date := coalesce(p_post_date, o.outbound_date);

  PERFORM apply_stock_delta(o.location, o.sku, o.batch, o.expiry_date, -o.quantity);
  PERFORM record_stock_transaction(
    'OUTBOUND', o.location, o.sku, o.batch, o.expiry_date, -o.quantity,
    'OUTBOUND', o.id::text, o.wave_id, NULL, o.shipment_number, p_actor, v_date);

  UPDATE outbound
     SET status = 'COMPLETED', completed_at = now(), completed_by = p_actor
   WHERE id = o.id AND status = 'PLANNED';

  PERFORM record_execution_event('OUTBOUND', o.id, 'PLANNED', 'COMPLETED', NULL, p_actor);

  RETURN jsonb_build_object('result', 'POSTED', 'outbound_id', o.id, 'quantity', o.quantity);
END;
$$;

-- -----------------------------------------------------------------------------
-- set_outbound_status — non-completing transitions for outbound rows
-- (RESCHEDULED / CANCELLED / back to PLANNED). Never touches stock.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_outbound_status(
  p_outbound_id uuid,
  p_status      text,
  p_actor       text DEFAULT 'system',
  p_reason      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o outbound%ROWTYPE;
BEGIN
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'USE_POST_OUTBOUND_OR_COMPLETE_WAVE|%', p_outbound_id;
  END IF;
  IF p_status NOT IN ('PLANNED', 'RESCHEDULED', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_STATUS|%', p_status;
  END IF;

  SELECT * INTO o FROM outbound WHERE id = p_outbound_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_FOUND|%', p_outbound_id;
  END IF;
  IF o.status = p_status THEN
    RETURN jsonb_build_object('result', 'NO_CHANGE', 'outbound_id', o.id, 'status', o.status);
  END IF;
  IF o.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'OUTBOUND_ALREADY_COMPLETED|%', o.id;
  END IF;

  UPDATE outbound SET status = p_status WHERE id = o.id;
  PERFORM record_execution_event('OUTBOUND', o.id, o.status, p_status, p_reason, p_actor);

  RETURN jsonb_build_object('result', 'UPDATED', 'outbound_id', o.id,
                            'from_status', o.status, 'to_status', p_status);
END;
$$;

-- -----------------------------------------------------------------------------
-- adjust_stock — controlled manual correction. Reason and actor are mandatory;
-- the stock identity must already exist; the result may never go negative.
-- There is no other way to change a quantity: silent edits are impossible.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION adjust_stock(
  p_location text,
  p_sku      text,
  p_batch    text,
  p_expiry   date,
  p_delta    integer,
  p_reason   text,
  p_actor    text,
  p_date     date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ident text := p_location || '|' || p_sku || '|' || coalesce(p_batch, '') || '|' || p_expiry;
  v_new   integer;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'ZERO_ADJUSTMENT';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_actor IS NULL OR length(trim(p_actor)) = 0 THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stock WHERE identity_key = v_ident) THEN
    RAISE EXCEPTION 'STOCK_NOT_FOUND|%', v_ident;
  END IF;

  PERFORM apply_stock_delta(p_location, p_sku, p_batch, p_expiry, p_delta);

  SELECT quantity INTO v_new FROM stock WHERE identity_key = v_ident;

  PERFORM record_stock_transaction(
    'ADJUSTMENT', p_location, p_sku, p_batch, p_expiry, p_delta,
    'ADJUSTMENT', gen_random_uuid()::text, NULL, NULL, trim(p_reason), p_actor, p_date);

  RETURN jsonb_build_object('result', 'ADJUSTED', 'identity_key', v_ident,
                            'delta', p_delta, 'new_quantity', v_new);
END;
$$;

-- -----------------------------------------------------------------------------
-- initial_import — load the opening WMS snapshot in ONE transaction.
-- p_rows: jsonb array of {location, sku, description, batch, expiry_date,
--         quantity, upp, uom, aisle, bay, level, position, gr_date}
-- p_mode: FAIL_ON_CONFLICT (default) | REPLACE
--   FAIL_ON_CONFLICT — any already-existing identity aborts the whole import
--                      (PHYSICAL_IDENTITY_CONFLICT); nothing is written.
--   REPLACE          — existing identities are set to the imported quantity
--                      and the DIFFERENCE is written to the ledger, so the
--                      transaction history always explains the balance.
-- Negative or invalid rows abort the import (VALIDATION_ERROR /
-- DUPLICATE_IDENTITY). Zero-quantity rows are skipped (empty bins).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION initial_import(
  p_rows  jsonb,
  p_actor text DEFAULT 'system',
  p_mode  text DEFAULT 'FAIL_ON_CONFLICT',
  p_date  date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_ident    text;
  v_existing stock%ROWTYPE;
  v_delta    integer;
  v_count    integer := 0;
  v_replaced integer := 0;
  v_skipped  integer := 0;
BEGIN
  IF p_mode NOT IN ('FAIL_ON_CONFLICT', 'REPLACE') THEN
    RAISE EXCEPTION 'INVALID_IMPORT_MODE|%', p_mode;
  END IF;

  -- Reject duplicate physical identities inside the payload itself.
  SELECT count(*) INTO v_count
  FROM (
    SELECT location || '|' || sku || '|' || coalesce(batch, '') || '|' || expiry_date AS k
    FROM jsonb_to_recordset(p_rows) AS x(
      location text, sku text, batch text, expiry_date date, quantity integer
    )
    WHERE coalesce(location, '') <> '' AND coalesce(sku, '') <> ''
    GROUP BY 1 HAVING count(*) > 1
  ) dups;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'DUPLICATE_IDENTITY|count=%', v_count;
  END IF;

  v_count := 0;
  FOR r IN
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      location text, sku text, description text, batch text, expiry_date date,
      quantity integer, upp integer, uom text, aisle text,
      bay integer, level text, position integer, gr_date date
    )
  LOOP
    IF coalesce(r.location, '') = '' OR coalesce(r.sku, '') = '' OR r.expiry_date IS NULL THEN
      RAISE EXCEPTION 'VALIDATION_ERROR|missing identity fields|location=%|sku=%|expiry=%',
        r.location, r.sku, r.expiry_date;
    END IF;
    IF r.quantity IS NULL OR r.quantity < 0 THEN
      RAISE EXCEPTION 'VALIDATION_ERROR|invalid quantity %|%|%', r.location, r.sku, r.quantity;
    END IF;
    IF r.quantity = 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_ident := r.location || '|' || r.sku || '|' || coalesce(r.batch, '') || '|' || r.expiry_date;

    SELECT * INTO v_existing FROM stock WHERE identity_key = v_ident FOR UPDATE;

    IF FOUND THEN
      IF p_mode = 'FAIL_ON_CONFLICT' THEN
        RAISE EXCEPTION 'PHYSICAL_IDENTITY_CONFLICT|%', v_ident;
      END IF;
      v_delta := r.quantity - v_existing.quantity;
      IF v_delta <> 0 THEN
        UPDATE stock
           SET quantity       = r.quantity,
               description    = CASE WHEN coalesce(r.description, '') = '' THEN stock.description ELSE r.description END,
               upp            = coalesce(nullif(r.upp, 0), stock.upp),
               uom            = coalesce(r.uom, stock.uom),
               is_full_pallet = (r.quantity >= coalesce(nullif(r.upp, 0), stock.upp))
         WHERE identity_key = v_ident;
        PERFORM record_stock_transaction(
          'INITIAL_IMPORT', r.location, r.sku, r.batch, r.expiry_date, v_delta,
          'INITIAL_IMPORT', 'reimport', NULL, NULL, 'REPLACE mode', p_actor, p_date);
      END IF;
      v_replaced := v_replaced + 1;
    ELSE
      INSERT INTO stock (
        location, sku, description, batch, expiry_date, quantity, upp, uom,
        aisle, bay, level, position, is_full_pallet, gr_date
      ) VALUES (
        r.location, r.sku, coalesce(r.description, ''), r.batch, r.expiry_date, r.quantity,
        greatest(coalesce(r.upp, 1), 1), r.uom,
        coalesce(r.aisle, ''), r.bay, r.level, r.position,
        r.quantity >= greatest(coalesce(r.upp, 1), 1), r.gr_date
      );
      PERFORM record_stock_transaction(
        'INITIAL_IMPORT', r.location, r.sku, r.batch, r.expiry_date, r.quantity,
        'INITIAL_IMPORT', 'initial', NULL, NULL, NULL, p_actor, p_date);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'result', 'IMPORTED', 'imported', v_count,
    'replaced', v_replaced, 'skipped_zero_qty', v_skipped);
END;
$$;
