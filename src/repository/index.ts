/**
 * Repository layer entry point — the UI and services talk to these classes,
 * never to raw Supabase queries (§27).
 */

export * from './types.js';
export * from './util.js';
export { StockRepository, type StockFilter } from './stock-repo.js';
export { WaveRepository, type NewWave } from './wave-repo.js';
export { MovementRepository, type NewMovement } from './movement-repo.js';
export { InboundRepository, type NewInbound } from './inbound-repo.js';
export { OutboundRepository, type NewOutbound } from './outbound-repo.js';
export { ExecutionEventRepository } from './execution-event-repo.js';

import type { DbClient } from '../lib/supabase.js';
import { StockRepository } from './stock-repo.js';
import { WaveRepository } from './wave-repo.js';
import { MovementRepository } from './movement-repo.js';
import { InboundRepository } from './inbound-repo.js';
import { OutboundRepository } from './outbound-repo.js';
import { ExecutionEventRepository } from './execution-event-repo.js';

/** All repositories bound to one database client. */
export interface Repositories {
  stock: StockRepository;
  waves: WaveRepository;
  movements: MovementRepository;
  inbound: InboundRepository;
  outbound: OutboundRepository;
  executionEvents: ExecutionEventRepository;
}

export function createRepositories(db: DbClient): Repositories {
  return {
    stock: new StockRepository(db),
    waves: new WaveRepository(db),
    movements: new MovementRepository(db),
    inbound: new InboundRepository(db),
    outbound: new OutboundRepository(db),
    executionEvents: new ExecutionEventRepository(db),
  };
}
