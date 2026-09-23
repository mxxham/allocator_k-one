/**
 * Test: Run allocation from DB, complete 5 waves, show stock changes
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// Load env
const content = readFileSync('.env.local', 'utf8');
const lines = content.split('\n').filter(l => l.includes('=') && !l.startsWith('#'));
for (const line of lines) {
  const [key, ...rest] = line.split('=');
  const value = rest.join('=').trim();
  process.env[key.trim()] = value;
}

const client = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

async function run() {
  // =====================================================
  // STEP 1: Current state before allocation
  // =====================================================
  console.log('═══════════════════════════════════════════════════');
  console.log('  STEP 1: DATABASE STATE BEFORE ALLOCATION');
  console.log('═══════════════════════════════════════════════════');
  
  const { count: stockCount } = await client.from('stock').select('*', { count: 'exact', head: true });
  const { data: allStock } = await client.from('stock').select('quantity');
  const totalBefore = allStock?.reduce((sum, r) => sum + (r.quantity || 0), 0) || 0;
  console.log(`  Stock rows     : ${stockCount}`);
  console.log(`  Total cartons  : ${totalBefore}`);
  
  const { count: outCount } = await client.from('outbound').select('*', { count: 'exact', head: true });
  console.log(`  Outbound rows  : ${outCount}`);
  
  const { count: waveCount } = await client.from('waves').select('*', { count: 'exact', head: true });
  console.log(`  Waves          : ${waveCount}`);
  
  const { count: movCount } = await client.from('movements').select('*', { count: 'exact', head: true });
  console.log(`  Movements      : ${movCount}`);
  
  // Show sample stock for key SKUs
  console.log('\n  Sample stock (before):');
  const { data: sampleBefore } = await client.from('stock')
    .select('location, sku, batch, quantity')
    .in('sku', ['550062461', '550044709', '550069888', '550058593'])
    .order('sku')
    .order('location')
    .limit(15);
  for (const s of sampleBefore || []) {
    console.log(`    ${s.location} | ${s.sku} | ${s.batch} | qty: ${s.quantity}`);
  }

  // =====================================================
  // STEP 2: Run allocation from DB
  // =====================================================
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  STEP 2: RUN ALLOCATION FROM DB');
  console.log('═══════════════════════════════════════════════════');
  
  const { runAllocationFromDB } = await import('./src/services/daily-workflow.js');
  const result = await runAllocationFromDB(client, { 
    asOf: new Date('2026-09-22T00:00:00Z') 
  });
  
  console.log(`  Waves created      : ${result.waves.length}`);
  console.log(`  Movements created  : ${result.movementCount}`);
  console.log(`  Fill rate          : ${result.stats.fillRatePct.toFixed(1)}%`);
  console.log(`  Cartons allocated  : ${result.stats.cartonsAllocated} / ${result.stats.cartonsRequested}`);
  console.log(`  Picklists          : ${result.stats.palletPicks} pallet + ${result.stats.casePicks} case`);
  
  // List all waves
  console.log('\n  Waves:');
  for (const w of result.waves) {
    console.log(`    Wave ${w.waveNo} | ${w.destination} | ${w.status}`);
  }

  // =====================================================
  // STEP 3: Complete 5 waves
  // =====================================================
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  STEP 3: COMPLETE 5 WAVES');
  console.log('═══════════════════════════════════════════════════');
  
  const { data: pendingWaves } = await client.from('waves')
    .select('id, wave_no, destination')
    .eq('status', 'PENDING')
    .order('wave_no');
  
  console.log(`  PENDING waves available: ${pendingWaves?.length}`);
  
  const wavesToComplete = pendingWaves?.slice(0, 5) || [];
  console.log(`  Completing ${wavesToComplete.length} waves...`);
  
  let completed = 0;
  let failed = 0;
  
  for (const wave of wavesToComplete) {
    process.stdout.write(`  Wave ${wave.wave_no} (${wave.destination.slice(0, 25)})... `);
    
    const { data, error } = await client.rpc('complete_wave', {
      p_wave_id: wave.id,
      p_actor: 'test-script'
    });
    
    if (error) {
      console.log(`[ERROR] ${error.message}`);
      failed++;
    } else {
      const result = data as any;
      if (result?.result === 'POSTED') {
        console.log(`[POSTED] (${result.posted || 0} movements)`);
        completed++;
      } else if (result?.result === 'ALREADY_POSTED') {
        console.log(`[ALREADY POSTED]`);
        completed++;
      } else {
        console.log(`[UNKNOWN] ${JSON.stringify(result)}`);
        completed++;
      }
    }
  }
  
  console.log(`\n  Summary: ${completed} completed, ${failed} failed`);

  // =====================================================
  // STEP 4: Stock after
  // =====================================================
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  STEP 4: STOCK STATE AFTER COMPLETION');
  console.log('═══════════════════════════════════════════════════');
  
  const { data: allStockAfter } = await client.from('stock').select('quantity');
  const totalAfter = allStockAfter?.reduce((sum, r) => sum + (r.quantity || 0), 0) || 0;
  console.log(`  Total cartons before : ${totalBefore}`);
  console.log(`  Total cartons after  : ${totalAfter}`);
  console.log(`  Net change           : ${totalAfter - totalBefore}`);
  
  // Show sample stock after
  console.log('\n  Sample stock (after):');
  const { data: sampleAfter } = await client.from('stock')
    .select('location, sku, batch, quantity')
    .in('sku', ['550062461', '550044709', '550069888', '550058593'])
    .order('sku')
    .order('location')
    .limit(15);
  for (const s of sampleAfter || []) {
    const before = sampleBefore?.find(b => 
      b.location === s.location && b.sku === s.sku && b.batch === s.batch
    );
    const delta = s.quantity - (before?.quantity || 0);
    const deltaStr = delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${delta})`;
    console.log(`    ${s.location} | ${s.sku} | ${s.batch} | qty: ${s.quantity}${deltaStr}`);
  }

  // =====================================================
  // STEP 5: Movement summary
  // =====================================================
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  STEP 5: COMPLETED MOVEMENTS');
  console.log('═══════════════════════════════════════════════════');
  
  const { data: completedMovs } = await client.from('movements')
    .select('movement_type, source_location, destination_location, sku, quantity, batch')
    .eq('status', 'COMPLETED');
  
  const pickMovs = completedMovs?.filter(m => m.movement_type === 'PICK') || [];
  const replenishMovs = completedMovs?.filter(m => m.movement_type === 'REPLENISH') || [];
  
  console.log(`  Total completed movements: ${completedMovs?.length}`);
  console.log(`    PICK      : ${pickMovs.length} movements, ${pickMovs.reduce((s, m) => s + m.quantity, 0)} cartons (stock DECREASE)`);
  console.log(`    REPLENISH : ${replenishMovs.length} movements, ${replenishMovs.reduce((s, m) => s + m.quantity, 0)} cartons (source DECREASE, dest INCREASE)`);
  
  // Show PICK details
  console.log('\n  PICK movements (stock decreases):');
  const pickBySku: Record<string, { qty: number; bins: string[] }> = {};
  for (const m of pickMovs) {
    if (!pickBySku[m.sku]) pickBySku[m.sku] = { qty: 0, bins: [] };
    pickBySku[m.sku].qty += m.quantity;
    pickBySku[m.sku].bins.push(m.source_location);
  }
  for (const [sku, data] of Object.entries(pickBySku)) {
    console.log(`    SKU ${sku}: -${data.qty} cartons from ${data.bins.join(', ')}`);
  }
  
  // Show REPLENISH details
  if (replenishMovs.length > 0) {
    console.log('\n  REPLENISH movements (bin-to-bin):');
    for (const m of replenishMovs) {
      console.log(`    ${m.source_location} → ${m.destination_location} | SKU ${m.sku} | ${m.quantity} cartons`);
    }
  }

  // =====================================================
  // STEP 6: Transaction log
  // =====================================================
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  STEP 6: TRANSACTION LOG');
  console.log('═══════════════════════════════════════════════════');
  
  const { data: txns } = await client.from('stock_transactions')
    .select('transaction_type, location, sku, quantity_delta, created_at')
    .neq('transaction_type', 'INITIAL_IMPORT')
    .order('created_at', { ascending: false })
    .limit(15);
  
  console.log(`  Recent transactions (excluding INITIAL_IMPORT):`);
  for (const t of txns || []) {
    const sign = t.quantity_delta > 0 ? '+' : '';
    console.log(`    ${t.transaction_type} | ${t.location} | ${t.sku} | ${sign}${t.quantity_delta}`);
  }
  
  // =====================================================
  // SUMMARY
  // =====================================================
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  FINAL SUMMARY');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Waves completed    : ${completed} / ${wavesToComplete.length}`);
  console.log(`  Stock before       : ${totalBefore} cartons`);
  console.log(`  Stock after        : ${totalAfter} cartons`);
  console.log(`  Stock change       : ${totalAfter - totalBefore} cartons`);
  console.log(`  PICK movements     : ${pickMovs.length} (stock decreased by ${pickMovs.reduce((s, m) => s + m.quantity, 0)})`);
  console.log(`  REPLENISH movements: ${replenishMovs.length} (bin-to-bin, net 0)`);
}

run().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
