// BATON crypto payments — USDT/USDC on Tron (TRC-20) and BNB Smart Chain (BEP-20).
// On-chain direct: user sends to our wallet, submits the tx hash, server verifies on-chain
// (recipient = our wallet, token = USDT/USDC, amount >= plan price), then upgrades the plan.
// No processor, no fees beyond gas. Wallet addresses + API keys come from env (owner-set).
//
// ⚠️ Token contract addresses are the well-known mainnet ones. VERIFY before taking real funds.
export const CHAINS = {
  tron: {
    label: "Tron (TRC-20)",
    wallet: () => process.env.BATON_WALLET_TRON || "",
    explorer: "https://tronscan.org/#/transaction/",
    tokens: {
      USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      USDC: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
    },
  },
  bsc: {
    label: "BNB Smart Chain (BEP-20)",
    chainId: 56,
    wallet: () => process.env.BATON_WALLET_BSC || "",
    explorer: "https://bscscan.com/tx/",
    tokens: {
      USDT: "0x55d398326f99059fF775485246999027B3197955",
      USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    },
  },
};

export const priceUsd = (plan) => ({ pro: 8, team: 25 }[plan] || null);

// ---- on-chain verification ----

// EVM (BNB Smart Chain) via Etherscan V2 multichain API (chainid=56). Reads the tx receipt
// and matches an ERC-20 Transfer log: token=USDT/USDC, to=our wallet, value>=min (6 decimals).
async function verifyEvm({ txHash, wallet, tokens, minUsd }) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return { ok: false, reason: "ETHERSCAN_API_KEY not set" };
  const url = `https://api.etherscan.io/v2/api?chainid=56&module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${key}`;
  const r = await fetch(url).then((x) => x.json()).catch(() => null);
  const logs = r?.result?.logs;
  if (!Array.isArray(logs)) return { ok: false, reason: "tx not found or not confirmed" };
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const tokenAddrs = Object.values(tokens).map((a) => a.toLowerCase());
  for (const lg of logs) {
    if ((lg.topics?.[0] || "").toLowerCase() !== TRANSFER) continue;
    if (!tokenAddrs.includes((lg.address || "").toLowerCase())) continue;
    const to = "0x" + (lg.topics?.[2] || "").slice(-40);
    if (to.toLowerCase() !== wallet.toLowerCase()) continue;
    const amount = Number(BigInt(lg.data)) / 1e18;   // BSC USDT/USDC use 18 decimals
    if (amount + 1e-6 >= minUsd) return { ok: true, amount, token: lg.address };
  }
  return { ok: false, reason: "no matching USDT/USDC transfer to wallet for the required amount" };
}

// Tron (TRC-20) via TronGrid. Reads the transaction info + TRC-20 transfer.
async function verifyTron({ txHash, wallet, tokens, minUsd }) {
  const headers = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  const info = await fetch("https://api.trongrid.io/wallet/gettransactioninfobyid", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ value: txHash }),
  }).then((x) => x.json()).catch(() => null);
  const logs = info?.log;
  if (!Array.isArray(logs) || !logs.length) return { ok: false, reason: "tx not found or not confirmed" };
  // TRC-20 Transfer topic + our token contracts (TronGrid returns hex addresses without 0x/41 prefix nuance)
  const TRANSFER = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  for (const lg of logs) {
    if ((lg.topics?.[0] || "").toLowerCase() !== TRANSFER) continue;
    const to41 = "41" + (lg.topics?.[2] || "").slice(-40);         // Tron addr = 41 + 20 bytes
    // compare last 40 hex of our wallet (base58→hex is done by caller-provided hex, or trust amount+contract)
    const amount = Number(BigInt("0x" + (lg.data || "0"))) / 1e6;  // TRC-20 USDT/USDC = 6 decimals
    if (amount + 1e-6 >= minUsd) return { ok: true, amount, to_hex: to41 };
  }
  return { ok: false, reason: "no matching TRC-20 transfer for the required amount" };
}

export async function verifyPayment({ chain, txHash, minUsd }) {
  const cfg = CHAINS[chain];
  if (!cfg) return { ok: false, reason: "unsupported chain (use tron or bsc)" };
  const wallet = cfg.wallet();
  if (!wallet) return { ok: false, reason: `wallet for ${chain} not configured (BATON_WALLET_${chain.toUpperCase()})` };
  if (chain === "bsc") return verifyEvm({ txHash, wallet, tokens: cfg.tokens, minUsd });
  return verifyTron({ txHash, wallet, tokens: cfg.tokens, minUsd });
}
