import axios from "axios";
import { VersionedTransaction, Connection } from "@solana/web3.js";
import { config } from "../config";
import { getConnection, getWalletKeypair, getWalletPublicKey } from "./solana";
import { createLogger } from "./logger";

const log = createLogger("Jupiter");

const JUPITER_API = "https://quote-api.jup.ag/v6";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const priceCache = new Map<string, { price: number; ts: number }>();
const PRICE_CACHE_TTL = 5000;
let cachedSolUsd: { price: number; ts: number } | null = null;
const SOL_CACHE_TTL = 30000;

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

interface SwapResult {
  signature: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = config.trading.slippageBps
): Promise<JupiterQuote> {
  const response = await axios.get(`${JUPITER_API}/quote`, {
    params: {
      inputMint,
      outputMint,
      amount: Math.floor(amount).toString(),
      slippageBps,
      onlyDirectRoutes: false,
    },
    timeout: 10000,
  });

  return response.data;
}

export async function executeSwap(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = config.trading.slippageBps
): Promise<SwapResult> {
  const quote = await getQuote(inputMint, outputMint, amount, slippageBps);

  log.info(
    `Quote: ${quote.inAmount} ${inputMint.slice(0, 6)} -> ${quote.outAmount} ${outputMint.slice(0, 6)}, impact: ${quote.priceImpactPct}%`
  );

  const walletPubkey = getWalletPublicKey();

  const swapResponse = await axios.post(
    `${JUPITER_API}/swap`,
    {
      quoteResponse: quote,
      userPublicKey: walletPubkey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: config.trading.priorityFeeLamports,
      dynamicComputeUnitLimit: true,
    },
    { timeout: 15000 }
  );

  const swapTransaction = swapResponse.data.swapTransaction;
  const transactionBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(transactionBuf);

  const keypair = getWalletKeypair();
  tx.sign([keypair]);

  const conn = getConnection();
  const signature = await sendAndConfirmJupiterTx(conn, tx);

  const result: SwapResult = {
    signature,
    inputAmount: parseInt(quote.inAmount),
    outputAmount: parseInt(quote.outAmount),
    priceImpact: parseFloat(quote.priceImpactPct),
  };

  log.trade(`Swap executed: ${signature}`);
  return result;
}

async function sendAndConfirmJupiterTx(
  conn: Connection,
  tx: VersionedTransaction
): Promise<string> {
  const rawTx = tx.serialize();
  const latestBlockhash = await conn.getLatestBlockhash("confirmed");

  let retries = 3;
  while (retries > 0) {
    try {
      const signature = await conn.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 2,
      });

      await conn.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed"
      );

      return signature;
    } catch (err) {
      retries--;
      if (retries === 0) throw err;
      log.warn(`Jupiter tx retry, ${retries} attempts left`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("Jupiter swap failed after retries");
}

export async function buySol(
  tokenMint: string,
  amountSol: number,
  slippageBps?: number
): Promise<SwapResult> {
  const amountLamports = Math.floor(amountSol * 1e9);
  log.trade(`Buying ${tokenMint.slice(0, 8)}... for ${amountSol} SOL`);
  return executeSwap(SOL_MINT, tokenMint, amountLamports, slippageBps);
}

export async function sellToken(
  tokenMint: string,
  tokenAmount: number,
  slippageBps?: number
): Promise<SwapResult> {
  log.trade(`Selling ${tokenAmount} of ${tokenMint.slice(0, 8)}...`);
  return executeSwap(tokenMint, SOL_MINT, tokenAmount, slippageBps);
}

export async function getTokenPrice(tokenMint: string): Promise<number> {
  const c = priceCache.get(tokenMint);
  if (c && Date.now() - c.ts < PRICE_CACHE_TTL) return c.price;

  let price = 0;

  price = await jupiterPrice(tokenMint);
  if (price > 0) { priceCache.set(tokenMint, { price, ts: Date.now() }); return price; }

  price = await dexScreenerPrice(tokenMint);
  if (price > 0) { priceCache.set(tokenMint, { price, ts: Date.now() }); return price; }

  if (tokenMint.endsWith("pump")) {
    price = await pumpFunPrice(tokenMint);
    if (price > 0) { priceCache.set(tokenMint, { price, ts: Date.now() }); return price; }
  }

  price = await codexPrice(tokenMint);
  if (price > 0) { priceCache.set(tokenMint, { price, ts: Date.now() }); return price; }

  return 0;
}

async function jupiterPrice(tokenMint: string): Promise<number> {
  try {
    const resp = await axios.get(
      `https://api.jup.ag/price/v2?ids=${tokenMint}`,
      { timeout: 5000 }
    );
    const raw = resp.data?.data?.[tokenMint]?.price;
    if (raw && parseFloat(String(raw)) > 0) {
      const solUsd = await getSolPrice();
      return solUsd > 0 ? parseFloat(String(raw)) / solUsd : 0;
    }
  } catch {}
  return 0;
}

async function dexScreenerPrice(tokenMint: string): Promise<number> {
  try {
    const resp = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { timeout: 8000 }
    );
    const pairs = resp.data?.pairs;
    if (pairs && pairs.length > 0) {
      const solPair = pairs.find(
        (p: Record<string, unknown>) => {
          const qt = p.quoteToken as Record<string, unknown> | undefined;
          return qt && (qt.symbol === "SOL" || qt.symbol === "WSOL");
        }
      );
      const pair = solPair || pairs[0];
      if (solPair && typeof pair.priceNative === "string" && parseFloat(pair.priceNative) > 0) {
        return parseFloat(pair.priceNative as string);
      }
      if (typeof pair.priceUsd === "string" && parseFloat(pair.priceUsd) > 0) {
        const solUsd = await getSolPrice();
        return solUsd > 0 ? parseFloat(pair.priceUsd as string) / solUsd : 0;
      }
    }
  } catch {}
  return 0;
}

