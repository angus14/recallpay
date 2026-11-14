import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, publish, fund, call, credit, stats, NEAR, TGAS, STORAGE_BUFFER } from '../scripts/harness.mjs';
import { BuyerAgent, digest } from '../sdk/index.mjs';

const A = digest('recalled inventory');
const B = digest('healthy shipping');
const C = digest('late recall');
const D = digest('timely recall, delayed claim');
const E = digest('concurrent reserve contention');
const PRICE = NEAR / 5n;
const expectFailure = (tx, code) => {
  assert.equal(tx.failed, true, `Expected ${code}`);
  assert.match(JSON.stringify(tx.status), new RegExp(code));
};
const buy = (f, actor, version, id, price = PRICE, extra = STORAGE_BUFFER) =>
  call(actor, f.contract, 'buy', { version_id: version, receipt_id: id }, price + extra);
const receipt = (f, actor, id) => f.contract.view('get_receipt', { buyer_id: actor.accountId, receipt_id: id });

test('RecallPay on a real local NEAR blockchain', { timeout: 240_000 }, async t => {
  const f = await fixture();
  try {
    await t.test('deployment has no upgrade/delete key; strangers cannot initialize another instance', async () => {
      assert.equal((await f.worker.provider.viewAccessKeys(f.contract.accountId)).keys.length, 0);
      const fresh = await f.root.createSubAccount('fresh-vault', {initialBalance:5n*NEAR});
      const {readFile} = await import('node:fs/promises');
      await fresh.deploy(await readFile('artifacts/recallpay.wasm'));
      expectFailure(await call(f.bob,fresh,'new',{provider_id:f.bob.accountId}),'ERR_OWNER_INIT');
      assert.equal((await call(fresh,fresh,'new',{provider_id:f.provider.accountId})).succeeded,true);
    });
    await t.test('provider publishes immutable terms; strangers cannot publish', async () => {
      await publish(f, A); await publish(f, B);
      expectFailure(await call(f.bob, f.contract, 'publish_version', { version_id:C, price:PRICE.toString(), warranty_secs:'60' }, STORAGE_BUFFER), 'ERR_PROVIDER_ONLY');
      expectFailure(await call(f.provider, f.contract, 'publish_version', { version_id:A, price:'1', warranty_secs:'60' }, STORAGE_BUFFER), 'ERR_VERSION_EXISTS');
    });
    await t.test('an underfunded provider cannot sell protected purchases', async () => {
      const before = await stats(f);
      expectFailure(await buy(f, f.alice, A, 'no-reserve'), 'ERR_RESERVE_INSUFFICIENT');
      assert.equal((await stats(f)).receipt_count, before.receipt_count);
      assert.equal(await receipt(f, f.alice, 'no-reserve'), null);
    });
    await t.test('concurrent purchases cannot reserve the same money', async () => {
      await fund(f, 2n * NEAR);
      await publish(f, E, 3n * NEAR / 2n);
      const results = await Promise.all([
        buy(f, f.alice, E, 'race', 3n * NEAR / 2n),
        buy(f, f.bob, E, 'race', 3n * NEAR / 2n),
      ]);
      assert.equal(results.filter(x => x.succeeded).length, 1);
      expectFailure(results.find(x => x.failed), 'ERR_RESERVE_INSUFFICIENT');
      assert.equal((await stats(f)).reserve_locked, (3n * NEAR / 2n).toString());
      await fund(f, 3n * NEAR);
    });
    await t.test('purchases bind buyer, exact data version, price and expiry', async () => {
      const a = await buy(f, f.alice, A, 'inventory');
      const b = await buy(f, f.bob, A, 'inventory');
      assert.equal(a.succeeded && b.succeeded, true);
      const r = await receipt(f, f.alice, 'inventory');
      assert.equal(r.buyer_id, f.alice.accountId);
      assert.equal(r.version_id, A);
      assert.equal(r.price, PRICE.toString());
      assert.equal(BigInt(r.expires_at) - BigInt(r.purchased_at), 3600n * 10n ** 9n);
      expectFailure(await buy(f, f.alice, A, 'inventory'), 'ERR_RECEIPT_EXISTS');
    });
    await t.test('insufficient storage deposit rolls back payment and reservation', async () => {
      const before = await stats(f);
      expectFailure(await buy(f, f.alice, B, 'no-storage', PRICE, 0n), 'ERR_STORAGE_DEPOSIT');
      assert.deepEqual(await stats(f), before);
      assert.equal(await receipt(f, f.alice, 'no-storage'), null);
    });
    await t.test('provider cannot withdraw locked refund reserves', async () => {
      const before = await stats(f);
      expectFailure(await call(f.provider, f.contract, 'release_free_reserve', { amount:(BigInt(before.reserve_free) + 1n).toString() }), 'ERR_RESERVE_LOCKED');
      assert.deepEqual(await stats(f), before);
    });
    await t.test('only provider can recall; one version changes independently', async () => {
      expectFailure(await call(f.bob, f.contract, 'recall_version', { version_id:A, reason:'forged recall' }), 'ERR_PROVIDER_ONLY');
      assert.equal((await call(f.provider, f.contract, 'recall_version', { version_id:A, reason:'Corrected stock count: 8, not 80.' })).succeeded, true);
      assert.notEqual((await f.contract.view('get_version', {version_id:A})).recalled_at, null);
      assert.equal((await f.contract.view('get_version', {version_id:B})).recalled_at, null);
      expectFailure(await buy(f, f.alice, A, 'after-recall'), 'ERR_VERSION_RECALLED');
    });
    await t.test('permissionless keepers credit the original buyer, never themselves', async () => {
      const beforeBuyer = await credit(f, f.alice);
      const beforeKeeper = await credit(f, f.bob);
      const tx = await call(f.bob, f.contract, 'claim_refund', {buyer_id:f.alice.accountId, receipt_id:'inventory'});
      assert.equal(tx.succeeded, true);
      assert.equal(await credit(f, f.alice), beforeBuyer + PRICE);
      assert.equal(await credit(f, f.bob), beforeKeeper);
    });
    await t.test('repeated and concurrent refund claims pay exactly once', async () => {
      const before = await credit(f, f.bob);
      const results = await Promise.all([
        call(f.alice, f.contract, 'claim_refund', {buyer_id:f.bob.accountId, receipt_id:'inventory'}),
        call(f.bob, f.contract, 'claim_refund', {buyer_id:f.bob.accountId, receipt_id:'inventory'}),
      ]);
      assert.equal(results.filter(x=>x.succeeded).length, 1);
      expectFailure(results.find(x=>x.failed), 'ERR_ALREADY_SETTLED');
      assert.equal(await credit(f, f.bob), before + PRICE);
      assert.equal((await stats(f)).refunded_total, (2n * PRICE).toString());
    });
    await t.test('contract blocks a recalled dependency even with a stale client', async () => {
      const before = await credit(f, f.processor);
      expectFailure(await call(f.alice, f.contract, 'spend_with_receipts', {
        receipt_ids:['inventory'], recipient_id:f.processor.accountId, amount:(NEAR/100n).toString(),
      }, NEAR/100n + STORAGE_BUFFER), 'ERR_DEPENDENCY_RECALLED');
      assert.equal(await credit(f, f.processor), before);
    });
    await t.test('healthy jobs remain payable and cannot claim a recall refund', async () => {
      assert.equal((await buy(f, f.alice, B, 'healthy')).succeeded, true);
      const before = await credit(f, f.processor);
      assert.equal((await call(f.alice, f.contract, 'spend_with_receipts', {
        receipt_ids:['healthy'], recipient_id:f.processor.accountId, amount:(NEAR/100n).toString(),
      }, NEAR/100n + STORAGE_BUFFER)).succeeded, true);
      assert.equal(await credit(f, f.processor), before + NEAR/100n);
      expectFailure(await call(f.alice, f.contract, 'claim_refund', {buyer_id:f.alice.accountId, receipt_id:'healthy'}), 'ERR_NOT_RECALLED');
    });
    await t.test('a definitively failed native transfer restores withdrawable credit', async () => {
      const before = await credit(f, f.alice);
      const tx = await call(f.alice, f.contract, 'withdraw', {amount:PRICE.toString(), receiver_id:'does-not-exist.test.near'}, 1n);
      assert.equal(tx.parseResult(), false);
      assert.equal(await credit(f, f.alice), before);
      assert.equal((await stats(f)).withdrawals_pending, '0');
    });
    await t.test('a successful withdrawal moves real NEAR to a separate recipient', async () => {
      const before = BigInt((await f.processor.balance()).total);
      const beforeCredit = await credit(f, f.alice);
      const tx = await call(f.alice, f.contract, 'withdraw', {amount:PRICE.toString(), receiver_id:f.processor.accountId}, 1n);
      assert.equal(tx.parseResult(), true);
      assert.equal(BigInt((await f.processor.balance()).total) - before, PRICE);
      assert.equal(await credit(f, f.alice), beforeCredit - PRICE);
      assert.equal((await stats(f)).withdrawals_pending, '0');
    });
    await t.test('external callers cannot forge withdrawal settlement callbacks', async () => {
      expectFailure(await call(f.bob, f.contract, 'on_withdrawal', {withdrawal_id:'0'}), 'private');
    });
    await t.test('a timely recall stays owed after the claim window expires', async () => {
      await publish(f, D, PRICE, '30');
      assert.equal((await buy(f, f.alice, D, 'delayed')).succeeded, true);
      assert.equal((await call(f.provider, f.contract, 'recall_version', {version_id:D, reason:'Correction before expiry.'})).succeeded, true);
      await f.worker.provider.fastForward(120);
      expectFailure(await call(f.root, f.contract, 'release_expired', {buyer_id:f.alice.accountId,receipt_id:'delayed'}), 'ERR_REFUND_STILL_OWED');
      assert.equal((await call(f.root, f.contract, 'claim_refund', {buyer_id:f.alice.accountId,receipt_id:'delayed'})).succeeded, true);
    });
    await t.test('a late recall cannot reclaim reserves after coverage ends', async () => {
      await publish(f, C, PRICE, '3');
      assert.equal((await buy(f, f.bob, C, 'expired')).succeeded, true);
      await f.worker.provider.fastForward(120);
      assert.equal((await call(f.provider, f.contract, 'recall_version', {version_id:C,reason:'Correction after expiry.'})).succeeded, true);
      expectFailure(await call(f.bob, f.contract, 'claim_refund', {buyer_id:f.bob.accountId,receipt_id:'expired'}), 'ERR_RECALL_OUTSIDE_COVERAGE');
      assert.equal((await call(f.bob, f.contract, 'release_expired', {buyer_id:f.bob.accountId,receipt_id:'expired'})).succeeded, true);
      assert.equal((await receipt(f,f.bob,'expired')).status, 'Expired');
    });
    await t.test('SDK verifies bytes and propagates a recall through parent jobs', async () => {
      const agent = new BuyerAgent(f.alice, f.contract);
      await assert.rejects(()=>agent.buy(A, 'wrong-bytes', Buffer.from('different bytes')), /ERR_DATA_DIGEST_MISMATCH/);
      agent.addJob('research', {receipts:['inventory']});
      agent.addJob('procure', {parents:['research']});
      agent.addJob('shipping', {receipts:['healthy']});
      assert.equal((await agent.refresh('procure')).status, 'paused');
      assert.equal((await agent.refresh('shipping')).status, 'ready');
      assert.equal((await agent.payNextAction('procure', f.processor, NEAR/100n)).blocked, true);
    });
    await t.test('settled liabilities are covered by the real contract balance', async () => {
      const s = await stats(f);
      assert.equal(s.withdrawals_pending, '0');
      const liabilities = BigInt(s.reserve_free) + BigInt(s.reserve_locked) + BigInt(s.withdrawable_total);
      assert.ok(BigInt((await f.contract.balance()).available) >= liabilities);
    });
  } finally { await f.worker.tearDown(); }
});
