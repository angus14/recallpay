# 90-second demonstration

“These two agents are preparing a stock plan and shipping estimates. They buy
versioned data, and each purchase comes with a refund reserve funded by the
provider in advance.

“The provider has already withdrawn its sale proceeds. It then discovers a
stock count was 8, not 80, and recalls that exact inventory version.

“RecallPay identifies both direct users and the procurement job derived from
their research. Three affected jobs pause. Two unrelated shipping jobs continue
and pay for their next action.

“This client missed the notification. It tries to pay using the recalled input.
The NEAR contract rejects the payment itself.

“A keeper claims both refunds, but cannot change who receives them. Each buyer
withdraws 0.2 NEAR to its wallet. Repeating the claim fails.

“The transaction hashes, emitted events, wallet balance changes and checks are
all available in this report. The demo runs on a local NEAR blockchain, with
synthetic data and scripted agents.

“RecallPay turns a provider's data correction into a funded response across
participating agent workflows.”

Important scope: provider-declared recalls, purchase-fee refunds, complete
declared dependencies, and future actions routed through the payment gate.
This does not reverse completed work or automatically detect every error.
