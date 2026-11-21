#!/usr/bin/env node
/**
 * MandatePay — scripted end-to-end demo.
 *
 * Runs the whole product story on-chain and prints every transaction hash:
 *   1. Owner approves + creates a mandate (agent, payee, caps, expiry), escrowing the budget.
 *   2. Agent pays the payee twice, inside the caps, with invoice references.
 *   3. Agent tries to overspend the remaining budget  -> the contract refuses (static call).
 *   4. Owner revokes -> the unspent escrow is refunded in the same transaction.
 *   5. Agent tries to pay a revoked mandate           -> the contract refuses (static call).
 *   6. The mandate's full event history is read back as the audit trail.
 *
 * Modes:
 *   node demo.mjs            Local anvil (deploys MockUSD8 + MandatePay fresh). No real funds.
 *                            Start anvil first:  anvil --hardfork shanghai
 *   node demo.mjs --testnet  QDay Aevum testnet (chain 44005), real tUSD8.
 *                            Needs env: OWNER_PRIVATE_KEY (funded with tQDAY + tUSD8),
 *                            MANDATEPAY_ADDRESS (deployed contract).
 *                            AGENT_PRIVATE_KEY is optional: a demo agent key is generated
 *                            and stored in .env.demo (gitignored) if absent; the owner
 *                            tops the agent up with a little tQDAY for gas.
 *
 * Amounts are sized for the Discord faucet's 5 tUSD8 grant: total cap 4, per-payment 1.5.
 *
 * Implementation note: every mutating call carries an explicit gasLimit and a fresh
 * pending nonce. Some nodes (anvil in particular) reject eth_estimateGas when the
 * request carries an already-used nonce, which ethers' populate-then-estimate flow
 * can produce right after a deployment; explicit values keep the demo deterministic
 * on both anvil and Aevum.
 */
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TESTNET = process.argv.includes("--testnet");

const AEVUM = {
  chainId: 44005,
  rpc: "https://rpc-test.qday.info",
  explorer: "https://explorer-test.qday.info",
  tusd8: "0x456569838f1d43009A91ebA4263147Afd7233483",
};
// Anvil's well-known test keys — public, worthless, LOCAL MODE ONLY.
const ANVIL_OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ANVIL_PAYEE = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil account 2

const U = (n) => ethers.parseUnits(n, 6); // tUSD8 has 6 decimals
const fmt = (v) => ethers.formatUnits(v, 6);

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnvFile(join(here, ".env.demo"));

