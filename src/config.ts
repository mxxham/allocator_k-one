/**
 * Every business rule the allocator obeys lives here. Change a value, change
 * the behaviour — no rule is hardcoded inside the engine.
 */
export interface AllocatorConfig {
  /** Date the allocation is run for (shelf-life and aging are measured from this). */
  asOf: Date;

  // ---- FEFO / shelf life -------------------------------------------------
  /** Refuse stock with fewer than this many days of life left at asOf. */
  minRemainingShelfLifeDays: number;
  /** Flag (but still pick) stock below this many days. */
  nearExpiryWarningDays: number;
  /** Warn when one demand line ends up spanning more than one expiry date. */
  warnOnMixedExpiryPerLine: boolean;

  // ---- Pallet handling ---------------------------------------------------
  /**
   * For the loose remainder (qty % upp), pick from an already-opened bin
   * before breaking a sealed pallet. Applied inside the earliest-expiry group
   * only, so FEFO is never violated.
   */
  preferOpenPalletForRemainder: boolean;
  /**
   * Best-fit: among open bins of the earliest expiry, take the smallest one
   * that can still cover the need — clears fragments out of the rack.
   */
  bestFitOpenPallets: boolean;

  // ---- Location eligibility ---------------------------------------------
  /** Only locations matching this are pickable (rack bins). */
  rackLocationPattern: RegExp;
  /** Locations excluded even if they match the pattern. */
  excludedLocations: string[];
  /** Outbound staging lanes — stock here counts as already picked, not available. */
  stagingLocations: string[];
  /** Bin statuses that are pickable. */
  pickableStatuses: string[];
  /** Specific bins on hold (cycle count, damage, blocked). */
  blockedBins: string[];

  // ---- Pick path ---------------------------------------------------------
  /** Walking order of aisles. */
  aisleSequence: string[];
  /** Reverse bay direction on every second aisle (no empty walk back). */
  serpentine: boolean;
  /** Ground level first within a bay. */
  levelSequence: string[];

  // ---- Task shaping ------------------------------------------------------
  /** Emit forklift (pallet) and handpick (case) work as separate picklists. */
  splitPalletAndCaseTasks: boolean;
  /** Split a picklist that exceeds this many lines (0 = never). */
  maxLinesPerPicklist: number;
  /** Order shipments by slot time, then shipment number. */
  sequenceShipmentsBySlot: boolean;

  // ---- Pickface replenishment ---------------------------------------------
  /**
   * Which rack levels are eligible for pickface assignment.
   * Only bins with a level in this list will be auto-derived as pickfaces.
   * Default: ['A'] — only ground floor (Level A) bins are pickfaces.
   * Levels B-E are always bulk/reserve stock.
   */
  pickfaceLevels: string[];
  /**
   * Bins reserved as a SKU's dedicated outbound pickface don't get auto-derived
   * or drawn from as a replenishment source. Keyed by SKU when set by an admin.
   */
  pickfaceOverrides: Record<string, string>;
  /**
   * Top a pickface up to this many cartons (a full pallet's worth by default —
   * pass a number to override every SKU, or leave 'upp' to use each SKU's own
   * pallet size).
   */
  pickfaceTargetQty: number | 'upp';
  /**
   * When a pick breaks a sealed pallet (takes less than UPP), automatically
   * move the remaining loose cartons from bulk (Level B-E) to pickface (Level A).
   * Safety rule: loose cartons on upper levels are hazardous to handle.
   */
  moveBrokenPalletToPickface: boolean;
  /** Only generate a replenishment task when the shortfall is at least this many cartons. */
  replenishmentMinTriggerQty: number;
  /**
   * Also top up a pickface enough to cover today's outbound demand for that
   * SKU, even past the normal target — so a big order doesn't strand the
   * picker mid-pick.
   */
  replenishCoverPendingDemand: boolean;
}

export const DEFAULT_CONFIG: AllocatorConfig = {
  asOf: new Date(),

  minRemainingShelfLifeDays: 180,
  nearExpiryWarningDays: 365,
  warnOnMixedExpiryPerLine: true,

  preferOpenPalletForRemainder: true,
  bestFitOpenPallets: true,
  moveBrokenPalletToPickface: true,

  // CA01A01 → aisle CA, bay 01, level A, position 01
  rackLocationPattern: /^C[A-G]\d{2}[A-E]\d{2}$/,
  excludedLocations: ['STAGING', 'STAGING_INB', 'STAGING_OUT', 'Quarantine', 'QUARANTINE'],
  stagingLocations: ['STAGING', 'STAGING_OUT'],
  pickableStatuses: ['Aktif', 'AKTIF', 'ACTIVE'],
  blockedBins: [],

  aisleSequence: ['CA', 'CB', 'CC', 'CD', 'CE', 'CF', 'CG'],
  serpentine: true,
  levelSequence: ['A', 'B', 'C', 'D', 'E'],

  splitPalletAndCaseTasks: true,
  maxLinesPerPicklist: 0,
  sequenceShipmentsBySlot: true,

  pickfaceLevels: ['A'],
  pickfaceOverrides: {},
  pickfaceTargetQty: 'upp',
  replenishmentMinTriggerQty: 1,
  replenishCoverPendingDemand: true,
};

export function withConfig(overrides: Partial<AllocatorConfig> = {}): AllocatorConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export const MS_PER_DAY = 86_400_000;

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}
