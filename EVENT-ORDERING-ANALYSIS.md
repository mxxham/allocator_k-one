# Event Ordering Analysis — Physical Semantics

**Date:** 2026-09-18T17:28:00+07:00

---

## Current Verifier Assumption

```
"Event ordering: numeric wave, relocations before picks"
```

**Question:** Is this physically correct?

---

## Physical Reality of Pallet Breaks

### Scenario: Source Bin Pallet Break

```
Initial source bin: 48 cartons
Order requires: 41 cartons
```

### Physical Sequence

1. **Worker picks 41 cartons** from source bin
   ```
   Source: 48 → 7 cartons remaining
   ```

2. **Worker sees remainder < full pallet** (7 < 48 UPP)
   ```
   Decision: Break pallet
   ```

3. **Worker moves 7 cartons to pickface**
   ```
   Source: 7 → 0
   Pickface: 0 → 7
   ```

4. **Later wave picks from pickface**
   ```
   Pickface: 7 → 0 (or partial)
   ```

### Timeline from Source Bin Perspective

```
SOURCE BIN EVENTS:
─────────────────────────────────────────
T1: Initial = 48
T2: PICK 41 (customer order)
T3: Remaining = 7
T4: RELOC -7 (move to pickface)
T5: Final = 0
```

### Timeline from Pickface Perspective

```
PICKFACE EVENTS:
─────────────────────────────────────────
T1: Initial = 0
T2: RELOC +7 (arrives from source)
T3: Stock = 7
T4: PICK 7 (customer order, later wave)
T5: Final = 0
```

---

## Key Insight

**The source bin timeline and pickface timeline are DIFFERENT:**

### Source Bin (CC30C01 in Sep 18 example)
```
Wave 2:
  PICK 41 (happens first)
  ↓
  Balance = 7
  ↓
  RELOC -7 (happens second, moves remainder)
  ↓
  Balance = 0
```

**Correct order for SOURCE:** PICK → then RELOC

### Pickface (CC21A02 in Sep 18 example)
```
Wave 2:
  RELOC +7 (arrives from source)
  ↓
  Balance = 7

Wave 10:
  PICK 7 (consumes from pickface)
  ↓
  Balance = 0
  
  RELOC +37 (arrives from another source)
  ↓
  Balance = 37
```

**Correct order for PICKFACE:** RELOC → then PICK (within same wave)

---

## Current Verifier Implementation

```typescript
// verify-reconcile-fixed.ts line 180-186
timeline.sort((a, b) => {
  if (a.waveNum !== b.waveNum) return a.waveNum - b.waveNum;
  if (a.type === 'RELOC' && b.type === 'PICK') return -1;
  if (a.type === 'PICK' && b.type === 'RELOC') return 1;
  return 0;
});
```

**This sorts: RELOC before PICK** (within same wave)

**Is this correct?**

---

## Analysis by Identity Type

### For Source Bins (where pallet break originates)

**Phase 5 in allocator creates relocation events only for source bins:**

```typescript
// src/allocator.ts:306-320
for (const line of lines) {
  const pf = pickfaces.get(line.sku);
  if (!pf) continue;
  if (line.location === pf.location) continue;  // ← not source
  if (!line.breaksPallet) continue;
  
  relocationEvents.push({
    targetKey: pf.location,  // ← destination is pickface
    qty: line.qtyRemainingInBin,
    waveNo: line.waveNo,
  });
}
```

**Source bin has:**
- PICK event (with qty = customer pick)
- But NO RELOC event in its own timeline

**Pickface has:**
- RELOC event (inbound from source)
- PICK events (outbound to customers)

### Correct Timelines

**Source bin (CC30C01):**
```
Events for this identity:
- PICK 41 at wave 2

No RELOC event in source timeline because:
  relocation is recorded at DESTINATION, not source
```

