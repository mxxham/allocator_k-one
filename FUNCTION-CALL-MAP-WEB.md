# Web Application applyMovements() Audit

**Date:** 2026-09-18T16:52:00+07:00  
**Scope:** Complete trace of `applyMovements()` usage and production impact

---

## Definition

**File:** `src/binselect.ts:83-87`

```typescript
export function applyMovements(stock: StockBin[], moved: Map<string, number>): StockBin[] {
  return stock.map((b) => {
    const taken = moved.get(b.binId);
    return taken ? { ...b, qtyCartons: b.qtyCartons - taken, isFullPallet: b.qtyCartons - taken >= b.upp } : b;
  });
}
```

### What it does:
- Takes original stock
- Subtracts picked quantities keyed by `binId`  
- Returns modified stock array

### What it does NOT do:
- ❌ Does NOT account for relocations (source → pickface)
- ❌ Uses `binId` (location|sku|batch) not physical identity (location|sku|batch|expiry)
- ❌ Only processes `stock.map()` (same limitation as `computeStockAfterMovements`)

---

## All Callers

### 1. `src/web/main.ts:148` — **PRODUCTION WEB APP**

```typescript
const pickedByBin = new Map<string, number>();
for (const l of allocation.lines) 
  pickedByBin.set(l.binId, (pickedByBin.get(l.binId) ?? 0) + l.qtyPick);

const stockAfterPicks = applyMovements(loaded.stock, pickedByBin);

replenishment = replenish(stockAfterPicks, pickfaces, config, loaded.demand, allocation.lines);
```

**Purpose:** Compute stock after picks to pass to replenishment

**Usage path:**
```
applyMovements()
  ↓
stockAfterPicks
  ↓
replenish()
  ↓
replenishment.tasks (displayed in UI)
```

**User-visible output:**
- Replenishment tasks count
- Cartons moved count
- Replenishment shortage warnings

**Does NOT display:**
- ❌ Raw stock quantities
- ❌ Stock on-hand after allocation
- ❌ Inventory reports
- ❌ Physical bin quantities

---

### 2. `inspect-pdf.ts:31` — **UTILITY SCRIPT (NON-PRODUCTION)**

```typescript
const stockAfterPicks = applyMovements(stock, pickedByBin);
const rep = replenish(stockAfterPicks, pickfaces, config, demand, result.lines);
```

**Purpose:** PDF inspection utility

**Classification:** Test/debug tool, not production code

---

## Production Impact Analysis

### Question: Does `applyMovements()` limitation affect production?

**Answer: NO** (same as `computeStockAfterMovements`)

### Evidence

#### 1. Replenishment aggregates by SKU, not per-identity

`src/replenishment.ts:42-46`:
```typescript
const pickfaceQty = new Map<string, number>();
for (const bin of stockAfterPicks) {
  if (pickfaceLocations.has(bin.location)) {
    pickfaceQty.set(bin.sku, (pickfaceQty.get(bin.sku) ?? 0) + bin.qtyCartons);
  }
}
```

Missing relocated destination bins with `qtyCartons=0` contribute zero ✅

#### 2. Reserve pool excludes pickface bins

`src/replenishment.ts:51-59`:
```typescript
for (const bin of stockAfterPicks) {
  if (bin.qtyCartons <= 0) continue;  // ← Missing bins skipped
  if (pickfaceLocations.has(bin.location)) continue;  // ← Pickface excluded
  ...
}
```

Missing destination-only pickface bins are excluded ✅

#### 3. Replenishment uses SKU-level aggregates

`src/replenishment.ts:69-70`:
```typescript
const currentQty = pickfaceQty.get(pf.sku) ?? 0;
let need = target - currentQty;
```

Per-identity stock not required ✅

### Conclusion

`applyMovements()` has the SAME limitations as `computeStockAfterMovements()`:
- Does not account for relocations
- Does not synthesize destination-only identities
- Uses `stock.map()` approach

BUT these limitations do NOT affect production because:
1. Web app uses it ONLY to feed replenishment
2. Replenishment aggregates by SKU
3. Replenishment excludes pickface bins
4. Web app does NOT display raw stock quantities
5. Web app does NOT export inventory reports

---

