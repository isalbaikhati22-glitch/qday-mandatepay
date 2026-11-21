# Third-party notices

MandatePay is original work written for the Aevum Builder Challenge #1.
It builds on the following open-source projects:

- **Aevum Starter Kit** — https://github.com/qday-io/aevum-starter-kit
  MIT License, © 2026 PQA Labs.
  Used as the reference for Aevum network parameters (chain 44005, RPC, tUSD8
  address and domain), platform quirks (Shanghai EVM, legacy transactions,
  1,000-block log limit) and project plumbing conventions. No starter-kit
  contract code is copied into `MandatePay.sol`; the `Checkout` example was
  read for context and is credited here per the kit's own submission guidance.

- **forge-std** — https://github.com/foundry-rs/forge-std (v1.17.0)
  MIT / Apache-2.0. Vendored under `contracts/lib/forge-std/` (test library
  only; not part of the deployed bytecode). Its own license files are kept in
  that directory.

- **ethers.js** — https://github.com/ethers-io/ethers.js (v6)
  MIT License. Used by `scripts/` and the web app (via CDN).

- **Foundry (forge / cast / anvil)** — https://github.com/foundry-rs/foundry
  MIT / Apache-2.0. Build and test tooling.
