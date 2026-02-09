import axios from "axios";
import { config } from "../config";
import { TokenInfo, DevHistory } from "../types";
import { createLogger } from "../utils/logger";
import { shortenAddress } from "../utils/solana";
import { simulateSell } from "../utils/jupiter";

const log = createLogger("TokenAnalyzer");

export class TokenAnalyzer {
  private tokenCache: Map<string, { info: TokenInfo; timestamp: number }> = new Map();
  private cacheTtlMs = 5 * 60 * 1000;

  private static readonly SOL_MINT = "So11111111111111111111111111111111111111112";
  private static readonly USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  async analyzeToken(tokenMint: string): Promise<TokenInfo | null> {
    if (tokenMint === TokenAnalyzer.SOL_MINT || tokenMint === TokenAnalyzer.USDC_MINT) {
      return null;
    }

    const cached = this.tokenCache.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.info;
    }

    log.info(`Analyzing token: ${shortenAddress(tokenMint)}`);

    try {
      const tokenInfo = await this.fetchTokenData(tokenMint);
      if (!tokenInfo) return null;

      const honeypotCheck = await this.checkHoneypot(tokenMint, tokenInfo);
      tokenInfo.isHoneypot = honeypotCheck;

      this.tokenCache.set(tokenMint, { info: tokenInfo, timestamp: Date.now() });
      return tokenInfo;
    } catch (err) {
      log.error(`Token analysis failed for ${shortenAddress(tokenMint)}: ${err}`);
      return null;
    }
  }

  private async fetchTokenData(tokenMint: string): Promise<TokenInfo | null> {
    try {
      const response = await axios.post(
        config.codex.apiUrl,
        {
          query: `{
            token(input: { address: "${tokenMint}", networkId: 1399811149 }) {
              info {
                name
                symbol
              }
              holders
              marketCap
            }
            filterPairs(
              filters: { tokenAddress: "${tokenMint}", network: [1399811149] }
              limit: 1
            ) {
              results {
                liquidity
                priceUSD
                pair { address }
                uniqueBuyers24
                uniqueSellers24
                volumeUSD24
              }
            }
          }`,
        },
        {
          headers: {
            Authorization: config.codex.apiKey,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );

      const tokenData = response.data?.data?.token;
      const pairData = response.data?.data?.filterPairs?.results?.[0];

      const holders = tokenData?.holders || 0;
      const marketCap = tokenData?.marketCap || 0;
      const priceUsd = pairData?.priceUSD || 0;
      const uniqueBuyers = pairData?.uniqueBuyers24 || 0;
      const uniqueSellers = pairData?.uniqueSellers24 || 1;
      const volumeUsd = pairData?.volumeUSD24 || 0;

      const tokenInfo: TokenInfo = {
        mint: tokenMint,
        symbol: tokenData?.info?.symbol || "UNKNOWN",
        name: tokenData?.info?.name || "Unknown Token",
        decimals: 9,
        lpBurned: false,
        mintDisabled: false,
        buyTax: 0,
        sellTax: 0,
        topHoldersPct: 0,
        liquidity: pairData?.liquidity || 0,
        age: 0,
        isHoneypot: false,
        devAddress: "",
        devHistory: {
          address: "",
          previousTokens: [],
          hasRugPull: false,
          hasSuccessfulProject: false,
          bestMultiplier: 0,
        },
        uniqueBuyers1h: uniqueBuyers,
        buyToSellRatio: uniqueSellers > 0 ? uniqueBuyers / uniqueSellers : 0,
        volumeUsd1h: volumeUsd,
        holderCount: holders,
        marketCapUsd: marketCap,
        priceUsd: priceUsd,
      };

      if (holders > 0) {
        log.info(`Token ${tokenInfo.symbol}: ${holders} holders, $${marketCap.toFixed(0)} mcap, $${(pairData?.liquidity || 0).toFixed(0)} liq`);
      }

      return tokenInfo;
    } catch (err) {
      log.warn(`Codex token fetch failed for ${shortenAddress(tokenMint)}: ${err}`);
      return this.fetchFallbackTokenData(tokenMint);
    }
  }

  private async fetchFallbackTokenData(tokenMint: string): Promise<TokenInfo> {
    const base: TokenInfo = {
      mint: tokenMint,
      symbol: "UNKNOWN",
      name: "Unknown Token",
      decimals: 9,
      lpBurned: false,
      mintDisabled: false,
      buyTax: 0,
      sellTax: 0,
      topHoldersPct: 0,
      liquidity: 0,
      age: 0,
      isHoneypot: false,
      devAddress: "",
      devHistory: {
        address: "",
        previousTokens: [],
        hasRugPull: false,
        hasSuccessfulProject: false,
        bestMultiplier: 0,
      },
      uniqueBuyers1h: 0,
      buyToSellRatio: 0,
      volumeUsd1h: 0,
      holderCount: 0,
      marketCapUsd: 0,
      priceUsd: 0,
    };

    if (tokenMint.endsWith("pump")) {
      try {
        const resp = await axios.get(
          `https://frontend-api-v2.pump.fun/coins/${tokenMint}`,
          { timeout: 5000 }
        );
        const d = resp.data;
        if (d) {
          base.symbol = d.symbol || base.symbol;
          base.name = d.name || base.name;
          base.marketCapUsd = Number(d.usd_market_cap) || 0;
          base.devAddress = d.creator || "";
          if (d.virtual_sol_reserves && d.virtual_token_reserves) {
            const solRes = Number(d.virtual_sol_reserves) / 1e9;
            base.liquidity = solRes * 2 * 200;
          }
          if (d.reply_count !== undefined) {
            base.uniqueBuyers1h = Math.max(base.uniqueBuyers1h, Number(d.reply_count) || 0);
          }
          log.info(`pump.fun data: ${base.symbol} | MCap: $${base.marketCapUsd.toFixed(0)} | Liq: $${base.liquidity.toFixed(0)}`);
        }
      } catch {
        log.warn(`pump.fun API failed for ${shortenAddress(tokenMint)}`);
      }
    }

    try {
      const resp = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
        { timeout: 8000 }
      );
      const pairs = resp.data?.pairs;
      if (pairs && pairs.length > 0) {
        const pair = pairs[0];
        if (pair.baseToken) {
          base.symbol = pair.baseToken.symbol || base.symbol;
          base.name = pair.baseToken.name || base.name;
        }
        base.liquidity = Math.max(base.liquidity, pair.liquidity?.usd || 0);
        base.marketCapUsd = Math.max(base.marketCapUsd, pair.marketCap || pair.fdv || 0);
        base.priceUsd = parseFloat(pair.priceUsd || "0") || base.priceUsd;
        base.volumeUsd1h = Math.max(base.volumeUsd1h, pair.volume?.h1 || 0);
        const txns = pair.txns;
        if (txns?.h1) {
          base.uniqueBuyers1h = Math.max(base.uniqueBuyers1h, txns.h1.buys || 0);
          const sells1h = txns.h1.sells || 1;
          base.buyToSellRatio = sells1h > 0 ? (txns.h1.buys || 0) / sells1h : 0;
        }
        log.info(`DexScreener data: ${base.symbol} | MCap: $${base.marketCapUsd.toFixed(0)} | Liq: $${base.liquidity.toFixed(0)} | Vol1h: $${base.volumeUsd1h.toFixed(0)}`);
      }
    } catch {
      log.warn(`DexScreener failed for ${shortenAddress(tokenMint)}`);
    }

    return base;
  }

  private async checkHoneypot(tokenMint: string, tokenInfo?: TokenInfo): Promise<boolean> {
    try {
      const result = await simulateSell(tokenMint, 1000000);
      if (result.canSell) {
        if (result.priceImpact > 50) {
          log.warn(`Token ${shortenAddress(tokenMint)} has extreme sell impact: ${result.priceImpact}%`);
          return true;
        }
        return false;
      }
    } catch {}

    const isPumpFun = tokenMint.endsWith("pump");

    if (isPumpFun) {
      log.info(`Token ${shortenAddress(tokenMint)} is pump.fun — allowing (bonding curve sellable)`);
      return false;
    }

    if (tokenInfo) {
      const hasLiquidity = tokenInfo.liquidity > 500;
      const hasBuyers = tokenInfo.uniqueBuyers1h > 3;
      const hasHolders = tokenInfo.holderCount > 10;

      if (hasLiquidity && (hasBuyers || hasHolders)) {
        log.info(`Token ${shortenAddress(tokenMint)} has liquidity + activity — allowing despite no Jupiter route`);
        return false;
      }

      const codexFailed = tokenInfo.liquidity === 0 && tokenInfo.holderCount === 0 && tokenInfo.uniqueBuyers1h === 0;
      if (codexFailed) {
        log.info(`Token ${shortenAddress(tokenMint)} — no API data available, allowing (scoring will handle risk)`);
        return false;
      }
    }

    log.warn(`Token ${shortenAddress(tokenMint)} is a honeypot (cannot sell, has data but no activity)`);
    return true;
  }

  getTokenSafetyScore(tokenInfo: TokenInfo): number {
    let score = 50;

    if (tokenInfo.isHoneypot) return 0;

    if (tokenInfo.liquidity >= 50000) score += 15;
    else if (tokenInfo.liquidity >= 20000) score += 10;
    else if (tokenInfo.liquidity >= 5000) score += 5;
    else score -= 20;

    if (tokenInfo.lpBurned) score += 10;
    if (tokenInfo.mintDisabled) score += 10;

    if (tokenInfo.buyTax > 10 || tokenInfo.sellTax > 10) score -= 30;
    else if (tokenInfo.buyTax > 5 || tokenInfo.sellTax > 5) score -= 15;

    if (tokenInfo.topHoldersPct > 50) score -= 25;
    else if (tokenInfo.topHoldersPct > 30) score -= 10;

    if (tokenInfo.devHistory.hasRugPull) score -= 30;
    if (tokenInfo.devHistory.hasSuccessfulProject) score += 15;

    if (tokenInfo.uniqueBuyers1h > 100) score += 10;
    else if (tokenInfo.uniqueBuyers1h > 50) score += 5;

    if (tokenInfo.buyToSellRatio > 2) score += 10;
    else if (tokenInfo.buyToSellRatio > 1.5) score += 5;
    else if (tokenInfo.buyToSellRatio < 0.5) score -= 15;

    return Math.max(0, Math.min(100, score));
  }

  shouldSkipToken(tokenInfo: TokenInfo): { skip: boolean; reason: string } {
    if (tokenInfo.isHoneypot) return { skip: true, reason: "Honeypot detected" };

    const isPumpFun = tokenInfo.mint.endsWith("pump");
    if (!isPumpFun && tokenInfo.liquidity < 1000) {
      return { skip: true, reason: `Liquidity too low: $${tokenInfo.liquidity}` };
    }

    if (tokenInfo.buyTax > 15) return { skip: true, reason: `Buy tax too high: ${tokenInfo.buyTax}%` };
    if (tokenInfo.sellTax > 15) return { skip: true, reason: `Sell tax too high: ${tokenInfo.sellTax}%` };
    if (tokenInfo.topHoldersPct > 70) return { skip: true, reason: "Top holders own >70%" };
    if (tokenInfo.devHistory.hasRugPull) return { skip: true, reason: "Dev has rug pull history" };
    if (tokenInfo.holderCount > 5000) return { skip: true, reason: `Too many holders (${tokenInfo.holderCount}) — move already happened` };

    return { skip: false, reason: "" };
  }

  clearCache(): void {
    const now = Date.now();
    for (const [mint, cached] of this.tokenCache) {
      if (now - cached.timestamp > this.cacheTtlMs * 2) {
        this.tokenCache.delete(mint);
      }
    }
  }
}
