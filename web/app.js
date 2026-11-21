/* MandatePay web app — plain ethers v6, no build step. */
(function () {
  const CFG = window.MANDATEPAY_CONFIG;
  const params = new URLSearchParams(location.search);
  const CONTRACT = params.get("contract") || CFG.mandatePay;
  const DEC = CFG.tusd8Decimals;

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ];
  const MP_ABI = [
    "function createMandate(address agent,address payee,uint256 perPaymentCap,uint256 totalCap,uint64 expiry,string purpose) returns (uint256)",
    "function pay(uint256 mandateId,uint256 amount,bytes32 memo)",
    "function revoke(uint256 mandateId)",
    "function settleExpired(uint256 mandateId)",
    "function getMandate(uint256) view returns ((address owner,address agent,address payee,uint256 perPaymentCap,uint256 totalCap,uint256 spent,uint64 expiry,uint8 status,string purpose))",
    "function remainingOf(uint256) view returns (uint256)",
    "function statusOf(uint256) view returns (uint8)",
    "function canPay(uint256,uint256) view returns (bool,string)",
    "function mandateCount() view returns (uint256)",
    "event MandateCreated(uint256 indexed mandateId,address indexed owner,address indexed agent,address payee,uint256 perPaymentCap,uint256 totalCap,uint64 expiry,string purpose)",
    "event PaymentExecuted(uint256 indexed mandateId,address indexed agent,address indexed payee,uint256 amount,uint256 totalSpent,bytes32 memo)",
    "event MandateRevoked(uint256 indexed mandateId,address indexed owner,uint256 refunded)",
    "event MandateSettled(uint256 indexed mandateId,address indexed owner,uint256 refunded)",
  ];

  const $ = (id) => document.getElementById(id);
  const fmt = (v) => ethers.formatUnits(v, DEC);
  const parse = (s) => ethers.parseUnits(String(s || "0"), DEC);
  const txUrl = (h) => `${CFG.explorer}/tx/${h}`;
  const addrUrl = (a) => `${CFG.explorer}/address/${a}`;
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
  const STATUS = ["Active", "Expired", "Revoked", "Settled"];

  const FRIENDLY = {
    NotAgent: "Only the mandate's agent address can make this payment.",
    NotOwner: "Only the mandate's owner can do that.",
    MandateNotActive: "This mandate is closed (revoked or settled).",
    MandateExpired: "This mandate has expired.",
    MandateNotExpired: "This mandate has not expired yet — revoke it instead if you want to close it now.",
    OverPerPaymentCap: "That amount is above the per-payment cap.",
    OverTotalCap: "That amount is above the budget remaining in the mandate.",
    ZeroAmount: "Enter an amount above zero.",
    ZeroAddress: "An address field is empty or invalid.",
    TotalCapBelowPerPaymentCap: "The total cap must be at least the per-payment cap.",
    ExpiryNotInFuture: "The expiry must be in the future.",
    TransferFailed: "The token transfer failed.",
  };

  let readProvider, walletProvider, signer, account;
  readProvider = new ethers.JsonRpcProvider(CFG.rpc, undefined, { cacheTimeout: -1 });
  const mpRead = CONTRACT ? new ethers.Contract(CONTRACT, MP_ABI, readProvider) : null;
  const tokenRead = new ethers.Contract(CFG.tusd8, ERC20_ABI, readProvider);

  function status(msg, hash) {
    const el = $("status");
    el.innerHTML = msg + (hash ? ` · <a href="${txUrl(hash)}" target="_blank" rel="noopener">view tx</a>` : "");
    el.classList.add("show");
  }
  function fail(e, iface) {
    let msg = e.shortMessage || e.message || String(e);
    const data = e.data || (e.info && e.info.error && e.info.error.data);
    if (data && iface) {
      try {
        const p = iface.parseError(data);
        if (FRIENDLY[p.name]) msg = FRIENDLY[p.name];
      } catch { /* keep default */ }
    }
    if (/user rejected/i.test(msg)) msg = "Transaction rejected in the wallet.";
    status("⚠️ " + msg);
  }

  async function ensureNetwork() {
    const net = await walletProvider.getNetwork();
    if (Number(net.chainId) === CFG.chainId) return;
    const hex = "0x" + CFG.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex, chainName: CFG.chainName,
            rpcUrls: [CFG.rpc],
            blockExplorerUrls: [CFG.explorer],
            nativeCurrency: { name: "Test QDAY", symbol: CFG.nativeSymbol, decimals: 18 },
          }],
        });
      } else throw e;
    }
  }

  async function connect() {
    if (!window.ethereum) { status("⚠️ No browser wallet found. Install MetaMask or Rabby, or use the read-only views below."); return; }
    walletProvider = new ethers.BrowserProvider(window.ethereum);
    await walletProvider.send("eth_requestAccounts", []);
    await ensureNetwork();
    signer = await walletProvider.getSigner();
    account = await signer.getAddress();
    $("connectBtn").textContent = short(account);
    await refreshWallet();
    await loadMandates();
    await loadActivity();
  }

  async function refreshWallet() {
    if (!account) return;
    $("wAddr").innerHTML = `<a href="${addrUrl(account)}" target="_blank" rel="noopener">${account}</a>`;
    const [gas, usd] = await Promise.all([
      readProvider.getBalance(account),
      tokenRead.balanceOf(account),
    ]);
    $("wGas").textContent = `${ethers.formatEther(gas)} ${CFG.nativeSymbol}`;
    $("wUsd").textContent = `${fmt(usd)} tUSD8`;
    $("wContract").innerHTML = CONTRACT
      ? `<a href="${addrUrl(CONTRACT)}" target="_blank" rel="noopener">${CONTRACT}</a>`
      : "not configured";
  }

  function writer() {
    if (!signer) throw new Error("Connect a wallet first.");
    return new ethers.Contract(CONTRACT, MP_ABI, signer);
  }

  async function create() {
    try {
      if (!CONTRACT) throw new Error("No MandatePay address configured.");
      const agent = $("cAgent").value.trim(), payee = $("cPayee").value.trim();
      if (!ethers.isAddress(agent) || !ethers.isAddress(payee)) throw new Error("Agent and payee must be valid addresses.");
      const perPay = parse($("cPerPay").value), total = parse($("cTotal").value);
      const hours = parseFloat($("cHours").value || "24");
      const expiry = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
      const purpose = $("cPurpose").value.trim() || "MandatePay mandate";
      const mp = writer();
      const token = new ethers.Contract(CFG.tusd8, ERC20_ABI, signer);
      const allowance = await token.allowance(account, CONTRACT);
      if (allowance < total) {
        status(`Approving ${fmt(total)} tUSD8 escrow…`);
        const t = await token.approve(CONTRACT, total);
        await t.wait();
        status(`Approved.`, t.hash);
      }
      status("Creating the mandate…");
      const tx = await mp.createMandate(agent, payee, perPay, total, expiry, purpose);
      const rcpt = await tx.wait();
      const ev = rcpt.logs.map((l) => { try { return mp.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MandateCreated");
      status(`✅ Mandate #${ev.args.mandateId} created — ${fmt(total)} tUSD8 escrowed.`, tx.hash);
      await refreshWallet(); await loadMandates(); await loadActivity();
    } catch (e) { fail(e, mpRead && mpRead.interface); }
  }

  async function checkPay() {
    try {
      const id = BigInt($("pId").value || "0");
      const amount = parse($("pAmount").value);
      const [ok, reason] = await mpRead.canPay(id, amount);
      status(ok ? `✅ Mandate #${id} would accept a ${fmt(amount)} tUSD8 payment right now.` : `🚫 Not payable: ${reason}.`);
    } catch (e) { fail(e, mpRead.interface); }
  }

  async function pay() {
    try {
      const id = BigInt($("pId").value || "0");
      const amount = parse($("pAmount").value);
      const memo = ethers.keccak256(ethers.toUtf8Bytes($("pRef").value.trim() || "payment"));
      const mp = writer();
      status("Sending payment…");
      const tx = await mp.pay(id, amount, memo);
      await tx.wait();
      status(`✅ Paid ${fmt(amount)} tUSD8 under mandate #${id}.`, tx.hash);
      await refreshWallet(); await loadMandates(); await loadActivity();
    } catch (e) { fail(e, mpRead && mpRead.interface); }
  }

  // eth_getLogs on Aevum covers at most 1,000 blocks per call — scan in chunks.
  async function getLogsChunked(filter, fromBlock, toBlock) {
    const out = [];
    for (let start = fromBlock; start <= toBlock; start += 1000) {
      const end = Math.min(start + 999, toBlock);
      out.push(...await readProvider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
    }
    return out;
  }

  async function loadMandates() {
    if (!account || !mpRead) return;
    const head = await readProvider.getBlockNumber();
    const from = Math.max(CFG.deployBlock || 0, head - 20000);
    const base = { address: CONTRACT, topics: [ethers.id("MandateCreated(uint256,address,address,address,uint256,uint256,uint64,string)")] };
    const mine = new Set();
    for (const topicIdx of [2, 3]) { // owner topic, agent topic
      const topics = [...base.topics];
      topics[topicIdx] = ethers.zeroPadValue(account, 32);
      const logs = await getLogsChunked({ address: CONTRACT, topics }, from, head);
      for (const l of logs) mine.add(Number(mpRead.interface.parseLog(l).args.mandateId));
    }
    const ids = [...mine].sort((a, b) => b - a);
    if (!ids.length) { $("mandateList").innerHTML = `<p class="hint">No mandates found for ${short(account)} in the last 20,000 blocks.</p>`; return; }
    const cards = [];
    for (const id of ids) {
      const m = await mpRead.getMandate(id);
      const st = Number(await mpRead.statusOf(id));
      const remaining = m.totalCap - m.spent;
      const expires = new Date(Number(m.expiry) * 1000);
      const mine2 = account.toLowerCase();
      const actions = [];
      if (st === 0 && m.owner.toLowerCase() === mine2) actions.push(`<button data-act="revoke" data-id="${id}">Revoke + refund ${fmt(remaining)}</button>`);
      if (st === 1 && m.owner.toLowerCase() === mine2) actions.push(`<button data-act="settle" data-id="${id}">Settle + withdraw ${fmt(remaining)}</button>`);
      cards.push(`<div class="mandate">
        <div class="m-head"><strong>#${id}</strong> <span class="pill p${st}">${STATUS[st]}</span> <span class="purpose">${escapeHtml(m.purpose)}</span></div>
        <div class="m-grid">
          <span>Owner <b class="mono">${short(m.owner)}</b></span>
          <span>Agent <b class="mono">${short(m.agent)}</b></span>
          <span>Payee <b class="mono">${short(m.payee)}</b></span>
          <span>Per-payment cap <b>${fmt(m.perPaymentCap)}</b></span>
          <span>Spent <b>${fmt(m.spent)} / ${fmt(m.totalCap)}</b></span>
          <span>Remaining <b>${fmt(remaining)} tUSD8</b></span>
          <span>Expires <b>${expires.toLocaleString()}</b></span>
        </div>
        <div class="m-actions">${actions.join(" ")}</div>
      </div>`);
    }
    $("mandateList").innerHTML = cards.join("");
    $("mandateList").querySelectorAll("button[data-act]").forEach((b) =>
      b.addEventListener("click", () => closeMandate(b.dataset.act, BigInt(b.dataset.id))));
  }

  async function closeMandate(act, id) {
    try {
      const mp = writer();
      status(act === "revoke" ? "Revoking…" : "Settling…");
      const tx = act === "revoke" ? await mp.revoke(id) : await mp.settleExpired(id);
      await tx.wait();
      status(`✅ Mandate #${id} ${act === "revoke" ? "revoked — unspent escrow refunded" : "settled — remainder withdrawn"}.`, tx.hash);
      await refreshWallet(); await loadMandates(); await loadActivity();
    } catch (e) { fail(e, mpRead && mpRead.interface); }
  }

  async function loadActivity() {
    if (!mpRead) return;
    const head = await readProvider.getBlockNumber();
    const from = Math.max(CFG.deployBlock || 0, head - 5000);
    const names = {
      [ethers.id("MandateCreated(uint256,address,address,address,uint256,uint256,uint64,string)")]: "Created",
      [ethers.id("PaymentExecuted(uint256,address,address,uint256,uint256,bytes32)")]: "Payment",
      [ethers.id("MandateRevoked(uint256,address,address,uint256)")]: "Revoked",
      [ethers.id("MandateSettled(uint256,address,address,uint256)")]: "Settled",
    };
    const logs = await getLogsChunked({ address: CONTRACT }, from, head);
    const rows = logs.slice(-30).reverse().map((l) => {
      const ev = mpRead.interface.parseLog(l);
      const a = ev.args;
      let detail = "";
      if (ev.name === "MandateCreated") detail = `mandate #${a.mandateId} · budget ${fmt(a.totalCap)} tUSD8 · "${escapeHtml(a.purpose)}"`;
      if (ev.name === "PaymentExecuted") detail = `mandate #${a.mandateId} · ${fmt(a.amount)} tUSD8 → ${short(a.payee)}`;
      if (ev.name === "MandateRevoked") detail = `mandate #${a.mandateId} · refunded ${fmt(a.refunded)} tUSD8`;
      if (ev.name === "MandateSettled") detail = `mandate #${a.mandateId} · withdrew ${fmt(a.refunded)} tUSD8`;
      return `<div class="act"><span class="pill">${ev.name.replace("Mandate", "")}</span> ${detail}
        <a href="${txUrl(l.transactionHash)}" target="_blank" rel="noopener">tx</a></div>`;
    });
    $("activity").innerHTML = rows.length ? rows.join("") : `<p class="hint">No events in the last 5,000 blocks yet.</p>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  if (!CONTRACT) $("noContract").classList.remove("hidden");
  $("wContract").textContent = CONTRACT || "not configured";
  $("connectBtn").addEventListener("click", connect);
  $("createBtn").addEventListener("click", create);
  $("checkBtn").addEventListener("click", checkPay);
  $("payBtn").addEventListener("click", pay);
  $("refreshBtn").addEventListener("click", async () => { await loadMandates(); await loadActivity(); });
  if (window.ethereum) window.ethereum.on("accountsChanged", () => location.reload());
  loadActivity().catch(() => {});
})();