## Comparison: CLI vs Web

| Aspect | CLI Path | Web Path | Impact |
|--------|----------|----------|--------|
| Function | `computeStockAfterMovements()` | `applyMovements()` | Same limitations |
| Accounts for relocations? | ✅ YES (in adjustments map) | ❌ NO | ⚠️ Different implementation |
| Synthesizes dest-only? | ❌ NO (stock.map) | ❌ NO (stock.map) | Same limitation |
| Physical identity | location\|sku\|batch\|expiry | binId (location\|sku\|batch) | ⚠️ Web omits expiry |
| Consumer | `replenish()` | `replenish()` | Same consumer |
| Production impact | NONE (proven) | NONE (same reasoning) | ✅ Both safe |

### Key Difference

**CLI (`computeStockAfterMovements`):**
```typescript
// Accounts for relocations in adjustments map
for (const line of lines) {
  if (!line.breaksPallet) continue;
  const pf = pickfaces.get(line.sku);
  if (!pf || line.location === pf.location) continue;
  
  const sourceKey = stockIdentityKey(...);
  adj.set(sourceKey, (adj.get(sourceKey) ?? 0) - line.qtyRemainingInBin);
  
  const destKey = stockIdentityKey(pf.location, ...);
  adj.set(destKey, (adj.get(destKey) ?? 0) + line.qtyRemainingInBin);
}
```

**Web (`applyMovements`):**
```typescript
// ONLY subtracts picks, ignores relocations
return stock.map((b) => {
  const taken = moved.get(b.binId);
  return taken ? { ...b, qtyCartons: b.qtyCartons - taken, ... } : b;
});
```

However, this difference does NOT matter because replenishment excludes pickface bins from reserve pool.

---

## Does Web App Display Stock?

**NO** — Confirmed by grepping `src/web/`:

### What web app DOES display:
- `qtyRemainingInBin` (Sisa) — from allocation lines ✅
- Fill rate percentage ✅
- Picklist count ✅
- Shortage count ✅
- Replenishment task count ✅
- Cartons moved ✅

### What web app does NOT display:
- ❌ Stock on-hand quantities
- ❌ Inventory by bin
- ❌ Stock availability
- ❌ Physical stock after allocation

### Exports

**Excel exports** (browser-output.ts):
- Picklist: allocation lines with Sisa ✅
- Shortage: shortage lines ✅
- Replenishment: replenishment tasks with qtyRemainingAtSource ✅
- Movement report: movement rows ✅

None of these require raw `stockAfterPicks` quantities.

---

## Architectural Assessment

### Current State
```
CLI:
  stock → computeStockAfterMovements → replenishment
  
Web:
  stock → applyMovements → replenishment
```

Both functions:
- Use `stock.map()` (same limitation)
- Feed same `replenish()` consumer
- Have same "no production impact" conclusion

### Is Alignment Needed?

**NO** — for production correctness

**Reasons:**
1. Both work correctly for their current consumer
2. Replenishment logic is immune to the limitation
3. No user-visible difference
4. No data quality issues
5. No incorrect decisions

### Should Web Use `computeStockAfterMovements`?

**Optional architectural improvement, not a production bug**

**Pros:**
- Single implementation
- Accounts for relocations explicitly
- Uses physical identity (location|sku|batch|expiry)

**Cons:**
- Requires changing working web code
- No functional difference in output
- Increases coupling to ledger.ts

**Recommendation:** 
- Keep as-is for production deployment
- Consider alignment in future refactor
- Document that both paths have same limitations

---

## Example: SKU 550076636 in Web App

**Scenario:**
```
CC30C01: 48 → pick 41, reloc 7 → 0
CC21A02: 0 → reloc 7 → pick 7 → 0 (then more relocs/picks...)
```

### With `applyMovements()` (current web):
```
CC30C01: 48 - 41 = 7 (relocation not subtracted)
CC21A02: 0 - 7 = 0 (destination not added)
```

### Does this break replenishment?

**NO** because:
1. Replenishment checks pickface stock by SKU:
   ```
   pickfaceQty.get('550076636') = sum of all bins at pickface location
   ```
