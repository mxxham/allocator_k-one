# FEFO Allocator — Physical Stock Ledger Audit Report

**Date:** 2026-09-18
**Workbook:** Warehouse_Management_System_15_September_2026_.xlsx
**Run date:** 2026-09-15
**Status:** RESOLVED

---

## A. Problem Statement

After outbound picks complete, pallet-break relocations move residual stock from bulk bins to pickface bins. The old `applyMovements()` function deducted picks from stock but did not account for these relocations before replenishment ran. This caused replenishment to see stale stock — bulk bins appeared to still hold stock that had already been relocated, and pickface bins did not reflect relocated-in stock. The result: duplicate and incorrect replenishment tasks.

## B. Root Cause

`cli.ts` computed `stockAfterPicks = applyMovements(stock, pickedByBin)` where `pickedByBin` was keyed by `binId` (location|sku|batch). This only deducted picks. The relocation flows (pallet breaks moving remaining stock from bulk to pickface) were invisible to replenishment. Replenishment therefore selected source bins that had already been depleted by relocations.

## C. Fix

New module `src/ledger.ts` exports `computeStockAfterMovements(stock, lines, pickfaces)` which nets both picks and relocation flows per physical identity (location|sku|batch|expiry):

1. Deducts `qtyPick` per allocation line
2. For each pallet break: deducts `qtyRemainingInBin` from the source bulk bin, adds it to the destination pickface bin
3. Applies all adjustments per physical identity key, clamped to zero

`cli.ts` now passes `computeStockAfterMovements(stock, result.lines, pickfaces)` to `replenish()` instead of the old picks-only computation.

## D. Files Changed

| File | Change |
|------|--------|
| `src/ledger.ts` | **New.** `computeStockAfterMovements()`, `stockIdentityKey()` |
| `src/cli.ts` | Import `computeStockAfterMovements` from `./ledger.js`. Replace `pickedByBin`/`applyMovements` block with single call |
| `audit-forensic.ts` | Import `computeStockAfterMovements` from `./ledger.js` instead of `applyMovements`. Updated Phase 1D and 1E |

## E. Before vs After — Allocation (unchanged)

| Metric | Before | After |
|--------|--------|-------|
| Demand lines | 73 | 73 |
| Cartons requested | 4,800 | 4,800 |
| Cartons allocated | 4,748 | 4,748 |
| Fill rate | 98.92% | 98.92% |
| Pick instructions | 214 | 214 |
| Pallet picks | 102 | 102 |
| Case picks | 112 | 112 |
| Sealed pallets opened | 29 | 29 |
| Bins touched | 169 | 169 |
| Picklists | 14 | 14 |
| Shortages | 3 | 3 |

Allocation is identical. The fix only affects the replenishment stock input.

## F. Before vs After — Replenishment

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Pickfaces evaluated | 95 | 95 | 0 |
| Pickfaces replenished | 67 | 66 | -1 |
| Cartons moved | 1,147 | 1,089 | -58 |
| Sealed pallets opened | 38 | 38 | 0 |
| Replenishment tasks | 71 | 71 | 0 |
| Shortages | 24 | 24 | 0 |

1 fewer pickface replenished (duplicate eliminated). 58 fewer cartons moved (redundant moves from depleted bins removed).

## G. Overlap Classification

| Classification | Before | After |
|----------------|--------|-------|
| DUPLICATE | 2 | 0 |
| AMBIGUOUS | 2 | 0 |
| LEGITIMATE | 23 | 22 |

The 2 DUPLICATE overlaps (same source, destination, qty) are eliminated:
- `CF31C02 -> CE01A01 qty=2`: source now 0 after movements
- `CE37C02 -> CD21A02 qty=27`: source now 0 after movements

The 2 AMBIGUOUS overlaps (same source, different qty) are resolved:
- `CB20C02 -> CC15A02`: source depleted
- `CF06D01 -> CE21A02`: source depleted

All 22 remaining overlaps are LEGITIMATE — different sources feeding the same pickface.

## H. Validation

- `npx tsc --noEmit` — clean
- `npm run build` — clean
- `npm run build:web` — clean
- Pipeline output: identical allocation, improved replenishment
- Forensic audit: 0 DUPLICATE, 0 AMBIGUOUS overlaps
- No negative balances across all 1,831 bins after movements
- Known duplicate source bins confirmed at qty=0:
  - `CF31C02|550024986|12685350|2030-08-03`: 4 -> 0
  - `CE37C02|550050072|29E26JJ|2030-05-29`: 36 -> 0

---

*Report generated 2026-09-18 by audit-forensic.ts*
