// MandatePay web app configuration.
// After deploying MandatePay to Aevum testnet, put its address in `mandatePay`
// (or open the page with ?contract=0x... to try any deployment).
window.MANDATEPAY_CONFIG = {
  chainId: 44005,
  chainName: "QDay Aevum Testnet",
  rpc: "https://rpc-test.qday.info",
  explorer: "https://explorer-test.qday.info",
  nativeSymbol: "tQDAY",
  tusd8: "0x456569838f1d43009A91ebA4263147Afd7233483",
  tusd8Decimals: 6,
  mandatePay: "", // <-- set to the deployed MandatePay address
  deployBlock: 0, // block the contract was deployed at (speeds up event scans)
};
