# MandatePay

**Give your AI agent a budget, not your wallet.**

Capped, expiring, revocable payment mandates for AI agents, escrowed in **tUSD8** on the
**QDay Aevum testnet** (chain 44005). Built for the
[Aevum Builder Challenge #1](https://dorahacks.io/hackathon/qday/detail).

---

## The problem

An autonomous agent that pays for APIs, data, or compute needs a payment credential.
Today the choices are bad:

- **A raw wallet key** — unlimited. One prompt injection or one buggy loop can drain it.
- **A plain ERC-20 allowance** — silent and shapeless: no per-payment cap, no payee
  pinning, no expiry, no audit trail an owner can actually read, and the owner can yank
  the underlying funds at any time, so the agent can't rely on it either.
- **Custodial API keys / virtual cards** — off-chain trust, no verifiable limits.

What an owner actually wants to say is: *"Agent, you may pay **this merchant**, at most
**1.5 tUSD8 at a time** and **4 tUSD8 in total**, until **Friday** — then stop."*

That sentence is a **mandate**. MandatePay makes it a smart contract.

## How it works

```
Owner ── approve + createMandate(agent, payee, perPaymentCap, totalCap, expiry) ──▶ MandatePay
        totalCap tUSD8 moves into escrow (or in ONE tx via EIP-2612 permit)
Agent ── pay(mandateId, amount, memo) ──▶ MandatePay ── tUSD8 ──▶ Payee     (caps enforced)
Owner ── revoke(mandateId) ──▶ unspent escrow refunded in the same transaction   (kill switch)
Owner ── settleExpired(mandateId) ──▶ withdraw the remainder after expiry
```

- **Escrow, not allowance-pulling.** The full budget is locked at creation, so the caps
  the owner saw are the caps that hold for the mandate's whole life — payments can't fail
  because funds moved, and can't exceed the escrow by construction.
- **One agent, one payee.** The mandate names exactly one agent address (a session key)
  and exactly one payee. A compromised agent key can only ever pay that payee, within
  the caps, until expiry — and the owner can revoke instantly.
- **Every payment is an event.** `MandateCreated`, `PaymentExecuted` (with an agent-chosen
  `memo` that binds the payment to an invoice or an x402 request id), `MandateRevoked`,
  `MandateSettled` — a complete, verifiable on-chain audit trail.
- **Agents can pre-flight.** `canPay(id, amount)` returns whether a payment would succeed
  and a plain-language reason if not, so agent frameworks fail cheap and explain why.

## Why this fits QDay

QDay's own roadmap pairs ERC-4337 session-scoped spending caps with ERC-8004 agent
identity. MandatePay implements the spending-mandate primitive today, at the contract
layer any agent framework can call, and is designed to plug into ERC-8004 identity
(agents identified by registry id, not just address) as soon as a registry is published
for Aevum — see [Platform notes](#platform-notes--recon-findings) and the roadmap.

## How the judging criteria are addressed

| Criterion | Where |
|---|---|
| 1 · UX & presentation | Static web app (`web/`) — connect wallet, create / pay / revoke / settle, plain-language errors, explorer link on every action. No build step. |
| 2 · Clear, verifiable demo | `scripts/demo.mjs` runs the full story on-chain and prints every tx hash; local run transcript in `docs/demo-transcript-local.txt`; testnet run linked in [Demo](#demo). |
| 3 · Documentation | This README: architecture, env vars, addresses, step-by-step reproduction. `docs/DEMO.md` walks the demo. |
| 4 · Innovation | Payment *mandates* as an agentic primitive: escrowed budgets + pinned payee + per-payment & total caps + expiry + instant revoke + memo binding for x402-style request payments. |
| 5 · Technical quality & platform integration | Foundry project, Shanghai-safe bytecode, 11 unit tests + fork tests against the **real tUSD8**; EIP-2612 permit funding (one-tx mandate creation); legacy transactions; 1,000-block-chunked log reads — all per Aevum's platform rules. Scoped session keys are the mandate's agent address; spend caps and expiry are enforced on-chain. |
| 6 · Real-world utility | Agent API budgets, per-vendor spend limits, payroll-style recurring payouts with a hard ceiling, marketplace escrowed purchasing power. |
| 7 · Safety, trust, controls | Least privilege by construction (one agent / one payee / two caps / expiry), instant revocation with automatic refund, escrow accounting, reentrancy guard, SafeERC20-style transfers, full event audit trail. |
| 8 · Ecosystem value | MIT-licensed, dependency-light contract (no external libs in deployed code), documented `canPay` pre-flight API for agent frameworks, reusable mock + fork-test harness. |

## Architecture

```
┌────────┐   createMandate / permit    ┌──────────────────────────────┐
│ Owner  │ ───────────────────────────▶│ MandatePay (this repo)       │
└────────┘   revoke / settleExpired    │  · escrowed tUSD8 balances   │
                                       │  · per-mandate caps + expiry │
┌────────┐   pay(id, amount, memo)     │  · event audit trail         │
│ Agent  │ ───────────────────────────▶│                              │
└────────┘                             └──────────────┬───────────────┘
   session key                                        │ transfer
                                               ┌──────▼───────┐
                                               │ Payee        │  (merchant / API provider)
                                               └──────────────┘
        Token: tUSD8 0x456569838f1d43009A91ebA4263147Afd7233483 (Aevum testnet)
```

State machine per mandate: `Active → Revoked` (owner, any time) or
`Active → (past expiry) → Settled` (owner withdraws remainder). Payments are only
possible in `Active` and not past expiry.

## Repository layout

```
contracts/                 Foundry project (solc 0.8.24, evm_version = shanghai)
  src/MandatePay.sol         the contract (dependency-free, commented)
  src/MockUSD8.sol           local tUSD8 stand-in with EIP-2612 permit (tests/demo only)
  test/MandatePay.t.sol      11 unit tests
  test/fork/…Fork.t.sol      fork tests against the real tUSD8 on Aevum state
  script/Deploy.s.sol        deployment script
web/                       static UI (plain HTML/JS + ethers v6 via CDN, no build)
scripts/demo.mjs           scripted end-to-end demo (local anvil + Aevum testnet modes)
docs/                      demo walkthrough, transcripts, flattened source
```

## Quickstart

Prerequisites: [Foundry](https://book.getfoundry.sh/getting-started/installation), Node 22+.

### 1 · Build and test (no funds needed)

```bash
cd contracts
forge build
forge test                                  # 11 unit tests
forge test --match-path 'test/fork/*' --fork-url aevum   # against real tUSD8 state
```

### 2 · Full demo on a local chain (no funds needed)

```bash
# terminal 1
anvil --hardfork shanghai
# terminal 2
cd scripts && npm install
node demo.mjs        # deploys MockUSD8 + MandatePay, runs the whole story
```

Expected output: [`docs/demo-transcript-local.txt`](docs/demo-transcript-local.txt) —
create → two payments → an overspend **refused** (`OverTotalCap`) → revoke with refund →
a post-revoke payment **refused** (`MandateNotActive`) → the event audit trail.

### 3 · Deploy to Aevum testnet

Get test funds first (see [Getting test tokens](#getting-test-tokens)), then:

```bash
cd contracts
TOKEN=0x456569838f1d43009A91ebA4263147Afd7233483 \
forge script script/Deploy.s.sol --rpc-url aevum --broadcast --legacy \
  --private-key $DEPLOYER_PRIVATE_KEY
```

Then run the same demo against the real network and real tUSD8:

```bash
cd scripts
OWNER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY MANDATEPAY_ADDRESS=<deployed address> \
  node demo.mjs --testnet
```

And point the web app at it: set `mandatePay` in `web/config.js` (or serve `web/`
and open `index.html?contract=<deployed address>`).

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | forge deploy | Testnet deployer key. Test wallets only, never commit. |
| `OWNER_PRIVATE_KEY` | `demo.mjs --testnet` | Demo owner (= deployer is fine). Needs tQDAY for gas + tUSD8. |
| `MANDATEPAY_ADDRESS` | demo, web config | Deployed MandatePay address. |
| `AGENT_PRIVATE_KEY` | demo (optional) | Demo agent key; auto-generated into `scripts/.env.demo` if absent. |
| `PAYEE_ADDRESS` | demo (optional) | Demo payee; defaults to a burn address for testnet runs. |
| `TOKEN` | forge deploy (optional) | Token address; defaults to deploying a local `MockUSD8`. |

## Aevum testnet addresses

| | |
|---|---|
| Network | QDay Aevum Testnet · chain ID **44005** |
| RPC | https://rpc-test.qday.info |
| Explorer | https://explorer-test.qday.info |
| Gas token | tQDAY (~1 gwei) |
| tUSD8 | [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483) (6 decimals, EIP-2612 + EIP-3009) |
| **MandatePay** | **Deployment pending faucet funding — see status note below.** |
| Deployer (demo) wallet | `0x05fc31EfE7abc2Bba549cD7e57c6133ed4CE8Aa9` (testnet-only garap wallet) |

> **Deployment status.** Everything in this repo is built, unit-tested, fork-tested
> against the real tUSD8, and demo-proven end-to-end on a local chain. The testnet
> deployment itself is one command (above) and is waiting on faucet funds for the
> deployer wallet: the web faucet requires the recipient to hold a mainnet balance
> (this fresh test wallet has none), so funding goes through the **Discord faucet**
> (QDay Discord → `#verify` ✅ → `/faucet 0x05fc31EfE7abc2Bba549cD7e57c6133ed4CE8Aa9`,
> grants 1 tQDAY + 5 tUSD8 — sized to this demo). Once funded, deployment + the
> testnet demo take ~2 minutes and this table gains the MandatePay address and the
> demo's explorer links.

## Demo

- Walkthrough: [`docs/DEMO.md`](docs/DEMO.md)
- Local end-to-end transcript: [`docs/demo-transcript-local.txt`](docs/demo-transcript-local.txt)
- Testnet transcript: `docs/demo-transcript-testnet.txt` (added after the funded run,
  with explorer links for approve / create / pay / pay / revoke).

## Getting test tokens

- **Discord faucet (for Builder Challenge participants):** join the
  [QDay Discord](https://discord.gg/bYPhjmrSfK), react ✅ in `#verify`, then run
  `/faucet <your address>` → **1 tQDAY + 5 tUSD8** (once per Discord account and
  per address).
- **Web faucet:** https://faucet.qday.info — 5 tQDAY per claim, once per 24 h;
  the recipient must hold a small Ethereum mainnet balance (~0.0001 ETH or
  1 USDT/USDC) as an anti-abuse check.

## Platform notes & recon findings

From the official starter kit (`qday-io/aevum-starter-kit`, MIT, PQA Labs) and docs:

- **Shanghai EVM.** Compile with `evm_version = "shanghai"`; Cancun opcodes revert.
  `foundry.toml` here is set accordingly.
- **Legacy transactions** are the chain's norm (the faucet itself uses them);
  the demo script sends type-0 transactions on testnet.
- **`eth_getLogs` is capped at 1,000 blocks per call.** The web app chunks its
  event scans accordingly.
- **Explorer verification is not working yet** (per the starter kit README), so
  `forge verify-contract` fails for everyone right now. Instead, this repo ships
  the exact source of the deployed contract, the flattened source
  (`docs/MandatePay.flattened.sol`), and the compiler settings: solc **0.8.24**,
  optimizer **200 runs**, `evm_version = shanghai`. The verify command, for when
  the explorer's verifier is back:
  `forge verify-contract <address> src/MandatePay.sol:MandatePay --chain-id 44005 --verifier blockscout --verifier-url https://explorer-test.qday.info/api/`
- **Account abstraction** is not officially supported on Aevum yet (no supported
  bundler/paymaster per the kit FAQ, which explicitly suggests: *"For budgets,
  limits, expiry and revoke, write them into your own contract"* — which is
  exactly what MandatePay does).
- **ERC-8004** is on QDay's published roadmap (agent identity + reputation), and
  the x402 facilitator is live on Aevum; no ERC-8004 registry address is
  published for the testnet yet. MandatePay's `memo` field already binds
  payments to x402 request ids, and the agent slot is ready to resolve through
  an ERC-8004 registry once deployed.

## Roadmap

- ERC-8004 identity binding: mandates issued to agent *identities*, with
  reputation-aware default caps.
- x402 integration: a facilitator-side helper that turns an x402 payment
  requirement into a `pay()` call under a mandate.
- Multi-payee mandates with per-payee sub-caps; recurring "salary" mandates
  with per-period budgets that refill on schedule.
- ERC-4337 session-key front-end once a supported bundler lands on Aevum.
- Mainnet deployment for QDay's February mainnet builder program.

## License

MIT — see [LICENSE](LICENSE). Third-party credits in [NOTICE.md](NOTICE.md).
Based on network parameters and plumbing conventions from the
[Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT, PQA Labs);
all MandatePay code is original.
