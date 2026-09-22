-- =============================================================================
-- 0004 — Security hardening
-- =============================================================================
-- Three changes applied to all existing SECURITY DEFINER functions:
--   1. SET search_path = '' (was 'public') — prevents search_path hijacking.
--      All table/function references are now schema-qualified (public.xxx).
--   2. EXECUTE restricted — stock-mutating RPCs are service_role only.
--   3. View security — stock_vs_ledger uses security_invoker so it honours
--      the caller's RLS context instead of the view owner's.
--
-- NOTE: This migration must NOT alter already-committed migrations 0001–0003.
--       It recreates every function with the hardened search_path.
-- =============================================================================

-- 1. Harden search_path on all SECURITY DEFINER functions
--    Every table reference becomes public.xxx, every function call becomes
--    public.func_name(...).

-- apply_stock_delta
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
SET search_path = ''
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
    UPDATE public.stock
       SET quantity       = quantity + p_delta,
           is_full_pallet = (quantity + p_delta >= upp)
     WHERE identity_key = v_ident
       AND quantity + p_delta >= 0;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
      SELECT quantity INTO v_current FROM public.stock WHERE identity_key = v_ident;
      IF v_current IS NULL THEN
        RAISE EXCEPTION 'STOCK_NOT_FOUND|%', v_ident;
      END IF;
      RAISE EXCEPTION 'INSUFFICIENT_STOCK|%|available=%|requested=%',
        v_ident, v_current, -p_delta;
    END IF;
  ELSE
    INSERT INTO public.stock (
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
      SET quantity       = public.stock.quantity + EXCLUDED.quantity,
          is_full_pallet = (public.stock.quantity + EXCLUDED.quantity >= public.stock.upp);

    UPDATE public.stock
       SET is_full_pallet = (quantity >= upp)
     WHERE identity_key = v_ident
       AND is_full_pallet <> (quantity >= upp);
  END IF;
END;
$$;
-- record_stock_transaction
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
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.stock_transactions (
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

-- record_execution_event
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
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.execution_events (entity_type, entity_id, from_status, to_status, reason, actor)
  VALUES (p_entity_type, p_entity_id, p_from, p_to, p_reason, p_actor);
END;
$$;

-- post_movement
CREATE OR REPLACE FUNCTION post_movement(
  p_movement_id uuid,
  p_actor       text DEFAULT 'system',
  p_post_date   date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m public.movements%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.movements WHERE id = p_movement_id FOR UPDATE;
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
    PERFORM public.apply_stock_delta(m.source_location, m.sku, m.batch, m.expiry_date, -m.quantity);
    PERFORM public.record_stock_transaction(
      m.movement_type, m.source_location, m.sku, m.batch, m.expiry_date, -m.quantity,
      'MOVEMENT', m.id::text, m.wave_id, m.id, NULL, p_actor, p_post_date);

  ELSIF m.movement_type = 'RELOC_IN' THEN
    IF m.destination_location IS NULL THEN
      RAISE EXCEPTION 'DESTINATION_REQUIRED|%', m.id;
    END IF;
    PERFORM public.apply_stock_delta(m.destination_location, m.sku, m.batch, m.expiry_date, m.quantity,
      jsonb_build_object('description', m.description));
    PERFORM public.record_stock_transaction(
      'RELOC_IN', m.destination_location, m.sku, m.batch, m.expiry_date, m.quantity,
      'MOVEMENT', m.id::text, m.wave_id, m.id, NULL, p_actor, p_post_date);

  ELSIF m.movement_type = 'REPLENISH' THEN
    IF m.destination_location IS NULL THEN
      RAISE EXCEPTION 'DESTINATION_REQUIRED|%', m.id;
    END IF;
    PERFORM public.apply_stock_delta(m.source_location, m.sku, m.batch, m.expiry_date, -m.quantity);
    PERFORM public.record_stock_transaction(
      'RELOC_OUT', m.source_location, m.sku, m.batch, m.expiry_date, -m.quantity,
      'MOVEMENT', m.id::text, m.wave_id, m.id, 'REPLENISH ' || m.source_location || ' -> ' || m.destination_location,
      p_actor, p_post_date);

    PERFORM public.apply_stock_delta(m.destination_location, m.sku, m.batch, m.expiry_date, m.quantity,
      jsonb_build_object('description', m.description));
    PERFORM public.record_stock_transaction(
      'RELOC_IN', m.destination_location, m.sku, m.batch, m.expiry_date, m.quantity,
      'MOVEMENT', m.id::text, m.wave_id, m.id, 'REPLENISH ' || m.source_location || ' -> ' || m.destination_location,
      p_actor, p_post_date);
  END IF;

  UPDATE public.movements
     SET status = 'COMPLETED', completed_at = now(), completed_by = p_actor
   WHERE id = m.id AND status = 'PLANNED';

  PERFORM public.record_execution_event('MOVEMENT', m.id, 'PLANNED', 'COMPLETED', NULL, p_actor);

  RETURN jsonb_build_object('result', 'POSTED', 'movement_id', m.id,
                            'movement_type', m.movement_type, 'quantity', m.quantity);
END;
$$;

-- set_movement_status
CREATE OR REPLACE FUNCTION set_movement_status(
  p_movement_id uuid,
  p_status      text,
  p_actor       text DEFAULT 'system',
  p_reason      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m public.movements%ROWTYPE;
BEGIN
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'USE_POST_MOVEMENT|%', p_movement_id;
  END IF;
  IF p_status NOT IN ('PLANNED', 'RESCHEDULED', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_STATUS|%', p_status;
  END IF;

  SELECT * INTO m FROM public.movements WHERE id = p_movement_id FOR UPDATE;
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

  UPDATE public.movements SET status = p_status WHERE id = m.id;
  PERFORM public.record_execution_event('MOVEMENT', m.id, m.status, p_status, p_reason, p_actor);

  RETURN jsonb_build_object('result', 'UPDATED', 'movement_id', m.id,
                            'from_status', m.status, 'to_status', p_status);
END;
$$;

-- set_wave_status
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
SET search_path = ''
AS $$
DECLARE
  w public.waves%ROWTYPE;
  v_cascade integer := 0;
BEGIN
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'USE_COMPLETE_WAVE|%', p_wave_id;
  END IF;
  IF p_status NOT IN ('PENDING', 'RESCHEDULED', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_STATUS|%', p_status;
  END IF;

  SELECT * INTO w FROM public.waves WHERE id = p_wave_id FOR UPDATE;
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
    WITH cancelled AS (
      UPDATE public.movements SET status = 'CANCELLED'
       WHERE wave_id = w.id AND status = 'PLANNED'
      RETURNING id
    )
    SELECT count(*) INTO v_cascade FROM cancelled;

    UPDATE public.outbound SET status = 'CANCELLED', completed_at = now(), completed_by = p_actor
     WHERE wave_id = w.id AND status = 'PLANNED';
  END IF;

  UPDATE public.waves
     SET status       = p_status,
         planned_slot = coalesce(p_new_slot, planned_slot),
         planned_date = coalesce(p_new_date, planned_date)
   WHERE id = w.id;

  PERFORM public.record_execution_event('WAVE', w.id, w.status, p_status, p_reason, p_actor);

  RETURN jsonb_build_object('result', 'UPDATED', 'wave_id', w.id,
                            'from_status', w.status, 'to_status', p_status,
                            'movements_cancelled', v_cascade);
END;
$$;

-- complete_wave
CREATE OR REPLACE FUNCTION complete_wave(
  p_wave_id   uuid,
  p_actor     text DEFAULT 'system',
  p_post_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  w public.waves%ROWTYPE;
  mv RECORD;
  v_posted integer := 0;
  v_outbound integer := 0;
BEGIN
  SELECT * INTO w FROM public.waves WHERE id = p_wave_id FOR UPDATE;
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
    SELECT id FROM public.movements
     WHERE wave_id = w.id AND status = 'PLANNED'
     ORDER BY coalesce(seq, 0), created_at
  LOOP
    PERFORM public.post_movement(mv.id, p_actor, p_post_date);
    v_posted := v_posted + 1;
  END LOOP;

  WITH done AS (
    UPDATE public.outbound
       SET status = 'COMPLETED', completed_at = now(), completed_by = p_actor
     WHERE wave_id = w.id AND status = 'PLANNED' AND origin = 'ALLOCATION'
    RETURNING id
  )
  SELECT count(*) INTO v_outbound FROM done;

  UPDATE public.waves SET status = 'COMPLETED' WHERE id = w.id;
  PERFORM public.record_execution_event('WAVE', w.id, w.status, 'COMPLETED', NULL, p_actor);

  RETURN jsonb_build_object('result', 'POSTED', 'wave_id', w.id,
                            'movements_posted', v_posted,
                            'outbound_completed', v_outbound);
END;
$$;

-- post_inbound
CREATE OR REPLACE FUNCTION post_inbound(
  p_inbound_id uuid,
  p_actor      text DEFAULT 'system',
  p_post_date  date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.inbound%ROWTYPE;
  v_date date;
BEGIN
  SELECT * INTO i FROM public.inbound WHERE id = p_inbound_id FOR UPDATE;
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

  PERFORM public.apply_stock_delta(i.location, i.sku, i.batch, i.expiry_date, i.quantity,
    jsonb_build_object('description', i.description, 'upp', i.upp, 'uom', i.uom));
  PERFORM public.record_stock_transaction(
    'INBOUND', i.location, i.sku, i.batch, i.expiry_date, i.quantity,
    'INBOUND', i.id::text, NULL, NULL, i.reference_no, p_actor, v_date);

  UPDATE public.inbound
     SET status = 'COMPLETED', completed_at = now(), completed_by = p_actor
   WHERE id = i.id AND status = 'PENDING';

  PERFORM public.record_execution_event('INBOUND', i.id, 'PENDING', 'COMPLETED', NULL, p_actor);

  RETURN jsonb_build_object('result', 'POSTED', 'inbound_id', i.id, 'quantity', i.quantity);
END;
$$;

-- post_outbound
CREATE OR REPLACE FUNCTION post_outbound(
  p_outbound_id uuid,
  p_actor       text DEFAULT 'system',
  p_post_date   date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  o public.outbound%ROWTYPE;
  v_date date;
BEGIN
  SELECT * INTO o FROM public.outbound WHERE id = p_outbound_id FOR UPDATE;
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

  PERFORM public.apply_stock_delta(o.location, o.sku, o.batch, o.expiry_date, -o.quantity);
  PERFORM public.record_stock_transaction(
    'OUTBOUND', o.location, o.sku, o.batch, o.expiry_date, -o.quantity,
    'OUTBOUND', o.id::text, o.wave_id, NULL, o.shipment_number, p_actor, v_date);

  UPDATE public.outbound
     SET status = 'COMPLETED', completed_at = now(), completed_by = p_actor
   WHERE id = o.id AND status = 'PLANNED';

  PERFORM public.record_execution_event('OUTBOUND', o.id, 'PLANNED', 'COMPLETED', NULL, p_actor);

  RETURN jsonb_build_object('result', 'POSTED', 'outbound_id', o.id, 'quantity', o.quantity);
END;
$$;

-- set_outbound_status
CREATE OR REPLACE FUNCTION set_outbound_status(
  p_outbound_id uuid,
  p_status      text,
  p_actor       text DEFAULT 'system',
  p_reason      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  o public.outbound%ROWTYPE;
BEGIN
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'USE_POST_OUTBOUND_OR_COMPLETE_WAVE|%', p_outbound_id;
  END IF;
  IF p_status NOT IN ('PLANNED', 'RESCHEDULED', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_STATUS|%', p_status;
  END IF;

  SELECT * INTO o FROM public.outbound WHERE id = p_outbound_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_FOUND|%', p_outbound_id;
  END IF;
  IF o.status = p_status THEN
    RETURN jsonb_build_object('result', 'NO_CHANGE', 'outbound_id', o.id, 'status', o.status);
  END IF;
  IF o.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'OUTBOUND_ALREADY_COMPLETED|%', o.id;
  END IF;

  UPDATE public.outbound SET status = p_status WHERE id = o.id;
  PERFORM public.record_execution_event('OUTBOUND', o.id, o.status, p_status, p_reason, p_actor);

  RETURN jsonb_build_object('result', 'UPDATED', 'outbound_id', o.id,
                            'from_status', o.status, 'to_status', p_status);
END;
$$;

-- adjust_stock
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
SET search_path = ''
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
  IF NOT EXISTS (SELECT 1 FROM public.stock WHERE identity_key = v_ident) THEN
    RAISE EXCEPTION 'STOCK_NOT_FOUND|%', v_ident;
  END IF;

  PERFORM public.apply_stock_delta(p_location, p_sku, p_batch, p_expiry, p_delta);

  SELECT quantity INTO v_new FROM public.stock WHERE identity_key = v_ident;

  PERFORM public.record_stock_transaction(
    'ADJUSTMENT', p_location, p_sku, p_batch, p_expiry, p_delta,
    'ADJUSTMENT', gen_random_uuid()::text, NULL, NULL, trim(p_reason), p_actor, p_date);

  RETURN jsonb_build_object('result', 'ADJUSTED', 'identity_key', v_ident,
                            'delta', p_delta, 'new_quantity', v_new);
END;
$$;

-- initial_import
CREATE OR REPLACE FUNCTION initial_import(
  p_rows  jsonb,
  p_actor text DEFAULT 'system',
  p_mode  text DEFAULT 'FAIL_ON_CONFLICT',
  p_date  date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r RECORD;
  v_ident    text;
  v_existing public.stock%ROWTYPE;
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

    SELECT * INTO v_existing FROM public.stock WHERE identity_key = v_ident FOR UPDATE;

    IF FOUND THEN
      IF p_mode = 'FAIL_ON_CONFLICT' THEN
        RAISE EXCEPTION 'PHYSICAL_IDENTITY_CONFLICT|%', v_ident;
      END IF;
      v_delta := r.quantity - v_existing.quantity;
      IF v_delta <> 0 THEN
        UPDATE public.stock
           SET quantity       = r.quantity,
               description    = CASE WHEN coalesce(r.description, '') = '' THEN public.stock.description ELSE r.description END,
               upp            = coalesce(nullif(r.upp, 0), public.stock.upp),
               uom            = coalesce(r.uom, public.stock.uom),
               is_full_pallet = (r.quantity >= coalesce(nullif(r.upp, 0), public.stock.upp))
         WHERE identity_key = v_ident;
        PERFORM public.record_stock_transaction(
          'INITIAL_IMPORT', r.location, r.sku, r.batch, r.expiry_date, v_delta,
          'INITIAL_IMPORT', 'reimport', NULL, NULL, 'REPLACE mode', p_actor, p_date);
      END IF;
      v_replaced := v_replaced + 1;
    ELSE
      INSERT INTO public.stock (
        location, sku, description, batch, expiry_date, quantity, upp, uom,
        aisle, bay, level, position, is_full_pallet, gr_date
      ) VALUES (
        r.location, r.sku, coalesce(r.description, ''), r.batch, r.expiry_date, r.quantity,
        greatest(coalesce(r.upp, 1), 1), r.uom,
        coalesce(r.aisle, ''), r.bay, r.level, r.position,
        r.quantity >= greatest(coalesce(r.upp, 1), 1), r.gr_date
      );
      PERFORM public.record_stock_transaction(
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

-- set_inbound_status (from 0003)
CREATE OR REPLACE FUNCTION set_inbound_status(
  p_inbound_id uuid,
  p_status     text,
  p_actor      text DEFAULT 'system',
  p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  i public.inbound%ROWTYPE;
BEGIN
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'USE_POST_INBOUND|%', p_inbound_id;
  END IF;
  IF p_status NOT IN ('PENDING', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_STATUS|%', p_status;
  END IF;

  SELECT * INTO i FROM public.inbound WHERE id = p_inbound_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INBOUND_NOT_FOUND|%', p_inbound_id;
  END IF;
  IF i.status = p_status THEN
    RETURN jsonb_build_object('result', 'NO_CHANGE', 'inbound_id', i.id, 'status', i.status);
  END IF;
  IF i.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'INBOUND_ALREADY_COMPLETED|%', i.id;
  END IF;

  UPDATE public.inbound SET status = p_status WHERE id = i.id;
  PERFORM public.record_execution_event('INBOUND', i.id, i.status, p_status, p_reason, p_actor);

  RETURN jsonb_build_object('result', 'UPDATED', 'inbound_id', i.id,
                            'from_status', i.status, 'to_status', p_status);
END;
$$;

-- daily_summary (from 0003)
CREATE OR REPLACE FUNCTION daily_summary(p_date date)
RETURNS TABLE (
  identity_key   text,
  location       text,
  sku            text,
  batch          text,
  expiry_date    date,
  opening_qty    bigint,
  initial_import bigint,
  inbound_qty    bigint,
  pick_qty       bigint,
  outbound_qty   bigint,
  reloc_in_qty   bigint,
  reloc_out_qty  bigint,
  adjustment_qty bigint,
  closing_qty    bigint
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    i.identity_key,
    split_part(i.identity_key, '|', 1) AS location,
    split_part(i.identity_key, '|', 2) AS sku,
    nullif(split_part(i.identity_key, '|', 3), '') AS batch,
    split_part(i.identity_key, '|', 4)::date AS expiry_date,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date < p_date), 0) AS opening_qty,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date = p_date AND t.transaction_type = 'INITIAL_IMPORT'), 0) AS initial_import,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date = p_date AND t.transaction_type = 'INBOUND'), 0) AS inbound_qty,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date = p_date AND t.transaction_type = 'PICK'), 0) AS pick_qty,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date = p_date AND t.transaction_type = 'OUTBOUND'), 0) AS outbound_qty,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date = p_date AND t.transaction_type = 'RELOC_IN'), 0) AS reloc_in_qty,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date = p_date AND t.transaction_type = 'RELOC_OUT'), 0) AS reloc_out_qty,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date = p_date AND t.transaction_type = 'ADJUSTMENT'), 0) AS adjustment_qty,
    coalesce(sum(t.quantity_delta) FILTER (WHERE t.transaction_date <= p_date), 0) AS closing_qty
  FROM public.stock_transactions t
  JOIN (SELECT DISTINCT identity_key FROM public.stock_transactions) i USING (identity_key)
  GROUP BY i.identity_key
  ORDER BY i.identity_key;
