import {
  TokenInfo,
  TrackedWallet,
  TwitterMention,
  RocketSignal,
  TradeConfidence,
  WalletTier,
} from "../types";
import { createLogger } from "../utils/logger";
import { getPositionSizePct } from "../config";

const log = createLogger("RocketScore");

interface RocketScoreBreakdown {
  devScore: number;
  smartMoneyScore: number;
  twitterScore: number;
  tokenScore: number;
  onChainScore: number;
  total: number;
}

export class RocketDetector {
  calculateRocketScore(
    tokenInfo: TokenInfo,
    buyingWallets: TrackedWallet[],
    twitterMentions: TwitterMention[],
    tokenSafetyScore: number,
    walletTradeAmountSol: number = 0
  ): RocketScoreBreakdown {
    const devScore = this.calcDevScore(tokenInfo);
    const smartMoneyScore = this.calcSmartMoneyScore(buyingWallets, walletTradeAmountSol);
    const twitterScore = this.calcTwitterScore(twitterMentions);
    const tokenScore = this.calcTokenScore(tokenInfo, tokenSafetyScore);
    const onChainScore = this.calcOnChainScore(tokenInfo);

    const total = Math.min(
      100,
      devScore + smartMoneyScore + twitterScore + tokenScore + onChainScore
    );

    return { devScore, smartMoneyScore, twitterScore, tokenScore, onChainScore, total };
  }

  private calcDevScore(tokenInfo: TokenInfo): number {
    let score = 0;
    const dev = tokenInfo.devHistory;

    if (dev.hasRugPull) return -20;

    if (dev.hasSuccessfulProject) score += 10;

    if (dev.bestMultiplier >= 50) score += 10;
    else if (dev.bestMultiplier >= 10) score += 7;
    else if (dev.bestMultiplier >= 5) score += 4;

    if (dev.previousTokens.length >= 1 && dev.previousTokens.length <= 5) {
      const successRate = dev.previousTokens.filter((t) => !t.wasRug && t.maxMultiplier >= 2).length / dev.previousTokens.length;
      score += Math.floor(successRate * 5);
    }

    return Math.max(-20, Math.min(25, score));
  }

  private calcSmartMoneyScore(buyingWallets: TrackedWallet[], walletTradeAmountSol: number = 0): number {
    if (buyingWallets.length === 0) return 0;

    let score = 0;

    const sTier = buyingWallets.filter((w) => w.tier === WalletTier.S);
    const aTier = buyingWallets.filter((w) => w.tier === WalletTier.A);

    score += sTier.length * 18;
    score += aTier.length * 10;

    if (sTier.length >= 2) score += 10;
    if (aTier.length >= 2) score += 6;
    if (buyingWallets.length >= 3) score += 5;
    if (buyingWallets.length >= 5) score += 5;

    const avgWinRate = buyingWallets.reduce((s, w) => s + w.winRate, 0) / buyingWallets.length;
    if (avgWinRate > 0.7) score += 5;
    else if (avgWinRate > 0.5) score += 3;

    const bestWallet = buyingWallets.reduce((best, w) => w.avgRoi > best.avgRoi ? w : best, buyingWallets[0]);
    if (bestWallet.avgRoi > 200) score += 5;
    else if (bestWallet.avgRoi > 100) score += 3;

    if (walletTradeAmountSol >= 5) score += 8;
    else if (walletTradeAmountSol >= 1) score += 5;
    else if (walletTradeAmountSol >= 0.5) score += 3;
    else if (walletTradeAmountSol >= 0.1) score += 1;

    return Math.min(45, score);
  }

  private calcTwitterScore(mentions: TwitterMention[]): number {
    if (mentions.length === 0) return 0;

    let score = 0;

    const influencers = mentions.filter((m) => m.isInfluencer);
    score += influencers.length * 5;

    const totalFollowers = mentions.reduce((s, m) => s + m.followers, 0);
    if (totalFollowers > 1_000_000) score += 10;
    else if (totalFollowers > 500_000) score += 7;
    else if (totalFollowers > 100_000) score += 3;

    if (mentions.length >= 5) score += 5;
    else if (mentions.length >= 3) score += 3;

    return Math.min(20, score);
  }