async function pumpFunPrice(tokenMint: string): Promise<number> {
  try {
    const resp = await axios.get(
      `https://frontend-api-v2.pump.fun/coins/${tokenMint}`,
      { timeout: 5000 }
    );
    const d = resp.data;
    if (d?.virtual_sol_reserves && d?.virtual_token_reserves) {
      const solRes = Number(d.virtual_sol_reserves) / 1e9;
      const tokRes = Number(d.virtual_token_reserves) / 1e6;
      if (tokRes > 0) return solRes / tokRes;
    }
    if (d?.usd_market_cap && d?.total_supply) {
      const pUsd = Number(d.usd_market_cap) / (Number(d.total_supply) / 1e6);
      const solUsd = await getSolPrice();
      return solUsd > 0 ? pUsd / solUsd : 0;
    }
  } catch {}
  return 0;
}

async function codexPrice(tokenMint: string): Promise<number> {
  try {
    const codexKey = process.env.CODEX_API_KEY;
    if (!codexKey) return 0;
    const query = `{ filterPairs(filters: { tokenAddress: "${tokenMint}", network: [1399811149] }, limit: 1) { results { priceUSD } } }`;
    const resp = await axios.post(
      "https://graph.codex.io/graphql",
      { query },
      { headers: { Authorization: codexKey }, timeout: 8000 }
    );
    const priceUsd = resp.data?.data?.filterPairs?.results?.[0]?.priceUSD;
    if (priceUsd && parseFloat(priceUsd) > 0) {
      const solUsd = await getSolPrice();
      return solUsd > 0 ? parseFloat(priceUsd) / solUsd : 0;
    }
  } catch {}
  return 0;
}

async function getSolPrice(): Promise<number> {
  if (cachedSolUsd && Date.now() - cachedSolUsd.ts < SOL_CACHE_TTL) {
    return cachedSolUsd.price;
  }
  try {
    const resp = await axios.get(
      "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112",
      { timeout: 5000 }
    );
    const p = parseFloat(resp.data?.data?.["So11111111111111111111111111111111111111112"]?.price || "0");
    if (p > 0) { cachedSolUsd = { price: p, ts: Date.now() }; return p; }
  } catch {}
  try {
    const resp = await axios.get(
      "https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112",
      { timeout: 5000 }
    );
    const p = resp.data?.data?.["So11111111111111111111111111111111111111112"]?.price || 0;
    if (p > 0) { cachedSolUsd = { price: p, ts: Date.now() }; return p; }
  } catch {}
  return cachedSolUsd?.price || 0;
}

export function getPriceSource(tokenMint: string): string {
  const c = priceCache.get(tokenMint);
  return (c && Date.now() - c.ts < PRICE_CACHE_TTL) ? "cached" : "none";
}

export async function simulateSell(
  tokenMint: string,
  amount: number
): Promise<{ canSell: boolean; estimatedOutput: number; priceImpact: number }> {
  try {
    const quote = await getQuote(tokenMint, SOL_MINT, amount, 1000);
    return {
      canSell: true,
      estimatedOutput: parseInt(quote.outAmount) / 1e9,
      priceImpact: parseFloat(quote.priceImpactPct),
    };
  } catch {
    return { canSell: false, estimatedOutput: 0, priceImpact: 100 };
  }
}
