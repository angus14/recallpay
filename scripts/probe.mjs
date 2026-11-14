import { Worker } from 'near-workspaces';
const worker = await Worker.init({ network: 'sandbox', rm: true });
try { console.log('SANDBOX_READY', worker.rootAccount.accountId, (await worker.provider.status()).version); }
finally { await worker.tearDown(); }