  private calcTokenScore(tokenInfo: TokenInfo, safetyScore: number): number {
    let score = 0;

    score += Math.floor(safetyScore * 0.1);

    if (tokenInfo.lpBurned) score += 2;
    if (tokenInfo.mintDisabled) score += 2;
    if (tokenInfo.liquidity > 100000) score += 3;
    else if (tokenInfo.liquidity > 50000) score += 2;
    else if (tokenInfo.liquidity > 10000) score += 1;
    if (!tokenInfo.isHoneypot) score += 2;

    if (tokenInfo.holderCount > 0 && tokenInfo.holderCount <= 200) score += 8;
    else if (tokenInfo.holderCount <= 500) score += 5;
    else if (tokenInfo.holderCount <= 1000) score += 3;
    else if (tokenInfo.holderCount > 3000) score -= 3;

    if (tokenInfo.marketCapUsd > 0 && tokenInfo.marketCapUsd < 100000) score += 5;
    else if (tokenInfo.marketCapUsd < 500000) score += 3;
    else if (tokenInfo.marketCapUsd > 5000000) score -= 3;

    return Math.min(25, score);
  }

  private calcOnChainScore(tokenInfo: TokenInfo): number {
    let score = 0;

    if (tokenInfo.uniqueBuyers1h > 200) score += 5;
    else if (tokenInfo.uniqueBuyers1h > 100) score += 3;

    if (tokenInfo.buyToSellRatio > 3) score += 5;
    else if (tokenInfo.buyToSellRatio > 2) score += 3;

    if (tokenInfo.volumeUsd1h > 100_000) score += 5;
    else if (tokenInfo.volumeUsd1h > 50_000) score += 3;

    return Math.min(10, score);
  }

  scoreToConfidence(score: number): TradeConfidence {
    if (score >= 70) return TradeConfidence.ROCKET;
    if (score >= 50) return TradeConfidence.STRONG;
    if (score >= 30) return TradeConfidence.NORMAL;
    if (score >= 18) return TradeConfidence.WEAK;
    return TradeConfidence.SKIP;
  }

  buildSignal(
    tokenInfo: TokenInfo,
    buyingWallets: TrackedWallet[],
    twitterMentions: TwitterMention[],
    tokenSafetyScore: number,
    walletTradeAmountSol: number = 0
  ): RocketSignal {
    const breakdown = this.calculateRocketScore(
      tokenInfo,
      buyingWallets,
      twitterMentions,
      tokenSafetyScore,
      walletTradeAmountSol
    );

    const confidence = this.scoreToConfidence(breakdown.total);

    const signal: RocketSignal = {
      tokenMint: tokenInfo.mint,
      tokenInfo,
      rocketScore: breakdown.total,
      devScore: breakdown.devScore,
      smartMoneyScore: breakdown.smartMoneyScore,
      twitterScore: breakdown.twitterScore,
      tokenScore: breakdown.tokenScore,
      onChainScore: breakdown.onChainScore,
      buyingWallets,
      twitterMentions,
      confidence,
      suggestedPositionPct: getPositionSizePct(breakdown.total, confidence),
      timestamp: Date.now(),
    };

    log.trade(
      `Signal: ${tokenInfo.symbol} | Score: ${breakdown.total} | ${confidence} | ` +
      `Dev:${breakdown.devScore} SM:${breakdown.smartMoneyScore} TW:${breakdown.twitterScore} ` +
      `Token:${breakdown.tokenScore} Chain:${breakdown.onChainScore} | ` +
      `Position: ${signal.suggestedPositionPct.toFixed(1)}%`
    );

    return signal;
  }
}
