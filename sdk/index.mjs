import { createHash } from 'node:crypto';

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const STORAGE_BUFFER = NEAR / 50n;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The application keeps its dependency graph; RecallPay stores purchases.
 * A complete flattened dependency list is submitted for each protected action.
 * Use only JSON-safe receipt ids and always verify downloaded data bytes.
 */
export class BuyerAgent {
  constructor(account, contract) {
    this.account = account;
    this.contract = contract;
    this.jobs = new Map();
  }
  async buy(versionId, receiptId, bytes) {
    if (digest(bytes) !== versionId) throw new Error('ERR_DATA_DIGEST_MISMATCH');
    const version = await this.contract.view('get_version', { version_id: versionId });
    if (!version) throw new Error('ERR_VERSION_UNKNOWN');
    const tx = await this.account.callRaw(this.contract, 'buy', {
      version_id: versionId, receipt_id: receiptId,
    }, { gas: 100n * TGAS, attachedDeposit: BigInt(version.price) + STORAGE_BUFFER });
    if (tx.failed) throw new Error(JSON.stringify(tx.status));
    return { receipt: tx.parseResult(), tx };
  }
  addJob(id, { receipts = [], parents = [] } = {}) {
    if (this.jobs.has(id)) throw new Error('ERR_JOB_EXISTS');
    for (const parent of parents) if (!this.jobs.has(parent)) throw new Error('ERR_PARENT_UNKNOWN');
    this.jobs.set(id, { id, receipts: [...receipts], parents: [...parents], status: 'ready' });
  }
  dependencies(id, visiting = new Set()) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('ERR_JOB_UNKNOWN');
    if (visiting.has(id)) throw new Error('ERR_DEPENDENCY_CYCLE');
    const next = new Set([...visiting, id]);
    return [...new Set([...job.receipts, ...job.parents.flatMap(p => this.dependencies(p, next))])];
  }
  async refresh(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('ERR_JOB_UNKNOWN');
    const reasons = [];
    for (const receiptId of this.dependencies(id)) {
      const receipt = await this.contract.view('get_receipt', { buyer_id: this.account.accountId, receipt_id: receiptId });
      if (!receipt) throw new Error('ERR_RECEIPT_UNKNOWN');
      const version = await this.contract.view('get_version', { version_id: receipt.version_id });
      if (version.recalled_at !== null) reasons.push({ receiptId, versionId: version.version_id, reason: version.recall_reason });
    }
    job.status = reasons.length ? 'paused' : 'ready';
    job.reasons = reasons;
    return structuredClone(job);
  }
  async payNextAction(id, recipient, amount) {
    const job = await this.refresh(id);
    if (job.status === 'paused') return { blocked: true, source: 'client', job };
    const tx = await this.account.callRaw(this.contract, 'spend_with_receipts', {
      receipt_ids: this.dependencies(id), recipient_id: recipient.accountId, amount: amount.toString(),
    }, { gas: 100n * TGAS, attachedDeposit: amount + STORAGE_BUFFER });
    // A recall can land between refresh and this call. The contract is final.
    if (tx.failed && JSON.stringify(tx.status).includes('ERR_DEPENDENCY_RECALLED')) {
      return { blocked: true, source: 'contract', job: await this.refresh(id), tx };
    }
    if (tx.failed) throw new Error(JSON.stringify(tx.status));
    return { blocked: false, job, tx };
  }
  async claim(receiptId, keeper = this.account) {
    const tx = await keeper.callRaw(this.contract, 'claim_refund', {
      buyer_id: this.account.accountId, receipt_id: receiptId,
    }, { gas: 100n * TGAS });
    if (tx.failed) throw new Error(JSON.stringify(tx.status));
    return tx;
  }
}
