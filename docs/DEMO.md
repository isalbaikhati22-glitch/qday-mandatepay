# MandatePay demo walkthrough

A 3-minute tour of the whole product story. Everything below is executed by
[`scripts/demo.mjs`](../scripts/demo.mjs) — run it locally with no funds
(`anvil --hardfork shanghai`, then `node demo.mjs`) or on Aevum testnet
(`node demo.mjs --testnet`). The captured local run is in
[`demo-transcript-local.txt`](demo-transcript-local.txt); the testnet run adds
explorer links for every transaction.

## The story

**Cast**

- **Owner** — a user (or a DAO, or a parent agent) with a tUSD8 budget.
- **Agent** — an AI agent with a session key. It needs to pay for API calls.
- **Payee** — the API provider's address. The only address the agent may pay.

**Act 1 — Grant (owner).** The owner approves 4 tUSD8 and creates a mandate:
agent = the agent's address, payee = the provider, per-payment cap 1.5 tUSD8,
total cap 4 tUSD8, expiry in 2 hours, purpose "Demo: research agent API budget".
The 4 tUSD8 move into the MandatePay escrow. The agent's key, even if leaked,
is now worth at most 4 tUSD8 — paid only to one address, only until expiry.

**Act 2 — Spend (agent).** The agent pays invoice-001 (1.5 tUSD8) and
invoice-002 (1.5 tUSD8). Both land instantly; the payee's balance and the
mandate's remaining budget (1.0) update on-chain.

**Act 3 — Overspend attempt (agent).** The agent tries to pay another 1.5.
The contract refuses before any state changes:
`OverTotalCap(amount=1500000, remaining=1000000)`. In the demo this is proven
with a static call (no gas burned); a real transaction would revert the same
way. An agent framework can pre-flight with `canPay()` and get the same answer
in plain language.

**Act 4 — Kill switch (owner).** The owner revokes the mandate. The unspent
1.0 tUSD8 is refunded in the same transaction. No waiting period, no appeal to
a custodian.

**Act 5 — Post-revoke attempt (agent).** Paying a revoked mandate is refused:
`MandateNotActive()`.

**Epilogue — Audit.** The demo reads the mandate's events back from the chain:
creation terms, both payments with running totals, and the revocation refund.
That event stream is the complete audit trail a judge, an owner, or an
accounting system needs — no trust in the agent's own logs required.

## What to look at in the web app

Serve `web/` (any static server) with a deployed contract address in
`web/config.js` (or `?contract=0x…`):

1. **Wallet card** — balances and the contract link.
2. **Create a mandate** — the same grant flow as Act 1, with the approve step
   made explicit.
3. **Agent pay panel** — "Check if this payment is allowed" demonstrates
   `canPay()` pre-flighting before any gas is spent.
4. **My mandates** — live status pills (Active / Expired / Revoked / Settled),
   spent vs. budget, and one-click revoke/settle for the owner.
5. **Activity** — the audit trail, read from events in 1,000-block chunks
   (Aevum's `eth_getLogs` limit).

## Test checklist (all automated)

- `forge test` — 11 unit tests: creation validation, escrow accounting,
  permit-funded creation, per-payment and total cap enforcement, expiry,
  revoke refunds, settle-after-expiry, role checks, mandate isolation.
- `forge test --match-path 'test/fork/*' --fork-url aevum` — the same core
  flows against the **real tUSD8** on a fork of Aevum state, including a real
  EIP-2612 permit signature.
- `scripts/demo.mjs` — the end-to-end story above, on anvil or testnet.