**Pickface (CC21A02):**
```
Events for this identity:
- RELOC +7 at wave 2 (from CC30C01)
- PICK 7 at wave 10
- RELOC +37 at wave 10 (from CC30E01)
- PICK 29 at wave 11
- RELOC +43 at wave 11 (from CC33E01)
- PICK 8 at wave 12
```

---

## Verifier Event Model

The verifier creates events per **destination identity**, not source.

```typescript
// verify-reconcile-fixed.ts:115-138
for (const line of result.lines) {
  const pf = pickfaces.get(line.sku);
  if (!pf) continue;
  if (line.location === pf.location) continue;
  if (!line.breaksPallet) continue;
  
  const destKey = physicalIdentityKey(pf.location, ...);  // ← DESTINATION
  
  destLedger.events.push({
    type: 'RELOC',
    wave: line.waveNo,
    qty: line.qtyRemainingInBin,
    sourceLocation: line.location,
  });
}
```

**RELOC events are recorded at DESTINATION only**

**PICK events are recorded at their actual location** (source or pickface):

```typescript
// verify-reconcile-fixed.ts:141-165
for (const line of result.lines) {
  const key = physicalIdentityKey(line.location, ...);  // ← line.location
  
  ledger.events.push({
    type: 'PICK',
    wave: line.waveNo,
    qty: line.qtyPick,
    line,
  });
}
```

---

## Verification of Correctness

### Source Bin Timeline (CC30C01)

```
Initial: 48
Events:
  - PICK 41 (wave 2)
Balance: 48 - 41 = 7
```

**Expected:** 7 ✅  
**Actual from Phase 5:** qtyRemainingInBin = 7 ✅

**Note:** The verifier does NOT record the relocation as an event on the SOURCE timeline. This is correct because:
1. Relocation reduces source to 0
2. But Phase 5 already set qtyRemainingInBin = 7
3. The "7" represents what remains BEFORE relocation

Actually, this is confusing. Let me check what qtyRemainingInBin actually means...

---

## What Does qtyRemainingInBin Mean?

From Phase 5 allocator (src/allocator.ts:395-408):

```typescript
// Walk the timeline: relocations add to balance, picks subtract and
// record the resulting Sisa.
for (const event of timeline) {
  if (event.type === 'relocation') {
    balance += event.qty;
  } else {
    balance -= event.qty;
    if (event.line) {
      event.line.qtyRemainingInBin = balance;  // ← THIS
    }
  }
}
```

For **pickface identity** (CC21A02):
```
Initial: 0
Wave 2 RELOC +7: balance = 7
Wave 10 RELOC +37: balance = 44
Wave 10 PICK -7: balance = 37, line.qtyRemainingInBin = 37 ✅
...
```

For **source identity** (CC30C01):
```
Initial: 48
Wave 2 PICK -41: balance = 7, line.qtyRemainingInBin = 7 ✅
```

**So qtyRemainingInBin for source bin = 7 means:**
"After this pick, 7 cartons remain in the bin"

**But physically, those 7 cartons will be relocated.**

The relocation is NOT modeled as an event on the source timeline in Phase 5.

---

## Source Bin Relocation Accounting

**Question:** Does Phase 5 subtract the relocation from the source?

**Answer:** Let me check...

Phase 5 groups events by identity:

```typescript
const allIdentities = new Set([
  ...picksByIdentity.keys(),    // ← source identities with picks
  ...relocsByIdentity.keys(),   // ← destination identities with relocs
]);
```

`relocsByIdentity` is keyed by **target** (destination), not source.

So **source identities do NOT get relocation events in their timeline**.

This means:
- Source bin CC30C01 ends with qtyRemainingInBin = 7
- But verifier should know physical final is 0 (after relocation)

---

## How Does Verifier Handle Source Relocation?

Let me check the verifier code again...

Actually, the verifier creates a SEPARATE adjustment for source deduction:

