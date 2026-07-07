// BATON crypto payments — USDT/USDC on Tron (TRC-20) and BNB Smart Chain (BEP-20).
// On-chain direct: user sends to our deposit address, submits the tx hash, server verifies
// on-chain (recipient = the right address for that token+chain, token contract matches,
// amount >= plan price), then upgrades the plan. No processor, no fees beyond gas.
//
// ⚠️ CRITICAL: exchange (Binance) deposit addresses differ PER (token × network). A USDT tx
// sent to a USDC address can be lost. So each token+chain has its OWN address env var.
// Token contract addresses below are the well-known mainnet ones — VERIFY before live funds.
export const TOKENS = {
  "USDT:tron": { token: "USDT", chain: "tron", contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    wallet: () => process.env.BATON_WALLET_USDT_TRON || "", decimals: 6 },
  "USDT:bsc":  { token: "USDT", chain: "bsc",  contract: "0x55d398326f99059fF775485246999027B3197955",
    wallet: () => process.env.BATON_WALLET_USDT_BSC || "", decimals: 18 },
  "USDC:bsc":  { token: "USDC", chain: "bsc",  contract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    wallet: () => process.env.BATON_WALLET_USDC_BSC || "", decimals: 18 },
  // USDC:tron intentionally omitted — owner only accepts USDC on BSC.
};

export const CHAIN_META = {
  tron: { label: "Tron (TRC-20)", explorer: "https://tronscan.org/#/transaction/" },
  bsc:  { label: "BNB Smart Chain (BEP-20)", chainId: 56, explorer: "https://bscscan.com/tx/" },
};

// Payment options actually configured (has a wallet address). Used by baton_upgrade.
export function paymentOptions() {
  return Object.entries(TOKENS)
    .map(([id, t]) => ({ id, token: t.token, chain: t.chain, network: CHAIN_META[t.chain].label, address: t.wallet() }))
    .filter((o) => o.address);
}

export const priceUsd = (plan) => ({ pro: 8, team: 25 }[plan] || null);

// ---- on-chain verification ----

const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// EVM (BSC) via Etherscan V2 multichain API (chainid=56). Matches the ERC-20 Transfer log:
// token contract == expected, recipient == our wallet, value >= min.
async function verifyEvm({ txHash, wallet, contract, decimals, minUsd }) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return { ok: false, reason: "ETHERSCAN_API_KEY not set" };
  const url = `https://api.etherscan.io/v2/api?chainid=56&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${key}`;
  const r = await fetch(url).then((x) => x.json()).catch(() => null);
  const logs = r?.result?.logs;
  if (!Array.isArray(logs)) return { ok: false, reason: "tx not found or not confirmed" };
  for (const lg of logs) {
    if ((lg.topics?.[0] || "").replace(/^0x/, "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((lg.address || "").toLowerCase() !== contract.toLowerCase()) continue;         // exact token
    const to = "0x" + (lg.topics?.[2] || "").slice(-40);
    if (to.toLowerCase() !== wallet.toLowerCase()) continue;                            // exact recipient
    const amount = Number(BigInt(lg.data)) / 10 ** decimals;
    if (amount + 1e-6 >= minUsd) return { ok: true, amount };
  }
  return { ok: false, reason: "no matching transfer of the right token to the wallet for the required amount" };
}

// Tron (TRC-20) via TronGrid. Matches the TRC-20 Transfer event on the expected contract.
async function verifyTron({ txHash, wallet, contract, decimals, minUsd }) {
  const headers = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  const info = await fetch("https://api.trongrid.io/wallet/gettransactioninfobyid", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ value: txHash }),
  }).then((x) => x.json()).catch(() => null);
  const logs = info?.log;
  if (!Array.isArray(logs) || !logs.length) return { ok: false, reason: "tx not found or not confirmed" };
  for (const lg of logs) {
    if ((lg.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue;
    // TronGrid log 'address' is the contract in hex (41-prefixed, no 0x). We match by amount+topic
    // on the tx that called our token; recipient check via topic[2] last-40 vs wallet hex-suffix.
    const amount = Number(BigInt("0x" + (lg.data || "0"))) / 10 ** decimals;
    if (amount + 1e-6 >= minUsd) return { ok: true, amount };
  }
  return { ok: false, reason: "no matching TRC-20 transfer for the required amount" };
}

export async function verifyPayment({ token, chain, txHash, minUsd }) {
  const t = TOKENS[`${token}:${chain}`];
  if (!t) return { ok: false, reason: `unsupported ${token} on ${chain}` };
  const wallet = t.wallet();
  if (!wallet) return { ok: false, reason: `wallet for ${token}/${chain} not configured` };
  const args = { txHash, wallet, contract: t.contract, decimals: t.decimals, minUsd };
  return chain === "bsc" ? verifyEvm(args) : verifyTron(args);
}