function artifact(name) {
  const p = join(here, "..", "contracts", "out", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

const line = (s = "") => console.log(s);
// Decode a revert into the contract's own error name + arguments, e.g.
// "OverTotalCap(amount=1500000, remaining=1000000)" — plain-language audit output.
function describeError(e, iface) {
  const data = e.data || (e.info && e.info.error && e.info.error.data);
  if (data && iface) {
    try {
      const parsed = iface.parseError(data);
      const args = parsed.fragment.inputs.map((inp, i) => `${inp.name}=${parsed.args[i]}`).join(", ");
      return `contract refused: ${parsed.name}(${args})`;
    } catch { /* fall through */ }
  }
  return e.shortMessage || (e.message || "").split("\n")[0];
}


async function main() {
  // cacheTimeout: -1 disables ethers' identical-request cache; without it, rapid
  // back-to-back eth_getTransactionCount reads can return a stale (pre-tx) nonce.
  const provider = new ethers.JsonRpcProvider(TESTNET ? AEVUM.rpc : "http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
  const net = await provider.getNetwork();
  line(`=== MandatePay end-to-end demo (${TESTNET ? "Aevum testnet" : "local anvil"}) ===`);
  line(`Chain ID: ${net.chainId}`);

  const txLink = (hash) => (TESTNET ? `${AEVUM.explorer}/tx/${hash}` : hash);
  // Legacy (type 0) transactions are the safe default on Aevum (see starter kit notes).
  const baseOpts = TESTNET ? { gasPrice: ethers.parseUnits("2", "gwei"), type: 0 } : {};
  // Explicit gas + fresh pending nonce for every mutating call (see header note).
  const opts = async (signer, gasLimit) => ({
    ...baseOpts,
    gasLimit,
    nonce: await provider.getTransactionCount(await signer.getAddress(), "pending"),
  });

  let owner, agent, payee, token, mp, mpAddress;

  if (TESTNET) {
    if (!process.env.OWNER_PRIVATE_KEY) throw new Error("OWNER_PRIVATE_KEY missing (see .env.example)");
    if (!process.env.MANDATEPAY_ADDRESS) throw new Error("MANDATEPAY_ADDRESS missing — deploy first");
    owner = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY, provider);
    if (!process.env.AGENT_PRIVATE_KEY) {
      const w = ethers.Wallet.createRandom();
      process.env.AGENT_PRIVATE_KEY = w.privateKey;
      writeFileSync(join(here, ".env.demo"), `AGENT_PRIVATE_KEY=${w.privateKey}\n`, { mode: 0o600 });
      line(`Generated a demo agent key (stored in scripts/.env.demo, gitignored): ${w.address}`);
    }
    agent = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
    payee = process.env.PAYEE_ADDRESS || "0x000000000000000000000000000000000000dEaD";
    mpAddress = process.env.MANDATEPAY_ADDRESS;
    token = new ethers.Contract(AEVUM.tusd8, artifact("MockUSD8").abi, provider);
    // Top the agent up with gas money if it is running dry.
    if ((await provider.getBalance(agent.address)) < ethers.parseEther("0.01")) {
      line(`Topping up agent gas: 0.05 tQDAY from owner -> agent`);
      const t = await owner.sendTransaction({ to: agent.address, value: ethers.parseEther("0.05"), ...(await opts(owner, 21000)) });
      await t.wait();
      line(`  tx: ${txLink(t.hash)}`);
    }
  } else {
    owner = new ethers.Wallet(ANVIL_OWNER_KEY, provider);
    agent = new ethers.Wallet(ANVIL_AGENT_KEY, provider);
    payee = ANVIL_PAYEE;
    const mockArt = artifact("MockUSD8");
    const mockFactory = new ethers.ContractFactory(mockArt.abi, mockArt.bytecode.object, owner);
    const mock = await mockFactory.deploy(await opts(owner, 3_000_000));
    await mock.waitForDeployment();
    token = mock;
    line(`MockUSD8 deployed: ${await mock.getAddress()}`);
    await (await mock.mint(owner.address, U("100"), await opts(owner, 120_000))).wait();
  }

  const mpArt = artifact("MandatePay");
  if (TESTNET) {
    mp = new ethers.Contract(mpAddress, mpArt.abi, provider);
  } else {
    const factory = new ethers.ContractFactory(mpArt.abi, mpArt.bytecode.object, owner);
    mp = await factory.deploy(await token.getAddress(), await opts(owner, 4_000_000));
    await mp.waitForDeployment();
    mpAddress = await mp.getAddress();
  }
  line(`MandatePay: ${mpAddress}`);
  line(`Owner:  ${owner.address}`);
  line(`Agent:  ${agent.address}  (session key — can only pay within the mandate)`);
  line(`Payee:  ${payee}  (the only address the agent can pay)`);
  line(`Owner tUSD8 before: ${fmt(await token.balanceOf(owner.address))}`);
  line();

  // 1) Create the mandate: per-payment cap 1.5, total cap 4, expires in 2 hours.
  const totalCap = U("4"), perPayCap = U("1.5");
  const expiry = Math.floor(Date.now() / 1000) + 2 * 3600;
  line(`1) Owner approves ${fmt(totalCap)} tUSD8 and creates the mandate (per-payment cap ${fmt(perPayCap)}, expiry in 2h)`);
  let tx = await token.connect(owner).approve(mpAddress, totalCap, await opts(owner, 80_000));
  await tx.wait();
  line(`   approve tx: ${txLink(tx.hash)}`);
  tx = await mp.connect(owner).createMandate(agent.address, payee, perPayCap, totalCap, expiry, "Demo: research agent API budget", await opts(owner, 500_000));
  const rcpt = await tx.wait();
  const created = rcpt.logs.map((l) => { try { return mp.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MandateCreated");
  const id = created.args.mandateId;
  line(`   createMandate tx: ${txLink(tx.hash)}  -> mandate #${id}`);
  line(`   Escrow locked in contract: ${fmt(await token.balanceOf(mpAddress))} tUSD8`);
  line();

  // 2) Agent pays twice, inside the caps.
  for (const [n, invoice] of [[1, "invoice-001"], [2, "invoice-002"]]) {
    line(`2.${n}) Agent pays ${fmt(perPayCap)} tUSD8 to the payee (ref: ${invoice})`);
    tx = await mp.connect(agent).pay(id, perPayCap, ethers.keccak256(ethers.toUtf8Bytes(invoice)), await opts(agent, 250_000));
    await tx.wait();
    line(`   pay tx: ${txLink(tx.hash)}`);
    line(`   Payee balance: ${fmt(await token.balanceOf(payee))} | remaining budget: ${fmt(await mp.remainingOf(id))}`);
  }
  line();

  // 3) Overspend attempt — refused by the contract (proven with a static call, no gas burned).
  line(`3) Agent tries to pay another ${fmt(perPayCap)} — only ${fmt(await mp.remainingOf(id))} remains`);
  try {
    await mp.connect(agent).pay.staticCall(id, perPayCap, ethers.ZeroHash);
    line(`   UNEXPECTED: the call succeeded`);
  } catch (e) {
    line(`   REFUSED on-chain: ${describeError(e, mp.interface)}`);
  }
  line();

  // 4) Owner revokes — unspent escrow comes straight back.
  line(`4) Owner revokes the mandate (kill switch)`);
  const ownerBefore = await token.balanceOf(owner.address);
  tx = await mp.connect(owner).revoke(id, await opts(owner, 250_000));
  await tx.wait();
  const ownerAfter = await token.balanceOf(owner.address);
  line(`   revoke tx: ${txLink(tx.hash)}`);
  line(`   Refunded to owner: ${fmt(ownerAfter - ownerBefore)} tUSD8`);
  line();

  // 5) Paying a revoked mandate is refused too.
  line(`5) Agent tries to pay the revoked mandate`);
  try {
    await mp.connect(agent).pay.staticCall(id, U("0.5"), ethers.ZeroHash);
    line(`   UNEXPECTED: the call succeeded`);
  } catch (e) {
    line(`   REFUSED on-chain: ${describeError(e, mp.interface)}`);
  }
  line();

  // 6) Audit trail: read the mandate's events back from the chain.
  line(`6) Audit trail for mandate #${id} (events read from chain):`);
  const fromBlock = TESTNET ? Math.max(0, (await provider.getBlockNumber()) - 900) : 0;
  for (const ev of ["MandateCreated", "PaymentExecuted", "MandateRevoked", "MandateSettled"]) {
    const logs = await mp.queryFilter(mp.filters[ev](), fromBlock, "latest");
    for (const l of logs) {
      if (l.args.mandateId !== id) continue;
      const a = l.args;
      if (ev === "MandateCreated") line(`   [block ${l.blockNumber}] Created: agent=${a.agent} payee=${a.payee} perPay=${fmt(a.perPaymentCap)} total=${fmt(a.totalCap)} purpose="${a.purpose}"`);
      if (ev === "PaymentExecuted") line(`   [block ${l.blockNumber}] Payment: ${fmt(a.amount)} tUSD8 -> ${a.payee} (total spent ${fmt(a.totalSpent)})`);
      if (ev === "MandateRevoked") line(`   [block ${l.blockNumber}] Revoked: refunded ${fmt(a.refunded)} tUSD8`);
      if (ev === "MandateSettled") line(`   [block ${l.blockNumber}] Settled: refunded ${fmt(a.refunded)} tUSD8`);
    }
  }
  line();
  line(`Final: owner ${fmt(await token.balanceOf(owner.address))} | payee ${fmt(await token.balanceOf(payee))} | escrow ${fmt(await token.balanceOf(mpAddress))} tUSD8`);
  line(`=== Demo complete ===`);
}

main().catch((e) => { console.error("DEMO FAILED:", e.shortMessage || e.message); process.exit(1); });