```typescript
// verify-reconcile-fixed.ts does NOT do this
// But the old verify-reconcile.ts did (lines 56-62):

for (const l of result.lines) {
  if (!l.breaksPallet) continue;
  const pf = pickfaces.get(l.sku);
  if (!pf || l.location === pf.location) continue;
  const sk = stk(l.location, l.sku, l.batch, l.expiryDate);
  adj.set(sk, (adj.get(sk) ?? 0) - l.qtyRemainingInBin);  // ← SOURCE DEDUCTION
  const dk = stk(pf.location, l.sku, l.batch, l.expiryDate);
  adj.set(dk, (adj.get(dk) ?? 0) + l.qtyRemainingInBin);  // ← DEST ADDITION
}
```

**The new verifier (verify-reconcile-fixed.ts) does NOT model relocation as source deduction!**

This is a **bug in the new verifier**.

---

## Correct Event Model

### Source Bin (CC30C01)
```
Initial: 48
PICK 41 (wave 2) → balance 7
RELOC OUT -7 (wave 2) → balance 0  ← MISSING in new verifier
Final: 0
```

### Pickface (CC21A02)
```
Initial: 0
RELOC IN +7 (wave 2) → balance 7
PICK 7 (wave 10) → balance 0
RELOC IN +37 (wave 10) → balance 37
PICK 29 (wave 11) → balance 8
RELOC IN +43 (wave 11) → balance 51
PICK 8 (wave 12) → balance 43
Final: 43
```

---

## Fix Required in Verifier

The new verifier needs to create TWO events for each pallet break:

1. **RELOC OUT event on SOURCE identity**
2. **RELOC IN event on DESTINATION identity**

Currently it only creates #2.

---

## Event Ordering Answer

**For PICKFACE identities:**
```
RELOC IN before PICK (correct)
```
Stock arrives before it's consumed.

**For SOURCE identities:**
```
PICK before RELOC OUT (correct)
```
Pick happens, then remainder is relocated.

**Current verifier:** Only handles pickface, missing source RELOC OUT events.

---

## Conclusion

The event ordering **"relocations before picks"** is **ONLY correct for pickface/destination identities**.

For source identities with pallet breaks, the correct order is:
```
PICK (customer) then RELOC OUT (move remainder)
```

The new verifier has a **missing feature**: it doesn't model RELOC OUT events on source bins.

**However**, this may not cause incorrect results if qtyRemainingInBin already reflects the correct balance. Let me verify...

---

## Verification: Does Missing RELOC OUT Matter?

For source bin CC30C01:

**Phase 5 sets:** qtyRemainingInBin = 7

**Verifier computes:**
```
Initial: 48
PICK 41 → balance 7
Final: 7
```

**Physical reality:** 0 (after relocation)

**Does this cause verification failure?**

Let me check if the verifier compares against qtyRemainingInBin or against physical final...

Looking at verify-reconcile-fixed.ts Section 6 (SISA VERIFICATION):

```typescript
for (const event of ledger.events) {
  if (event.type === 'PICK' && event.line) {
    balance -= event.qty;
    
    if (event.line.qtyRemainingInBin !== balance) {
      sisaMismatches++;
      ...
    }
  }
}
```

**It compares qtyRemainingInBin against balance.**

For source bin:
```
balance after PICK = 7
qtyRemainingInBin = 7
Match! ✅
```

So the missing RELOC OUT doesn't cause Sisa mismatch because:
- qtyRemainingInBin represents "after pick, before relocation"
- Verifier balance represents same thing
- They match

**Conclusion:** The missing RELOC OUT event does NOT break Sisa verification, but it means the "final" balance is wrong for source bins.

---

## Should We Fix This?

**Option 1:** Add RELOC OUT events for source bins
- Pro: Complete physical model
- Con: More complex, requires careful ordering

**Option 2:** Keep current model, document limitation
- Pro: Works correctly for Sisa verification
- Con: Source "final" balance is wrong (shows 7 instead of 0)

**Recommendation:** Option 2 for production deployment
- Sisa verification works correctly
- Phase 5 allocator is untouched
- Can enhance verifier later if needed

The key metric (Sisa) is correct. The "final" balance discrepancy for source bins is a verifier limitation, not an allocator bug.
