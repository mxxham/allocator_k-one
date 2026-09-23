/**
 * Test script: Run allocation from DB, complete 5 waves, show stock changes
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// Load env manually
const content = readFileSync('.env.local', 'utf8');
const lines = content.split('\n').filter(l => l.includes('=') && !l.startsWith('#'));
for (const line of lines) {
  const [key, ...rest] = line.split('=');
  const value = rest.join('=').trim();
  process.env[key.trim()] = value;
}

const url = process.env.VITE_SUPABASE_URL!;
const key = process.env.SUPABASE_SECRET_KEY!;
const client = createClient(url, key);

async function run() {
  console.log('=== Step 1: Get current stock snapshot ===');
  const { data: stockBefore } = await client.from('stock').select('location, sku, batch, expiry_date, quantity').eq('quantity', 0).limit(0);
  
  // Get total stock before
  const { data: stockTotalBefore } = await client.from('stock').select('quantity');
  const totalBefore = stockTotalBefore?.reduce((sum: number, r: any) => sum + (r.quantity || 0), 0) || 0;
  console.log('Total stock before:', totalBefore);

  // Get sample stock for key SKUs
  const { data: sampleStock } = await client.from('stock')
    .select('location, sku, batch, quantity')
    .in('sku', ['550062461', '550044709', '550074326'])
    .limit(20);
  console.log('\nSample stock before:');
  for (const s of sampleStock || []) {
    console.log(`  ${s.location} | ${s.sku} | ${s.batch} | qty: ${s.quantity}`);
  }

  console.log('\n=== Step 2: Run allocation from DB ===');
  // Import and run allocation
  const { runAllocationFromDB } = await import('./src/services/daily-workflow.js');
  
  const result = await runAllocationFromDB(client, { 
    asOf: new Date('2026-09-22T00:00:00Z') 
  });
  
  console.log('Allocation result:');
  console.log('  Waves:', result.waves.length);
  console.log('  Movements:', result.movementCount);
  console.log('  Fill rate:', result.stats.fillRatePct.toFixed(1) + '%');
  console.log('  Cartons allocated:', result.stats.cartonsAllocated + '/' + result.stats.cartonsRequested);

  console.log('\n=== Step 3: Get waves to complete ===');
  const { data: waves } = await client.from('waves').select('id, wave_no, destination, status').order('wave_no');
  console.log('Total waves:', waves?.length);
  console.log('Waves:', waves?.map((w: any) => `${w.wave_no} (${w.status})`).join(', '));

  console.log('\n=== Step 4: Complete 5 waves ===');
  const wavesToComplete = waves?.filter((w: any) => w.status === 'PENDING').slice(0, 5) || [];
  console.log('Completing', wavesToComplete.length, 'waves...');

  let completedCount = 0;
  for (const wave of wavesToComplete) {
    try {
      // Call the complete_wave RPC
      const { data, error } = await client.rpc('complete_wave', {
        p_wave_id: wave.id,
        p_actor: 'test-script'
      });
      
      if (error) {
        console.log(`  Wave ${wave.wave_no}: ERROR - ${error.message}`);
      } else {
        console.log(`  Wave ${wave.wave_no}: ${data?.result || 'COMPLETED'}`);
        completedCount++;
      }
    } catch (e: any) {
      console.log(`  Wave ${wave.wave_no}: EXCEPTION - ${e.message}`);
    }
  }
  console.log('Completed:', completedCount, 'waves');

  console.log('\n=== Step 5: Get stock changes ===');
  // Get total stock after
  const { data: stockTotalAfter } = await client.from('stock').select('quantity');
  const totalAfter = stockTotalAfter?.reduce((sum: number, r: any) => sum + (r.quantity || 0), 0) || 0;
  console.log('Total stock after:', totalAfter);
  console.log('Stock change:', totalAfter - totalBefore);

  // Get stock movements summary
  const { data: movements } = await client.from('movements').select('movement_type, quantity, source_location, destination_location, sku').eq('status', 'COMPLETED');
  console.log('\nCompleted movements:', movements?.length);
  
  const pickMovements = movements?.filter((m: any) => m.movement_type === 'PICK') || [];
  const relocOutMovements = movements?.filter((m: any) => m.movement_type === 'RELOC_OUT') || [];
  const relocInMovements = movements?.filter((m: any) => m.movement_type === 'RELOC_IN') || [];
  
  console.log('PICK movements:', pickMovements.length, 'total qty:', pickMovements.reduce((s: number, m: any) => s + m.quantity, 0));
  console.log('RELOC_OUT movements:', relocOutMovements.length, 'total qty:', relocOutMovements.reduce((s: number, m: any) => s + m.quantity, 0));
  console.log('RELOC_IN movements:', relocInMovements.length, 'total qty:', relocInMovements.reduce((s: number, m: any) => s + m.quantity, 0));

  // Show sample stock changes for key SKUs
  console.log('\n=== Step 6: Sample stock changes for key SKUs ===');
  const { data: sampleStockAfter } = await client.from('stock')
    .select('location, sku, batch, quantity')
    .in('sku', ['550062461', '550044709', '550074326'])
    .limit(20);
  
  for (const sAfter of sampleStockAfter || []) {
    const sBefore = sampleStock?.find((s: any) => 
      s.location === sAfter.location && 
      s.sku === sAfter.sku && 
      s.batch === sAfter.batch
    );
    const beforeQty = sBefore?.quantity || 0;
    const afterQty = sAfter.quantity;
    if (afterQty !== beforeQty) {
      console.log(`  ${sAfter.location} | ${sAfter.sku} | ${sAfter.batch}: ${beforeQty} → ${afterQty} (${afterQty - beforeQty > 0 ? '+' : ''}${afterQty - beforeQty})`);
    }
  }

  // Get transaction log
  console.log('\n=== Step 7: Transaction log (last 10) ===');
  const { data: txns } = await client.from('stock_transactions')
    .select('transaction_type, location, sku, quantity_delta, created_by')
    .order('created_at', { ascending: false })
    .limit(10);
  
  for (const txn of txns || []) {
    console.log(`  ${txn.transaction_type} | ${txn.location} | ${txn.sku} | delta: ${txn.quantity_delta > 0 ? '+' : ''}${txn.quantity_delta}`);
  }
}

run().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
