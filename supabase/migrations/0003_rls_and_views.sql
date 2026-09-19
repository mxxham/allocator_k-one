-- =============================================================================
-- 0003 — Row Level Security, reconciliation views, guarded grants
-- =============================================================================
-- Security model:
--   * The browser only ever holds the Supabase publishable (anon) key.
--   * stock and stock_transactions are READ-ONLY for clients: every mutation
--     goes through the SECURITY DEFINER RPCs in 0002, which enforce status
--     compare-and-set, sufficiency and auditability. Clients cannot UPDATE or
--     DELETE ledger rows at all (default-deny: no policies => no access).
--   * Planning tables (waves/inbound/outbound/movements) accept client INSERT
--     only in their initial PLANNED/PENDING status and only allow client
--     UPDATE while a row is still PLANNED/PENDING — a client can never flip a
--     row to COMPLETED directly and bypass the stock posting functions.
--   * The service-role key (server-side only) bypasses RLS.
-- =============================================================================

ALTER TABLE stock              ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE waves              ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound            ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound           ENABLE ROW LEVEL SECURITY;
ALTER TABLE movements          ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_events   ENABLE ROW LEVEL SECURITY;

-- ---- stock: read-only for clients ------------------------------------------
CREATE POLICY stock_select ON stock
  FOR SELECT TO anon, authenticated USING (true);

-- ---- stock_transactions: read-only for clients (immutable ledger) -----------
CREATE POLICY stx_select ON stock_transactions
  FOR SELECT TO anon, authenticated USING (true);

-- ---- waves ------------------------------------------------------------------
CREATE POLICY waves_select ON waves
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY waves_insert ON waves
  FOR INSERT TO anon, authenticated WITH CHECK (status = 'PENDING');
CREATE POLICY waves_update ON waves
  FOR UPDATE TO anon, authenticated
  USING (status = 'PENDING') WITH CHECK (status = 'PENDING');

-- ---- inbound ----------------------------------------------------------------
CREATE POLICY inbound_select ON inbound
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY inbound_insert ON inbound
  FOR INSERT TO anon, authenticated WITH CHECK (status = 'PENDING');
CREATE POLICY inbound_update ON inbound
  FOR UPDATE TO anon, authenticated
  USING (status = 'PENDING') WITH CHECK (status = 'PENDING');

-- ---- outbound ----------------------------------------------------------------
CREATE POLICY outbound_select ON outbound
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY outbound_insert ON outbound
  FOR INSERT TO anon, authenticated WITH CHECK (status = 'PLANNED');
CREATE POLICY outbound_update ON outbound
  FOR UPDATE TO anon, authenticated
  USING (status = 'PLANNED') WITH CHECK (status = 'PLANNED');

-- ---- movements ---------------------------------------------------------------
CREATE POLICY movements_select ON movements
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY movements_insert ON movements
  FOR INSERT TO anon, authenticated WITH CHECK (status = 'PLANNED');
CREATE POLICY movements_update ON movements
  FOR UPDATE TO anon, authenticated
  USING (status = 'PLANNED') WITH CHECK (status = 'PLANNED');

-- ---- execution_events: append-only audit --------------------------------------
CREATE POLICY exec_events_select ON execution_events
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY exec_events_insert ON execution_events
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- No DELETE policies anywhere: deletes are impossible for anon/authenticated.

-- -----------------------------------------------------------------------------
-- set_inbound_status — non-completing transitions for inbound rows
-- (CANCELLED / back to PENDING). Never touches stock. COMPLETED must go
-- through post_inbound.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_inbound_status(
  p_inbound_id uuid,
  p_status     text,
  p_actor      text DEFAULT 'system',
  p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i inbound%ROWTYPE;
BEGIN
  IF p_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'USE_POST_INBOUND|%', p_inbound_id;
  END IF;
  IF p_status NOT IN ('PENDING', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_STATUS|%', p_status;
  END IF;

  SELECT * INTO i FROM inbound WHERE id = p_inbound_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INBOUND_NOT_FOUND|%', p_inbound_id;
  END IF;
  IF i.status = p_status THEN
    RETURN jsonb_build_object('result', 'NO_CHANGE', 'inbound_id', i.id, 'status', i.status);
  END IF;
  IF i.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'INBOUND_ALREADY_COMPLETED|%', i.id;
  END IF;

  UPDATE inbound SET status = p_status WHERE id = i.id;
  PERFORM record_execution_event('INBOUND', i.id, i.status, p_status, p_reason, p_actor);

  RETURN jsonb_build_object('result', 'UPDATED', 'inbound_id', i.id,
                            'from_status', i.status, 'to_status', p_status);
END;
$$;

-- -----------------------------------------------------------------------------
-- Reconciliation: current stock vs the sum of its ledger.
-- A healthy warehouse always shows mismatch = 0 on every identity.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW stock_vs_ledger AS
SELECT
  coalesce(s.identity_key, t.identity_key)        AS identity_key,
  coalesce(s.quantity, 0)                         AS stock_quantity,
  coalesce(t.ledger_quantity, 0)                  AS ledger_quantity,
  coalesce(s.quantity, 0) - coalesce(t.ledger_quantity, 0) AS mismatch
FROM stock s
FULL OUTER JOIN (
  SELECT identity_key, sum(quantity_delta) AS ledger_quantity
  FROM stock_transactions
  GROUP BY identity_key
) t ON t.identity_key = s.identity_key;

-- -----------------------------------------------------------------------------
-- daily_summary — opening stock, day's activity and closing stock per identity.
-- Answers: what was the opening stock, what inbound/outbound/relocations/
-- adjustments happened, what is the closing stock (§22).
-- -----------------------------------------------------------------------------
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
SET search_path = public
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
  FROM stock_transactions t
  JOIN (SELECT DISTINCT identity_key FROM stock_transactions) i USING (identity_key)
  GROUP BY i.identity_key
  ORDER BY i.identity_key;
$$;

-- -----------------------------------------------------------------------------
-- Grants — guarded so the migration also runs on plain PostgreSQL where the
-- Supabase roles do not exist (the test harness creates them itself).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO %I', r);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', r);
    END IF;
  END LOOP;
END;
$$;