$$;

-- =============================================================================
-- 2. EXECUTE privileges — stock-mutating RPCs restricted to service_role
--    The browser only calls set_*_status and daily_summary via the publishable
--    key.  Stock-mutating functions (apply_stock_delta, record_*_*, post_*,
--    complete_wave, adjust_stock, initial_import) must ONLY be callable with
--    the secret/service-role key.
-- =============================================================================

-- Revoke broad EXECUTE that was granted in 0003, then selectively re-grant.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      -- Stock-mutating functions: revoke from anon and authenticated
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.apply_stock_delta(text, text, text, date, integer, jsonb) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.record_stock_transaction(text, text, text, text, date, integer, text, text, uuid, uuid, text, text, date) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.record_execution_event(text, uuid, text, text, text, text) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.post_movement(uuid, text, date) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.complete_wave(uuid, text, date) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.post_inbound(uuid, text, date) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.post_outbound(uuid, text, date) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.adjust_stock(text, text, text, date, integer, text, text, date) FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.initial_import(jsonb, text, text, date) FROM %I', r);
    END IF;
  END LOOP;
END;
$$;

-- =============================================================================
-- 3. View security — stock_vs_ledger uses security_invoker
--    With security_invoker = true the view runs under the querying role's
--    permissions (respecting RLS) rather than the view owner (superuser).
-- =============================================================================

ALTER VIEW public.stock_vs_ledger SET (security_invoker = true);
