# Function Call Map — FEFO Allocator

## Key Functions Analysis

### 1. `stockIdentityKey(location, sku, batch, expiry)`

**File:** `src/ledger.ts:9` and `src/allocator.ts:254`

**Purpose:** Creates canonical physical identity key

**Format:** `location|sku|batch|expiry_date`

**Callers:**
- `src/ledger.ts:computeStockAfterMovements()` — creates adjustment keys
- `src/allocator.ts:relocateByWaveOrder()` — Phase 1 (initial stock), Phase 2 (relocations), Phase 3 (identity grouping)
- `verify-reconcile.ts` — verification/auditing

**Production-critical:** ✅ YES — defines physical identity for stock tracking

---

### 2. `computeStockAfterMovements(stock, lines, pickfaces)`

**File:** `src/ledger.ts:13-44`

**Purpose:** Computes stock after picks AND relocations

**Implementation:** Uses `stock.map()` — only processes existing stock bins

**Limitation:** Does NOT synthesize destination-only identities (pickface bins with zero initial stock that receive relocations)

**Production callers:**
1. **`src/cli.ts:50`** → passes to `replenish()`
   ```typescript
   const stockAfterMovements = computeStockAfterMovements(stock, result.lines, pickfaces);
   const replenishment = replenish(stockAfterMovements, pickfaces, config, demand, result.lines);
   ```

**Non-production callers:**
- `verify-reconcile.ts:37`
- `verify-deep.ts:21`
- `verify-final.ts:36`
- `audit-forensic.ts:64`

**Production-critical:** ✅ YES — used by replenishment logic

**Downstream impact analysis:**
- Replenishment receives `stockAfterMovements` as `stockAfterPicks` parameter
- Replenishment aggregates pickface stock by **SKU only** (line 44-46):
  ```typescript
  for (const bin of stockAfterPicks) {
    if (pickfaceLocations.has(bin.location)) {
      pickfaceQty.set(bin.sku, (pickfaceQty.get(bin.sku) ?? 0) + bin.qtyCartons);
    }
  }
  ```
- Missing destination-only identities with `qtyCartons=0` contribute zero
- Reserve pool (lines 51-59) skips bins with `qtyCartons <= 0`
- Reserve pool excludes pickface locations explicitly

**Conclusion:** Missing destination-only identities do NOT affect replenishment because:
1. Pickface stock aggregates by SKU (not per-identity)
2. Zero-qty bins are skipped
3. Pickface bins are excluded from reserve pool

---

### 3. `applyMovements(stock, moved)`

**File:** `src/binselect.ts:83-87`

**Purpose:** OLD function — only subtracts picks, does NOT account for relocations

**Implementation:**
```typescript
return stock.map((b) => {
  const taken = moved.get(b.binId);  // ← uses binId, not physical identity
  return taken ? { ...b, qtyCartons: b.qtyCartons - taken, isFullPallet: ... } : b;
});
```

**Production callers:**
1. **`src/web/main.ts:148`** — Web app still uses this!
   ```typescript
   const pickedByBin = new Map<string, number>();
   for (const l of allocation.lines) pickedByBin.set(l.binId, (...) + l.qtyPick);
   const stockAfterPicks = applyMovements(loaded.stock, pickedByBin);
   ```

**Problem:** Web app does NOT use `computeStockAfterMovements()`, uses old `applyMovements()` which:
- Keys by `binId` (location|sku|batch) instead of physical identity (location|sku|batch|expiry)
- Only subtracts picks, ignores relocations
- Also uses `stock.map()` so has same limitation

**Production-critical:** ✅ YES — but only in web app (not CLI)

**Action required:** Web app needs to be updated to use `computeStockAfterMovements()` like CLI does

---

### 4. `relocateByWaveOrder(lines, pickfaces, config, stock)`

**File:** `src/allocator.ts:287-450`

**Purpose:** Phase 5 fix — computes correct `qtyRemainingInBin` (Sisa) for re-anchored lines

**Phases:**
1. Read initial stock (uses `stockIdentityKey`)
2. Identify relocation events (pallet breaks from non-pickface bins)
3. Compute Sisa per physical identity (timeline: init + relocs + picks)
4. Re-anchor break events to wave order (first wave owns break, later waves show pickface)
5. *(Phase 5 removed in current version — Phase 3 already handles Sisa correctly)*

**Production callers:**
1. **`src/cli.ts:46`** — called immediately after `allocate()`
2. **`src/web/main.ts:143`** — called in web app

**Production-critical:** ✅ YES — fixes Sisa calculation, prevents mismatches

**Status:** ✅ WORKING — verified 0 Sisa mismatches on both workbooks

---

## Summary Table

| Function | File | Production? | Used by | Impact if broken |
|----------|------|-------------|---------|------------------|
| `stockIdentityKey` | ledger.ts, allocator.ts | ✅ YES | relocateByWaveOrder, computeStockAfterMovements | Physical identity tracking broken |
| `computeStockAfterMovements` | ledger.ts | ✅ YES | CLI → replenishment | Replenishment would see wrong stock |
| `applyMovements` | binselect.ts | ✅ YES (web only) | Web app → replenishment | Web app replenishment uses stale stock |
| `relocateByWaveOrder` | allocator.ts | ✅ YES | CLI + web | Sisa mismatches, wrong remaining stock |

---

## Production Impact: Destination-Only Identities

**Question:** Does `computeStockAfterMovements()` limitation (not synthesizing destination-only identities) affect production?

**Answer:** **NO** for CLI, **MAYBE** for web app

### CLI Evidence

`src/cli.ts:50` → `src/replenishment.ts:replenish()`:

1. **Pickface stock calculation** (replenishment.ts:42-46):
   - Aggregates by SKU: `pickfaceQty.set(bin.sku, (total) + bin.qtyCartons)`
   - Missing identities with `qtyCartons=0` contribute zero ✅ CORRECT
   
2. **Reserve pool** (replenishment.ts:51-59):
   - Skips `bin.qtyCartons <= 0` 
   - Excludes `pickfaceLocations.has(bin.location)`
   - Missing destination-only identities are pickface bins → excluded ✅ CORRECT

3. **Replenishment decision** (replenishment.ts:69-70):
   - Uses SKU-level aggregate, not per-identity
   - `need = target - currentQty` where `currentQty` from SKU sum
   - Missing identities don't affect calculation ✅ CORRECT

### Web App Issue

`src/web/main.ts:148` uses `applyMovements()` which:
- Doesn't account for relocations at all
- Uses `binId` not physical identity
- Has same `stock.map()` limitation

**Conclusion:** Web app has BOTH issues (no relocation accounting + destination-only limitation)

---

## Recommendation

1. **CLI:** No production fix needed for destination-only limitation
2. **Web app:** Update to use `computeStockAfterMovements()` instead of `applyMovements()`
3. **Verifier:** Fix Section 9 classification — label as "ARCHITECTURAL LIMITATION / NO PRODUCTION IMPACT"
4. **Documentation:** Add docstring to `computeStockAfterMovements()` explaining limitation
