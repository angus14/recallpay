import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fixture, publish, fund, call, credit, stats, events, NEAR } from './harness.mjs';
import { BuyerAgent, digest } from '../sdk/index.mjs';
import { renderReport } from './report.mjs';

await mkdir('results', { recursive: true });
const report = {
  project:'RecallPay', startedAt:new Date().toISOString(), status:'running',
  network:'Local NEAR Sandbox', data:'Synthetic warehouse inventory and shipping fixtures',
  agents:'Two scripted buyer agents; no language model is used.',
  transactions:[], checks:[], jobs:[], limitations:[
    'Provider-declared recalls only. Data truth is not automatically verified.',
    'Coverage refunds the purchase fee; gas and storage fees are excluded.',
    'Only participating jobs with complete declared dependencies can be paused.',
    'A recall cannot undo actions authorized before it, external transactions, or delivered work.',
    'Native NEAR only. No crosschain or confidential execution integration is claimed.',
    'A failed withdrawal callback can leave a pending operation; no timeout-based release is provided.',
    'Prototype has no production audit or demand validation.',
  ],
};
const save = () => writeFile('results/demo.json', JSON.stringify(report, null, 2));
async function record(label, tx) {
  report.transactions.push({ label, hash:tx.transactionReceipt.hash,
    succeeded:tx.succeeded, durationMs:tx.durationMs, gasBurnt:tx.gas_burnt,
    failures:tx.failures, events:events(tx) });
  console.log(`${tx.succeeded ? '✓' : '↳'} ${label}`);
  await save();
  return tx;
}
function check(label, condition) { assert.ok(condition, label); report.checks.push({label,passed:true}); }
const f = await fixture();
try {
  report.node = (await f.worker.provider.status()).version;
  const badBytes = await readFile('fixtures/faulty-inventory.json');
  const goodBytes = await readFile('fixtures/healthy-rates.json');
  const bad = digest(badBytes), good = digest(goodBytes);
  report.versions = { recalled:bad, healthy:good };
  report.accounts = {provider:f.provider.accountId,alice:f.alice.accountId,bob:f.bob.accountId,contract:f.contract.accountId};
  report.contractAccessKeys = (await f.worker.provider.viewAccessKeys(f.contract.accountId)).keys;
  check('The demo vault has no upgrade or deletion access key',report.contractAccessKeys.length===0);
  await record('Publish inventory version', await publish(f, bad, NEAR/5n));
  await record('Publish independent shipping version', await publish(f, good, NEAR/10n));
  await record('Provider funds 1 NEAR refund reserve', await fund(f, NEAR));
  const alice = new BuyerAgent(f.alice, f.contract), bob = new BuyerAgent(f.bob, f.contract);
  for (const [agent, label] of [[alice,'Alice'], [bob,'Bob']]) {
    await record(`${label} buys inventory for 0.2 NEAR`, (await agent.buy(bad,'inventory',badBytes)).tx);
    await record(`${label} buys shipping data for 0.1 NEAR`, (await agent.buy(good,'shipping',goodBytes)).tx);
  }
  alice.addJob('Inventory research A', {receipts:['inventory']});
  alice.addJob('Procurement plan A', {parents:['Inventory research A']});
  alice.addJob('Shipping estimate A', {receipts:['shipping']});
  bob.addJob('Inventory research B', {receipts:['inventory']});
  bob.addJob('Shipping estimate B', {receipts:['shipping']});
  const sellerCash = await f.root.createSubAccount('seller-cash', {initialBalance:NEAR});
  const sellerBefore = BigInt((await sellerCash.balance()).total);
  await record('Provider withdraws earned 0.6 NEAR before the recall', await call(f.provider, f.contract, 'withdraw', {
    amount:(3n*NEAR/5n).toString(),receiver_id:sellerCash.accountId,
  },1n));
  check('Provider earned fees were actually paid out before recall', BigInt((await sellerCash.balance()).total)-sellerBefore===3n*NEAR/5n);
  report.beforeRecall = await stats(f);
  check('Every purchase has fully locked coverage', report.beforeRecall.reserve_locked===(3n*NEAR/5n).toString());
  const recallStart = performance.now();
  await record('Provider recalls inventory: stock was 8, not 80', await call(f.provider,f.contract,'recall_version',{
    version_id:bad,reason:'Warehouse correction: solar-controller stock is 8, not 80.',
  }));
  for (const agent of [alice,bob]) {
    for (const id of agent.jobs.keys()) report.jobs.push({agent:agent.account.accountId,...await agent.refresh(id),receipts:agent.dependencies(id)});
  }
  report.recallToAllGuardsMs = Math.round(performance.now()-recallStart);
  check('All three affected jobs paused, including the derived job', report.jobs.filter(j=>j.status==='paused').length===3);
  check('Both unrelated shipping jobs remain ready', report.jobs.filter(j=>j.status==='ready').length===2);
  const processorBefore = await credit(f,f.processor);
  // Deliberately bypass the SDK to model a stale/unaware client.
  const stale = await record('Stale client tries to pay using recalled inventory',await call(f.alice,f.contract,'spend_with_receipts',{
    receipt_ids:['inventory'],recipient_id:f.processor.accountId,amount:(NEAR/100n).toString(),
  },NEAR/100n+NEAR/50n));
  check('Onchain gate rejects the stale client payment', stale.failed && JSON.stringify(stale.status).includes('ERR_DEPENDENCY_RECALLED'));
  check('Blocked payment created no processor credit', await credit(f,f.processor)===processorBefore);
  for (const [agent,id] of [[alice,'Shipping estimate A'],[bob,'Shipping estimate B']]) {
    const action=await agent.payNextAction(id,f.processor,NEAR/100n);
    check(`${id} completed its next paid action`,!action.blocked);
    await record(`${id}: pay next action`,action.tx);
  }
  check('Unrelated jobs paid exactly 0.02 NEAR in total',await credit(f,f.processor)-processorBefore===NEAR/50n);
  report.refunds=[];
  for (const [agent,label] of [[alice,'alice'],[bob,'bob']]) {
    const cash=await f.root.createSubAccount(`${label}-cash`,{initialBalance:NEAR});
    const beforeCredit=await credit(f,agent.account);
    await record(`Keeper claims ${label}'s refund to its fixed beneficiary`,await agent.claim('inventory',f.root));
    check(`${label} was credited exactly its 0.2 NEAR fee`,await credit(f,agent.account)-beforeCredit===NEAR/5n);
    const beforeBalance=BigInt((await cash.balance()).total);
    const paid=await record(`${label} withdraws refund as real NEAR`,await call(agent.account,f.contract,'withdraw',{
      amount:(NEAR/5n).toString(),receiver_id:cash.accountId,
    },1n));
    const balanceIncrease=BigInt((await cash.balance()).total)-beforeBalance;
    check(`${label}'s refund arrived at its separate wallet`,paid.parseResult()===true && balanceIncrease===NEAR/5n);
    report.refunds.push({buyer:agent.account.accountId,receiver:cash.accountId,amount:balanceIncrease.toString()});
  }
  const duplicate=await record('Repeated refund attempt',await call(f.bob,f.contract,'claim_refund',{
    buyer_id:f.alice.accountId,receipt_id:'inventory',
  }));
  check('Duplicate claim rejected',duplicate.failed&&JSON.stringify(duplicate.status).includes('ERR_ALREADY_SETTLED'));
  report.finalStats=await stats(f);
  const balance=await f.contract.balance();
  report.contractBalance=balance;
  const liabilities=BigInt(report.finalStats.reserve_free)+BigInt(report.finalStats.reserve_locked)+BigInt(report.finalStats.withdrawable_total);
  check('All remaining settled liabilities remain backed',BigInt(balance.available)>=liabilities && report.finalStats.withdrawals_pending==='0');
  report.summary={affectedJobsPaused:3,unaffectedJobsPaid:2,refundedYocto:(2n*NEAR/5n).toString(),
    providerFeesAlreadyWithdrawnYocto:(3n*NEAR/5n).toString(),failedExpectedAttempts:2,checksPassed:report.checks.length};
  report.status='passed'; report.completedAt=new Date().toISOString();
  await save(); await renderReport(report);
  console.log(`\nPASS: ${report.checks.length} checks. 3 jobs paused, 2 continued, 0.4 NEAR refunded.`);
  console.log('Results: results/demo.json, results/demo.html, results/RESULTS.md');
} catch(error) {
  report.status='failed'; report.error=error.stack; await save(); throw error;
} finally { await f.worker.tearDown(); }