2. CC21A02 is pickface → excluded from reserve pool
3. CC30C01 is source → included in reserve pool with qty=7
4. Replenishment sees 7 cartons at CC30C01 as available reserve (which is wrong)

**BUT** this doesn't cause incorrect replenishment because:
- CC30C01 had a pallet break → `qtyRemainingInBin = 7`
- After Phase 5, this 7 cartons is marked for relocation
- The 7 cartons physically move to pickface before next wave
- By the time replenishment runs (after all waves), stock is correct

Actually, wait - let me verify this more carefully...

---

## Critical Re-Analysis

The replenishment runs AFTER `relocateByWaveOrder()` which has already modified `qtyRemainingInBin`.

So when web app does:
```typescript
const pickedByBin = new Map<string, number>();
for (const l of allocation.lines) 
  pickedByBin.set(l.binId, (pickedByBin.get(l.binId) ?? 0) + l.qtyPick);
```

This aggregates `qtyPick` (customer picks), not `qtyRemainingInBin`.

So for CC30C01:
```
qtyPick = 41 (customer picked)
qtyRemainingInBin = 7 (after Phase 5 adjustment)
```

And `applyMovements()` subtracts 41 from initial 48:
```
CC30C01: 48 - 41 = 7
```

But physically, after relocation:
```
CC30C01: 48 - 41 - 7 = 0
```

So `applyMovements()` shows 7 when it should show 0.

Does this affect replenishment?

**Let me check if replenishment uses CC30C01...**

---

## Final Analysis

The key question: After pallet break and relocation, is the source bin available for replenishment?

**Answer: NO** — The allocator already consumed it for the order.

The `qtyRemainingInBin = 7` represents stock that:
1. Physically relocated to pickface
2. Is no longer in the source bin
3. Should NOT be available for replenishment from source

If `applyMovements()` shows CC30C01 still has 7 cartons, and replenishment tries to use them, that would be WRONG.

**BUT** replenishment runs against `stockAfterPicks`, and the broken pallet bin would need to:
1. Not be in pickfaceLocations ✅ (it's not)
2. Have qtyCartons > 0 (applyMovements shows 7)
3. Not be blocked

So replenishment COULD try to use those 7 cartons from CC30C01, which is INCORRECT because they physically moved.

**This IS a bug** — but let me verify if it actually happens...

---

## Verification: Does Web Replenishment Use Relocated Stock?

The question is whether `applyMovements()` leaving 7 cartons at source causes replenishment to generate tasks from that bin.

Let me trace through replenishment logic:
1. `stockAfterPicks` has CC30C01 with 7 cartons
2. CC30C01 is NOT a pickface location
3. `qtyCartons > 0` (7 > 0)
4. Replenishment could select CC30C01 as reserve stock

This would generate a DUPLICATE replenishment task because:
- The 7 cartons already moved to pickface via relocation
- Replenishment thinks they're still at source
- It tries to move them again

**Conclusion: This IS a production bug in the web app**

---

## Production Impact

**Severity: MEDIUM**

**Affected:** Web application only (CLI uses `computeStockAfterMovements` which accounts for relocations)

**Symptom:** Replenishment may generate duplicate/impossible tasks for stock that was already relocated via pallet breaks

**Data:** Not verified in actual web app output (would need to run web app and check replenishment tasks)

**Workaround:** None for web users

**Fix Required:** YES

---

## Recommended Fix

Replace web app's `applyMovements()` with `computeStockAfterMovements()`:

```typescript
// BEFORE:
const pickedByBin = new Map<string, number>();
for (const l of allocation.lines) pickedByBin.set(l.binId, (pickedByBin.get(l.binId) ?? 0) + l.qtyPick);
const stockAfterPicks = applyMovements(loaded.stock, pickedByBin);

// AFTER:
const stockAfterPicks = computeStockAfterMovements(loaded.stock, allocation.lines, pickfaces);
```

This is a **one-line change** that aligns web app with CLI behavior.

---

## Conclusion

**`applyMovements()` usage:**
- Production: Web app only
- Affects: Replenishment task generation
- Bug: May generate duplicate tasks for relocated stock
- Severity: Medium (incorrect replenishment tasks)
- Fix: Replace with `computeStockAfterMovements()`
- Impact: One-line change, tested pattern from CLI
