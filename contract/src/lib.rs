use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas,
    NearToken, PanicOnDefault, Promise,
    collections::LookupMap, json_types::{U128, U64},
};

const MAX_RECEIPTS: u64 = 10_000;
const MAX_VERSIONS: u32 = 100;
const MAX_WINDOW_SECS: u64 = 30 * 24 * 60 * 60;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DataVersion {
    pub version_id: String,
    pub price: U128,
    pub warranty_secs: U64,
    pub recalled_at: Option<U64>,
    pub recall_reason: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum ReceiptStatus { Active, Refunded, Expired }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PurchaseReceipt {
    pub receipt_id: String,
    pub buyer_id: AccountId,
    pub version_id: String,
    pub price: U128,
    pub purchased_at: U64,
    pub expires_at: U64,
    pub status: ReceiptStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PendingWithdrawal {
    pub beneficiary: AccountId,
    pub receiver: AccountId,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct Stats {
    pub provider_id: AccountId,
    pub reserve_free: U128,
    pub reserve_locked: U128,
    pub withdrawable_total: U128,
    pub withdrawals_pending: U128,
    pub refunded_total: U128,
    pub receipt_count: U64,
    pub version_count: u32,
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait ExtSelf { fn on_withdrawal(&mut self, withdrawal_id: U64) -> bool; }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RecallPay {
    provider_id: AccountId,
    versions: LookupMap<String, DataVersion>,
    receipts: LookupMap<String, PurchaseReceipt>,
    credits: LookupMap<AccountId, u128>,
    withdrawals: LookupMap<u64, PendingWithdrawal>,
    reserve_free: u128,
    reserve_locked: u128,
    withdrawable_total: u128,
    withdrawals_pending: u128,
    refunded_total: u128,
    receipt_count: u64,
    version_count: u32,
    next_withdrawal: u64,
}

#[near]
impl RecallPay {
    #[init]
    pub fn new(provider_id: AccountId) -> Self {
        require!(env::predecessor_account_id() == env::current_account_id(), "ERR_OWNER_INIT");
        let mut this = Self {
            provider_id: provider_id.clone(),
            versions: LookupMap::new(b"v"), receipts: LookupMap::new(b"r"),
            credits: LookupMap::new(b"c"), withdrawals: LookupMap::new(b"w"),
            reserve_free: 0, reserve_locked: 0, withdrawable_total: 0,
            withdrawals_pending: 0, refunded_total: 0,
            receipt_count: 0, version_count: 0, next_withdrawal: 0,
        };
        this.credits.insert(&provider_id, &0);
        this
    }

    /// Immutable price, coverage window and SHA-256 dataset identifier.
    /// Provider's NEAR transaction authenticates publication and later recall.
    #[payable]
    pub fn publish_version(&mut self, version_id: String, price: U128, warranty_secs: U64) {
        self.assert_provider();
        require!(version_id.len() == 64 && version_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "ERR_SHA256_ID");
        require!(price.0 > 0, "ERR_ZERO_PRICE");
        require!(warranty_secs.0 > 0 && warranty_secs.0 <= MAX_WINDOW_SECS, "ERR_WINDOW");
        require!(self.version_count < MAX_VERSIONS, "ERR_VERSION_LIMIT");
        require!(self.versions.get(&version_id).is_none(), "ERR_VERSION_EXISTS");
        let before = env::storage_usage();
        self.versions.insert(&version_id, &DataVersion {
            version_id: version_id.clone(), price, warranty_secs,
            recalled_at: None, recall_reason: None,
        });
        self.version_count += 1;
        // Reserve space for a bounded recall reason now; recalls require no deposit.
        self.charge_storage(before, 0, 300);
        event("version_published", near_sdk::serde_json::json!({"version_id":version_id,"price":price,"warranty_secs":warranty_secs}));
    }

    #[payable]
    pub fn fund_reserve(&mut self) {
        self.assert_provider();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "ERR_ZERO_FUNDING");
        self.reserve_free += amount;
        event("reserve_funded", near_sdk::serde_json::json!({"amount":U128(amount)}));
    }

    #[payable]
    pub fn buy(&mut self, version_id: String, receipt_id: String) -> PurchaseReceipt {
        validate_id(&receipt_id);
        let buyer = env::predecessor_account_id();
        let key = receipt_key(&buyer, &receipt_id);
        let version = self.versions.get(&version_id).expect("ERR_VERSION_UNKNOWN");
        require!(version.recalled_at.is_none(), "ERR_VERSION_RECALLED");
        require!(self.receipts.get(&key).is_none(), "ERR_RECEIPT_EXISTS");
        require!(self.receipt_count < MAX_RECEIPTS, "ERR_RECEIPT_LIMIT");
        require!(self.reserve_free >= version.price.0, "ERR_RESERVE_INSUFFICIENT");
        let before = env::storage_usage();
        self.ensure_credit(&buyer);
        let now = env::block_timestamp();
        let receipt = PurchaseReceipt {
            receipt_id, buyer_id: buyer, version_id: version_id.clone(),
            price: version.price, purchased_at: U64(now),
            expires_at: U64(now + version.warranty_secs.0 * 1_000_000_000),
            status: ReceiptStatus::Active,
        };
        self.receipts.insert(&key, &receipt);
        self.receipt_count += 1;
        self.reserve_free -= version.price.0;
        self.reserve_locked += version.price.0;
        self.add_credit(&self.provider_id.clone(), version.price.0);
        // Storage is separately paid; unused deposit is withdrawable by the buyer.
        self.charge_storage(before, version.price.0, 0);
        event("purchase", near_sdk::serde_json::to_value(&receipt).unwrap());
        receipt
    }

    pub fn recall_version(&mut self, version_id: String, reason: String) {
        self.assert_provider();
        require!(!reason.is_empty() && reason.len() <= 256, "ERR_REASON_LENGTH");
        let mut version = self.versions.get(&version_id).expect("ERR_VERSION_UNKNOWN");
        require!(version.recalled_at.is_none(), "ERR_ALREADY_RECALLED");
        version.recalled_at = Some(U64(env::block_timestamp()));
        version.recall_reason = Some(reason.clone());
        self.versions.insert(&version_id, &version);
        event("version_recalled", near_sdk::serde_json::json!({"version_id":version_id,"reason":reason,"recalled_at":version.recalled_at}));
    }

    /// Any keeper may claim; the receipt fixes who receives the credit.
    pub fn claim_refund(&mut self, buyer_id: AccountId, receipt_id: String) -> U128 {
        let key = receipt_key(&buyer_id, &receipt_id);
        let mut receipt = self.receipts.get(&key).expect("ERR_RECEIPT_UNKNOWN");
        require!(receipt.status == ReceiptStatus::Active, "ERR_ALREADY_SETTLED");
        let version = self.versions.get(&receipt.version_id).unwrap();
        let recalled = version.recalled_at.expect("ERR_NOT_RECALLED").0;
        require!(recalled <= receipt.expires_at.0, "ERR_RECALL_OUTSIDE_COVERAGE");
        receipt.status = ReceiptStatus::Refunded;
        self.receipts.insert(&key, &receipt);
        self.reserve_locked -= receipt.price.0;
        self.refunded_total += receipt.price.0;
        self.add_credit(&buyer_id, receipt.price.0);
        event("refund_credited", near_sdk::serde_json::json!({"buyer_id":buyer_id,"receipt_id":receipt_id,"amount":receipt.price}));
        receipt.price
    }

    /// A timely recall remains claimable after expiry. A late recall does not
    /// retroactively create coverage against already released reserves.
    pub fn release_expired(&mut self, buyer_id: AccountId, receipt_id: String) {
        let key = receipt_key(&buyer_id, &receipt_id);
        let mut receipt = self.receipts.get(&key).expect("ERR_RECEIPT_UNKNOWN");
        require!(receipt.status == ReceiptStatus::Active, "ERR_ALREADY_SETTLED");
        require!(env::block_timestamp() > receipt.expires_at.0, "ERR_NOT_EXPIRED");
        let version = self.versions.get(&receipt.version_id).unwrap();
        require!(version.recalled_at.map_or(true, |at| at.0 > receipt.expires_at.0), "ERR_REFUND_STILL_OWED");
        receipt.status = ReceiptStatus::Expired;
        self.receipts.insert(&key, &receipt);
        self.reserve_locked -= receipt.price.0;
        self.reserve_free += receipt.price.0;
        event("coverage_expired", near_sdk::serde_json::json!({"buyer_id":buyer_id,"receipt_id":receipt_id}));
    }

    /// The check and the payment credit commit in one NEAR receipt. A recall
    /// ordered earlier rejects this action even if the client cached old data.
    /// The caller supplies the complete dependency list; provenance is voluntary.
    #[payable]
    pub fn spend_with_receipts(&mut self, receipt_ids: Vec<String>, recipient_id: AccountId, amount: U128) {
        require!(!receipt_ids.is_empty() && receipt_ids.len() <= 8, "ERR_DEPENDENCY_LIMIT");
        require!(amount.0 > 0, "ERR_ZERO_PAYMENT");
        let buyer = env::predecessor_account_id();
        for id in &receipt_ids {
            let receipt = self.receipts.get(&receipt_key(&buyer, id)).expect("ERR_RECEIPT_UNKNOWN");
            let version = self.versions.get(&receipt.version_id).unwrap();
            require!(version.recalled_at.is_none(), "ERR_DEPENDENCY_RECALLED");
        }
        let before = env::storage_usage();
        self.ensure_credit(&buyer);
        self.ensure_credit(&recipient_id);
        self.add_credit(&recipient_id, amount.0);
        self.charge_storage(before, amount.0, 0);
        event("action_paid", near_sdk::serde_json::json!({"buyer_id":buyer,"recipient_id":recipient_id,"amount":amount,"receipt_ids":receipt_ids}));
    }

    /// Only unused reserve can become provider-withdrawable.
    pub fn release_free_reserve(&mut self, amount: U128) {
        self.assert_provider();
        require!(amount.0 > 0 && amount.0 <= self.reserve_free, "ERR_RESERVE_LOCKED");
        self.reserve_free -= amount.0;
        self.add_credit(&self.provider_id.clone(), amount.0);
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128, receiver_id: Option<AccountId>) -> Promise {
        assert_one_yocto();
        let beneficiary = env::predecessor_account_id();
        let current = self.credits.get(&beneficiary).unwrap_or(0);
        require!(amount.0 > 0 && amount.0 <= current, "ERR_CREDIT_INSUFFICIENT");
        require!(env::prepaid_gas() >= Gas::from_tgas(50), "ERR_WITHDRAW_GAS");
        let receiver = receiver_id.unwrap_or(beneficiary.clone());
        let withdrawal_id = self.next_withdrawal;
        self.next_withdrawal += 1;
        self.credits.insert(&beneficiary, &(current - amount.0));
        self.withdrawable_total -= amount.0;
        self.withdrawals_pending += amount.0;
        self.withdrawals.insert(&withdrawal_id, &PendingWithdrawal { beneficiary, receiver: receiver.clone(), amount });
        event("withdrawal_pending", near_sdk::serde_json::json!({"withdrawal_id":U64(withdrawal_id),"receiver_id":receiver,"amount":amount}));
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount.0)).then(
            ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(20)).on_withdrawal(U64(withdrawal_id))
        )
    }

    #[private]
    pub fn on_withdrawal(&mut self, withdrawal_id: U64) -> bool {
        let pending = self.withdrawals.get(&withdrawal_id.0).expect("ERR_WITHDRAWAL_UNKNOWN");
        // Native transfers return an empty result. Never copy arbitrary data.
        let success = env::promise_result_checked(0, 0).is_ok();
        self.withdrawals.remove(&withdrawal_id.0);
        self.withdrawals_pending -= pending.amount.0;
        if !success { self.add_credit(&pending.beneficiary, pending.amount.0); }
        event(if success { "withdrawal_paid" } else { "withdrawal_restored" }, near_sdk::serde_json::json!({"withdrawal_id":withdrawal_id,"beneficiary":pending.beneficiary,"amount":pending.amount}));
        success
    }

    pub fn get_version(&self, version_id: String) -> Option<DataVersion> { self.versions.get(&version_id) }
    pub fn get_receipt(&self, buyer_id: AccountId, receipt_id: String) -> Option<PurchaseReceipt> { self.receipts.get(&receipt_key(&buyer_id, &receipt_id)) }
    pub fn get_credit(&self, account_id: AccountId) -> U128 { U128(self.credits.get(&account_id).unwrap_or(0)) }
    pub fn get_withdrawal(&self, withdrawal_id: U64) -> Option<PendingWithdrawal> { self.withdrawals.get(&withdrawal_id.0) }
    pub fn get_stats(&self) -> Stats {
        Stats { provider_id:self.provider_id.clone(), reserve_free:U128(self.reserve_free), reserve_locked:U128(self.reserve_locked),
            withdrawable_total:U128(self.withdrawable_total), withdrawals_pending:U128(self.withdrawals_pending),
            refunded_total:U128(self.refunded_total), receipt_count:U64(self.receipt_count), version_count:self.version_count }
    }

    fn assert_provider(&self) { require!(env::predecessor_account_id() == self.provider_id, "ERR_PROVIDER_ONLY"); }
    fn ensure_credit(&mut self, account: &AccountId) { if self.credits.get(account).is_none() { self.credits.insert(account, &0); } }
    fn add_credit(&mut self, account: &AccountId, amount: u128) {
        let current = self.credits.get(account).unwrap_or(0);
        self.credits.insert(account, &(current + amount));
        self.withdrawable_total += amount;
    }
    fn charge_storage(&mut self, before: u64, price: u128, additional_bytes: u64) {
        let bytes = env::storage_usage().saturating_sub(before) + additional_bytes;
        let storage = u128::from(bytes) * env::storage_byte_cost().as_yoctonear();
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= price + storage, "ERR_STORAGE_DEPOSIT");
        let excess = attached - price - storage;
        if excess > 0 { self.add_credit(&env::predecessor_account_id(), excess); }
    }
}

fn validate_id(id: &str) {
    require!(!id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "ERR_RECEIPT_ID");
}
fn receipt_key(buyer: &AccountId, id: &str) -> String { validate_id(id); format!("{}|{}", buyer, id) }
fn event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", near_sdk::serde_json::json!({"standard":"recallpay","version":"1.0.0","event":name,"data":[data]})));
}
