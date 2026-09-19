# FEFO Allocator, Pickface Replenishment & Movement Report

Takes the daily WMS workbook (stock on hand + `Schedule of the day`) and produces:

1. **Outbound picklists** under strict FEFO, travel-sorted.
2. **Bin-to-bin pickface replenishment** — tops up each SKU's dedicated pick
   bin from reserve stock, using the *exact same* FEFO + tie-break rule as
   outbound picking.
3. **A movement report** — one ledger of everything that moved, from what item
   to where: every pick (bin → shipment) and every replenishment (reserve bin
   → pickface bin).

Shortages and data exceptions are reported, never silently swallowed.

TypeScript / Node 20+. No framework, no PHP — the allocation engine is a pure
function, so it drops straight into `k-one-v2` (NestJS) later without a
rewrite. Stock can live either in the daily WMS workbook (default) or in a
**Supabase / PostgreSQL database** (see [Database mode](#database-mode-supabase--postgresql)).
There are two ways to run it:

**CLI** (writes files to disk):
```bash
npm install
npm run allocate
```

**Web app** (runs the identical engine in the browser — drag in a workbook, get
tables and downloads, nothing leaves the tab):
```bash
npm run web
```
Then open the printed `http://localhost:5173` link. See `QUICKSTART.md`.

Output: `picklist_<date>.xlsx` (Picklist / Summary / Shortage / Exceptions /
**Replenishment** / **Replenishment Shortage** / **Movement Report**) and
`picklist_<date>.html` (A4 print sheet, one page per outbound task).

---

## The rules, in the order they are applied

Per demand line (one shipment + one material; multiple SAP orders for the same
shipment/material are merged and their order numbers kept for traceability):

1. **Eligibility.** A bin is pickable only if it is a rack location
   (`C[A-G]dd[A-E]dd`), status `Aktif`, qty > 0, not blocked, and has at least
   `minRemainingShelfLifeDays` of life left at the run date. `STAGING`,
   `STAGING_INB` and `Quarantine` are never picked from.
2. **FEFO.** The earliest expiry date still on hand is served first. No bin with
   a later expiry is touched while stock of an earlier one remains. This is
   absolute — every other rule only operates *inside* one expiry date.
3. **Tie-break inside the expiry date** (this is where handling cost lives):
   - need ≥ 1 pallet → take a **sealed full pallet**, nearest along the pick path
     (forklift move, no touching of cartons);
   - need < 1 pallet → take from an **already-open pallet**, *best fit*: the
     smallest open bin that still covers the need, so fragments get cleared out
     of the rack instead of accumulating;
   - only if no open pallet of that batch exists is a sealed pallet broken, and
     the line is flagged `breaksPallet` / `CASE*` on the sheet.
   - Equal otherwise → the bin closest along the route.
4. **Repeat** until the line is filled; any balance becomes a shortage with a
   reason: `ALREADY_STAGED` (stock is already in the staging lane — that
   shipment was picked earlier), `BLOCKED_SHELF_LIFE`, or `NO_STOCK`.

Quantities are in **cartons (CAR)** throughout, matching SAP `Delivery quantity`
and WMS `Qty`. `UPP` is cartons per pallet, read from the WMS row and falling
back to `MASTER DATA`.

### Pickface replenishment — the bin-to-bin part

Run **after** outbound allocation, against whatever stock is left once today's
orders are reserved, so replenishment never takes a carton an order needs.

- **Pickface bin.** One dedicated pick-from bin per SKU. Without an admin
  assignment (`config.pickfaceOverrides`), it's derived automatically as
  whichever bin currently holding that SKU sits earliest on the pick path —
  everything else of that SKU is reserve stock. This mirrors your own design
  (a permanent per-SKU CRUD assignment later); the auto-derivation is just a
  sensible starting point until that exists.
- **Trigger.** A pickface is topped up when its on-hand falls below its
  target level (default: one full pallet, `UPP` cartons — configurable to a
  flat number). If `replenishCoverPendingDemand` is on (default), the target
  also rises to cover today's outbound demand for that SKU, so a big order
  doesn't strand the picker mid-pick.
- **Source selection — identical rule to outbound picking.** Earliest expiry
  first; a whole-pallet need takes a sealed pallet nearest on the route; a
  loose remainder takes from an already-open pallet, best fit, before a sealed
  one is ever broken. This is literally the same function
  (`binselect.ts: selectNextBin`), not a re-implementation — a pickface never
  gets stock out of FEFO order.
- **A pickface bin is never a replenishment source.** It's topped up, not
  drawn from, even if it happens to be sitting on stock of another SKU.

### Movement report — what moved, from what item to where

One combined, chronological ledger:

| Seq | Type | Material | From | To | Qty | Shipment |
|---|---|---|---|---|---|---|
| 1 | REPLEN | 550044709 | CB02E02 | CB20D01 (pickface) | 48 | — |
| 2 | PICK | 550044709 | CB20D01 | STAGING → 109661414 | 44 | 109661414 |

Replenishment rows come first (stock lands on the pickface before the pick
that needs it), then picks, in pick-sequence order. This is the audit trail
for "what did the picklist do to the WMS sheet" — every row is a real bin
quantity change, traceable to a SKU, a batch, and an expiry date.

### Pick path

Picklists are sorted by travel order, not by SKU: aisles in configured sequence,
**serpentine** (every second aisle walked back-to-front, no empty return leg),
then ground level first, then position. Each line carries a 2-digit check digit
derived from the location code for scan verification.

Forklift work (full pallets) and handpick work (loose cartons) are emitted as
**separate picklists per shipment** (`-FL` / `-HP`), so one operator isn't
switching equipment mid-run. Set `splitPalletAndCaseTasks: false` for one
combined sheet.

---

## Result on the 15 September workbook

| Outbound picking | |
|---|---|
| Eligible rack bins | 1,751 |
| Demand | 73 lines / 17 shipments / 4,800 cartons |
| Allocated | 4,730 cartons — **98.54 %** fill |
| Pick instructions | 206 (100 full-pallet, 106 case) |
| Sealed pallets opened | 26 |
| Picklists | 32 |
| Shortages | 4 lines / 70 cartons — all `ALREADY_STAGED` |
| FEFO violations (audited) | **0** |

| Pickface replenishment | |
|---|---|
| Pickfaces evaluated | 92 |
| Pickfaces replenished | 35 |
| Cartons moved | 3,564 (87 pallet moves, 40 case moves) |
| Sealed pallets opened | 18 |
| Replenishment shortages | 31 SKUs with no reserve stock left to top up from |
| FEFO violations (audited) | **0** — and **0** moves ever draw from a pickface bin |

The four outbound shortages are materials already sitting in `STAGING`
(550049044, 550074326, 550024986, 550025055) — those shipments were picked
before the snapshot was taken. The allocator says so explicitly rather than
reporting a false stock-out.

One bin was rejected as expired, and 8 lines legitimately span more than one
expiry date because FEFO drained the oldest batch first.

---

## Layout

```
src/
  types.ts                    domain model
  config.ts                   every business rule, one place
  binselect.ts                the FEFO bin-choice rule — shared by picking AND replenishment
  allocator.ts                outbound allocation, built on binselect.ts
  pickface.ts                 derives each SKU's dedicated pickface bin
  replenishment.ts            bin-to-bin pickface top-up, built on binselect.ts
  movement.ts                 combines picks + replenishment into one audit ledger
  picklist.ts                 task grouping, splitting, sequencing
  pickpath.ts                 location parsing, serpentine ordering, check digit
  ledger.ts                   physical-identity Sisa ledger (location+sku+batch+expiry)
  adapters/excel-input.ts     workbook → domain (Node/ExcelJS; column names declared here only)
  adapters/excel-output.ts    → picklist workbook (Node/ExcelJS)
  adapters/html-output.ts     → A4 print sheet (framework-agnostic, used by both CLI and web)
  adapters/database-stock.ts  DB stock rows → StockBin[] (the allocator's third input adapter)
  adapters/wms-importer.ts    workbook → import preview → initial_import RPC
  lib/supabase.ts             server (service key) + browser (publishable key) clients
  lib/errors.ts               pipe-delimited SQL codes → readable WmsError
  repository/                 typed repositories — reads are selects, mutations go through RPCs
  services/                   planning / execution / daily / reconciliation / adjustment / export
  cli.ts                      Node command-line entry point (--db switches stock source)
  cli-import.ts               `npm run import:wms` — preview + confirm import
  web/
    browser-input.ts          workbook → domain (browser/SheetJS, same column mapping)
    browser-output.ts         → picklist workbook (browser/SheetJS)
    main.ts                   web app: upload, run, render, download
    ops.ts                    Ops area: inventory / inbound / outbound / execution / database
supabase/migrations/          SQL schema, posting RPCs, RLS + reconciliation views
tests/                        db-integration + parity suites (real PostgreSQL, loud skip)
web/
  index.html                  the page
  bundle.js, ops-bundle.js    built by `npm run build:web` — do not hand-edit
```

`allocate()`, `replenish()`, and `buildPicklists()` touch no I/O and share no
DOM or Node dependency — `binselect.ts` is the one place the actual bin-choice
rule lives, imported by both. Excel is just an adapter, in two flavours (Node
ExcelJS for the CLI, browser SheetJS for the web app) so the same engine runs
identically in both places — confirmed by running both against the same
workbook and diffing the stats. The same engine runs against Postgres later by
writing a third adapter that returns `StockBin[]` and `DemandLine[]`.

---

## Database mode (Supabase / PostgreSQL)

An optional persistence layer makes PostgreSQL the **source of truth for
stock**, while the allocator above stays byte-for-byte the same. The daily flow
becomes:

```
WMS workbook ──import──▶ stock (DB) ──allocate──▶ waves + movements + outbound
      (one-off)              ▲                        (all PLANNED — no stock moved)
                             │                                │
                    stock_transactions ◀──post_movement── warehouse executes
                     (immutable ledger)      / complete_wave        (truck ships)
                             │
                       current stock ──▶ next day's allocation
```

**The five rules the whole layer is built on**

- **PLANNED ≠ EXECUTED.** Planning writes `waves` (PENDING), `movements`
  (PLANNED) and `outbound` (PLANNED). *Nothing* touches `stock`. Stock changes
  **only** when a movement is posted or its wave completed.
- **Physical identity = location + SKU + batch + expiry.** Two expiry dates in
  one bin are two rows, never merged. Enforced by a trigger-maintained
  `identity_key` (`loc|sku|batch|YYYY-MM-DD`) with a UNIQUE constraint — the
  exact mirror of `stockIdentityKey()` in `src/ledger.ts`.
- **Every stock change writes an immutable `stock_transactions` row**
  (INITIAL_IMPORT / INBOUND / OUTBOUND / PICK / RELOC_IN / RELOC_OUT /
  ADJUSTMENT). The ledger is append-only — RLS forbids UPDATE and DELETE — so
  `stock.quantity = SUM(quantity_delta)` always holds (`stock_vs_ledger` view
  proves it).
- **Idempotent, atomic, never negative.** Posting is a compare-and-set on
  status: doing it twice changes stock exactly once (`ALREADY_POSTED`). A
  replenishment (source −N *and* destination +N) is one transaction — it either
  fully happens or fully rolls back. Decrements are guarded, so stock can never
  go negative.
- **Excel is input, not truth.** The original workbook is never modified; the
  DB→Excel export writes a new `WMS_updated_<timestamp>.xlsx`.

**Tables** — `stock`, `stock_transactions`, `inbound`, `outbound`, `waves`,
`movements`, `execution_events` (status-transition audit). All stock mutations
run through `SECURITY DEFINER` RPCs (`post_movement`, `complete_wave`,
`post_inbound`, `post_outbound`, `adjust_stock`, `initial_import`, …); clients
holding the publishable key can read everything and insert/plan, but can never
flip a row to COMPLETED or edit a quantity directly (RLS + CHECK).

### Migrations

Three version-controlled files under `supabase/migrations/`:
`0001_initial_schema.sql`, `0002_posting_functions.sql`, `0003_rls_and_views.sql`.

```bash
supabase db push          # to a linked Supabase project, or
supabase migration up     # apply pending migrations locally
```

### Setup (manual, once)

1. Create a Supabase project (or any PostgreSQL 16).
2. Apply the three migrations (`supabase db push`).
3. Copy `.env.example` → `.env.local` and fill in `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_PUBLISHABLE_KEY` (browser-safe) and `SUPABASE_SERVICE_ROLE_KEY`
   (server only — never `VITE_`-prefixed, never committed).
4. Rebuild the web bundle (`npm run build:web`) — the publishable key is
   injected at build time; the service key is never bundled.
5. Import the opening snapshot, then run allocations from the DB:

```bash
npm run import:wms -- "data/Warehouse_Management_System_18_September_2026_.xlsx"
npm start -- "data/….xlsx" --db --out out      # --db (or DATABASE_MODE=true) reads stock from the DB
```

The web app has an **Ops** area (Inventory / Inbound / Outbound / Execution /
Database) that appears once the browser config is present; without it the tab
shows a "database not configured" notice and the existing allocator flow is
untouched.

### Tests

```bash
npm test         # 40 sisa/FEFO regressions — no database needed
npm run test:db  # 32 integration checks — requires TEST_DATABASE_URL (local postgres:16)
npm run test:parity   # Excel-fed vs DB-fed allocation identical + 550076636 DB replay
```

`test:db` and `test:parity` create a throwaway database, apply the migrations
from scratch, and **skip loudly** (never a false pass) when `TEST_DATABASE_URL`
is unset. Quick local server:

```bash
docker run -d --name fefo-test -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:16
TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres npm run test:db
```


### Configuration worth tuning

| Key | Default | Effect |
|---|---|---|
| `minRemainingShelfLifeDays` | 180 | stock below this is refused |
| `nearExpiryWarningDays` | 365 | flagged, still picked |
| `preferOpenPalletForRemainder` | true | don't break a sealed pallet for a remainder |
| `bestFitOpenPallets` | true | clear the smallest usable fragment first |
| `serpentine` | true | alternate aisle direction |
| `splitPalletAndCaseTasks` | true | separate forklift and handpick sheets |
| `maxLinesPerPicklist` | 0 | split long sheets (0 = never) |
| `blockedBins` | `[]` | bins on cycle count / damage hold |

---

## Moving it into k-one-v2

The engine is the part worth keeping; the Excel adapter is scaffolding for
running it today.

1. **Adapter swap.** Replace `loadWorkbook()` with a repository that reads
   `stock_bins` and open delivery lines from Postgres. Everything downstream is
   unchanged.
2. **NestJS service.** Wrap `allocate()` in an `AllocationService`; expose
   `POST /allocations/run` returning the same result shape.
3. **Concurrency.** Two allocation runs must not hand out the same carton. Take
   the existing `redis-lock` per warehouse for the run, or select candidate bins
   `FOR UPDATE SKIP LOCKED` and persist the allocations as reservations
   (`qty_reserved` on the bin) in one transaction. The engine is deterministic,
   so a replay after rollback yields an identical picklist.
4. **Async.** For large waves, push the run onto the existing BullMQ queue in
   `apps/worker` and stream progress; the engine itself is fast enough
   (1,751 bins × 73 lines runs in well under a second) that this is only needed
   for multi-wave batching.
5. **Replenishment hook.** When a pick empties or nearly empties a bin, the
   result already carries `qtyRemainingInBin`; feed those lines into the
   pickface top-up logic instead of recomputing on-hand afterwards.
6. **Web app → apps/web.** `src/web/main.ts` is the shape of the eventual
   NestJS-backed page: swap `browser-input.ts`/`browser-output.ts` for calls to
   the new API, keep the same tab layout and table rendering. The engine calls
   (`allocate`, `derivePickfaces`, `replenish`, `buildMovementReport`) don't
   change at all — only where the data comes from does.

### Data quality flagged by this run

- 57 duplicate `Lokasi` rows in the stock sheet (mostly staging/quarantine
  lines). Duplicates inside the rack range are reported as `DUPLICATE_BIN` —
  worth resolving before the Postgres migration, since a bin must be unique.
- Bay numbers run to 40 on CB/CD/CF/CG in this workbook. If the physical racks
  are shorter, set `bayLimits` validation when migrating so bogus locations are
  rejected at import rather than at pick time.
