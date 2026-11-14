import { Worker } from 'near-workspaces';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NEAR, TGAS, STORAGE_BUFFER } from '../sdk/index.mjs';

const wasm = fileURLToPath(new URL('../artifacts/recallpay.wasm', import.meta.url));
function verifyArtifact() {
  const manifest=JSON.parse(readFileSync(new URL('../artifacts/build.json',import.meta.url),'utf8'));
  const hash = bytes=>createHash('sha256').update(bytes).digest('hex');
  if (hash(readFileSync(wasm))!==manifest.wasmSha256) throw new Error('WASM digest mismatch; run npm run build.');
  for (const [path,expected] of Object.entries(manifest.sourceSha256)) {
    if (hash(readFileSync(new URL(`../${path}`,import.meta.url)))!==expected) throw new Error(`Source changed: ${path}; run npm run build.`);
  }
}
export { NEAR, TGAS, STORAGE_BUFFER };
export async function fixture() {
  verifyArtifact();
  // Never inherits testnet/mainnet mode from the shell.
  const worker = await Worker.init({ network: 'sandbox', rm: true });
  try {
    const root = worker.rootAccount;
    const provider = await root.createSubAccount('provider', { initialBalance: 30n * NEAR });
    const alice = await root.createSubAccount('alice', { initialBalance: 30n * NEAR });
    const bob = await root.createSubAccount('bob', { initialBalance: 30n * NEAR });
    const processor = await root.createSubAccount('processor', { initialBalance: 5n * NEAR });
    const contract = await root.createSubAccount('recallpay', { initialBalance: 10n * NEAR });
    await contract.deploy(wasm);
    await contract.call(contract, 'new', { provider_id: provider.accountId });
    // Local accounts only: remove the deployment key so neither the provider
    // nor the demo operator can replace the code or delete the funded vault.
    const deploymentKey = await contract.getKey();
    await contract.batch(contract).deleteKey(deploymentKey.getPublicKey()).transact();
    const access = await worker.provider.viewAccessKeys(contract.accountId);
    if (access.keys.length !== 0) throw new Error('Contract deployment still has access keys.');
    return { worker, root, provider, alice, bob, processor, contract };
  } catch (e) { await worker.tearDown(); throw e; }
}
export async function call(actor, contract, method, args = {}, deposit = 0n) {
  return actor.callRaw(contract, method, args, { gas: 100n * TGAS, attachedDeposit: deposit });
}
export async function publish(f, versionId, price = NEAR / 5n, warranty = '3600') {
  const tx = await call(f.provider, f.contract, 'publish_version', {
    version_id: versionId, price: price.toString(), warranty_secs: warranty,
  }, STORAGE_BUFFER);
  if (tx.failed) throw new Error(JSON.stringify(tx.status));
  return tx;
}
export async function fund(f, amount = NEAR) {
  const tx = await call(f.provider, f.contract, 'fund_reserve', {}, amount);
  if (tx.failed) throw new Error(JSON.stringify(tx.status));
  return tx;
}
export async function credit(f, account) {
  return BigInt(await f.contract.view('get_credit', { account_id: account.accountId }));
}
export async function stats(f) { return f.contract.view('get_stats', {}); }
export function events(tx) {
  return tx.logs.filter(x => x.startsWith('EVENT_JSON:')).map(x => JSON.parse(x.slice(11)));
}
