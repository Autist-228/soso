import {
  OpenPosition,
  PositionStatus,
  PartialSell,
  ExitStrategy,
  TradeLog,
} from "../types";
import { getExitStrategy, config } from "../config";
import { sellToken, getTokenPrice } from "../utils/jupiter";
import { createLogger } from "../utils/logger";
import { shortenAddress } from "../utils/solana";

const log = createLogger("PositionManager");

type TradeLogCallback = (tradeLog: TradeLog) => void;

type FundsReleaseCallback = (originalAmount: number, returnedAmount: number) => void;

export class PositionManager {
  private positions: Map<string, OpenPosition> = new Map();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private onTradeLogCallbacks: TradeLogCallback[] = [];
  private onFundsReleaseCallbacks: FundsReleaseCallback[] = [];
  private priceMomentum: Map<string, number> = new Map();

  onTradeLog(callback: TradeLogCallback): void {
    this.onTradeLogCallbacks.push(callback);
  }

  onFundsRelease(callback: FundsReleaseCallback): void {
    this.onFundsReleaseCallbacks.push(callback);
  }

  addPosition(position: OpenPosition): void {
    this.positions.set(position.id, position);
    log.trade(
      `New position: ${position.tokenSymbol} | ${position.entryAmountSol.toFixed(4)} SOL | Score: ${position.rocketScore}`
    );
  }

  getOpenPositions(): OpenPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status !== PositionStatus.CLOSED
    );
  }

  getPositionCount(): number {
    return this.getOpenPositions().length;
  }

  getPositionByToken(tokenMint: string): OpenPosition | undefined {
    return Array.from(this.positions.values()).find(
      (p) => p.tokenMint === tokenMint && p.status !== PositionStatus.CLOSED
    );
  }

  async startMonitoring(intervalMs: number = 5000): Promise<void> {
    log.info(`Starting position monitoring (interval: ${intervalMs}ms)`);

    this.monitorInterval = setInterval(() => this.checkAllPositions(), intervalMs);
  }

  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    log.info("Position monitoring stopped");
  }

  private async checkAllPositions(): Promise<void> {
    const openPositions = this.getOpenPositions();

    for (const position of openPositions) {
      try {
        await this.checkPosition(position);
      } catch (err) {
        log.error(`Error checking position ${position.tokenSymbol}: ${err}`);
      }
    }
  }

  async triggerWalletSell(tokenMint: string, walletAddress: string): Promise<void> {
    const position = this.getPositionByToken(tokenMint);
    if (!position || position.status === PositionStatus.CLOSED) return;

    log.trade(
      `WALLET SELL COPY: ${position.tokenSymbol} — tracked wallet ${shortenAddress(walletAddress)} sold, we sell too`
    );
    await this.executeSell(position, 100, `Copy wallet sell (${shortenAddress(walletAddress)})`);
    position.status = PositionStatus.CLOSED;
  }

  private async checkPosition(position: OpenPosition): Promise<void> {
    let currentPrice: number;
    if (config.paperTrading.enabled) {
      const realPrice = await getTokenPrice(position.tokenMint);
      if (realPrice > 0) {
        currentPrice = realPrice;
      } else {
        const prevMomentum = this.priceMomentum.get(position.id) || 0;
        const noise = (Math.random() - 0.5) * 0.03;
        const meanRevert = -prevMomentum * 0.3;
        const trend = (Math.random() < 0.55 ? 1 : -1) * 0.005;
        const momentum = prevMomentum * 0.6 + noise + meanRevert + trend;
        this.priceMomentum.set(position.id, momentum);
        currentPrice = position.currentPrice * (1 + momentum);
        if (currentPrice <= 0) currentPrice = position.entryPrice * 0.01;
      }
    } else {
      currentPrice = await getTokenPrice(position.tokenMint);
      if (currentPrice <= 0) return;
    }

    position.currentPrice = currentPrice;
    position.pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    position.pnlSol = position.remainingTokens * currentPrice - position.entryAmountSol + position.totalSoldSol;

    if (currentPrice > position.peakPrice) {
      position.peakPrice = currentPrice;
    }

    const strategy = getExitStrategy(position.confidence);

    await this.checkStopLoss(position, strategy);
    await this.checkProfitLadder(position, strategy);
    await this.checkTrailingStop(position, strategy);
    await this.checkTimeouts(position, strategy);
  }

  private async checkStopLoss(position: OpenPosition, strategy: ExitStrategy): Promise<void> {
    if (position.status === PositionStatus.CLOSED) return;

    const sortedRules = [...strategy.stopLoss].sort((a, b) => a.triggerPct - b.triggerPct);

    for (const rule of sortedRules) {
      if (position.pnlPct <= rule.triggerPct) {
        const alreadyHit = position.partialSells.some(
          (ps) => ps.reason.toLowerCase().includes("stop loss")
        );

        if (alreadyHit) {
          log.warn(
            `FULL STOP LOSS: ${position.tokenSymbol} still at ${position.pnlPct.toFixed(1)}% after partial stop`
          );
          await this.executeSell(position, 100, `Full stop loss at ${position.pnlPct.toFixed(1)}%`);
          position.status = PositionStatus.CLOSED;
          return;
        }

        log.warn(
          `STOP LOSS triggered: ${position.tokenSymbol} at ${position.pnlPct.toFixed(1)}% (trigger: ${rule.triggerPct}%)`
        );

        await this.executeSell(position, rule.sellPct, `Stop loss at ${rule.triggerPct}%`);

        if (rule.sellPct >= 100 || position.remainingTokens <= 0) {
          position.status = PositionStatus.CLOSED;
        }
        return;
      }
    }
  }

  private async checkProfitLadder(position: OpenPosition, strategy: ExitStrategy): Promise<void> {
    for (const rule of strategy.profitLadder) {
      if (position.pnlPct >= rule.triggerPct) {
        const alreadySold = position.partialSells.some(
          (ps) => ps.reason === rule.description
        );
        if (alreadySold) continue;

        log.trade(
          `PROFIT LADDER: ${position.tokenSymbol} at +${position.pnlPct.toFixed(1)}% | ${rule.description}`
        );

        await this.executeSell(position, rule.sellPct, rule.description);

        if (position.remainingTokens <= 0) {
          position.status = PositionStatus.CLOSED;
        } else {
          position.status = PositionStatus.PARTIAL_EXIT;
        }
      }
    }
  }

  private async checkTrailingStop(position: OpenPosition, strategy: ExitStrategy): Promise<void> {
    for (const tsConfig of strategy.trailingStops) {
      if (position.pnlPct >= tsConfig.activateAtPct && !position.trailingStopActive) {
        position.trailingStopActive = true;
        position.trailingStopPct = tsConfig.stopPct;
        position.status = PositionStatus.TRAILING;

        log.trade(
          `TRAILING STOP activated: ${position.tokenSymbol} at +${position.pnlPct.toFixed(1)}% | Stop: ${tsConfig.stopPct}%`
        );
      }
    }

    if (position.trailingStopActive && position.peakPrice > 0) {
      const dropFromPeak =
        ((position.peakPrice - position.currentPrice) / position.peakPrice) * 100;

      if (dropFromPeak >= position.trailingStopPct) {
        log.trade(
          `TRAILING STOP triggered: ${position.tokenSymbol} | Drop from peak: ${dropFromPeak.toFixed(1)}%`
        );

        await this.executeSell(position, 100, `Trailing stop (${dropFromPeak.toFixed(1)}% from peak)`);
        position.status = PositionStatus.CLOSED;
      }
    }
  }

  private async checkTimeouts(position: OpenPosition, strategy: ExitStrategy): Promise<void> {
    const holdTime = Date.now() - position.entryTimestamp;

    if (holdTime > strategy.maxHoldTime) {
      log.warn(`MAX HOLD TIME reached: ${position.tokenSymbol}`);
      await this.executeSell(position, 100, "Max hold time exceeded");
      position.status = PositionStatus.CLOSED;
      return;
    }

    if (holdTime > strategy.flatlineTimeout && Math.abs(position.pnlPct) < 5) {
      log.warn(`FLATLINE detected: ${position.tokenSymbol} (${position.pnlPct.toFixed(1)}% after ${(holdTime / 60000).toFixed(0)}min)`);
      await this.executeSell(position, 100, "Flatline timeout");
      position.status = PositionStatus.CLOSED;
    }
  }

  private async executeSell(
    position: OpenPosition,
    sellPct: number,
    reason: string
  ): Promise<void> {
    const tokensToSell = Math.floor(position.remainingTokens * (sellPct / 100));
    if (tokensToSell <= 0) {
      if (position.remainingTokens <= 0) position.status = PositionStatus.CLOSED;
      return;
    }
    const estimatedValue = tokensToSell * position.currentPrice;
    if (estimatedValue < 0.0001 && sellPct < 100) {
      log.info(`Dust position ${position.tokenSymbol}, closing fully`);
      position.status = PositionStatus.CLOSED;
      return;
    }

    try {
      let soldSol: number;
      let signature: string;

      if (config.paperTrading.enabled) {
        soldSol = tokensToSell * position.currentPrice;
        signature = `paper_${Date.now()}`;
        log.trade(`[PAPER] SELL: ${position.tokenSymbol} | ${sellPct}% | ${soldSol.toFixed(4)} SOL | ${reason}`);
      } else {
        const result = await sellToken(position.tokenMint, tokensToSell);
        soldSol = result.outputAmount / 1e9;
        signature = result.signature;
      }
      position.remainingTokens -= tokensToSell;
      position.totalSoldSol += soldSol;

      const pnlPct =
        position.entryAmountSol > 0
          ? ((position.totalSoldSol - position.entryAmountSol) / position.entryAmountSol) * 100
          : 0;

      const partialSell: PartialSell = {
        pctSold: sellPct,
        priceSol: position.currentPrice,
        amountSol: soldSol,
        pnlPct,
        timestamp: Date.now(),
        reason,
      };

      position.partialSells.push(partialSell);

      log.trade(
        `SELL: ${position.tokenSymbol} | ${sellPct}% | ${soldSol.toFixed(4)} SOL | PnL: ${pnlPct.toFixed(1)}% | ${reason}`
      );

      const proportionSold = tokensToSell / position.initialTokens;
      const originalCost = position.entryAmountSol * proportionSold;
      const pnlSol = soldSol - originalCost;

      const tradeLog: TradeLog = {
        id: `log_${Date.now()}_${position.tokenMint.slice(0, 8)}`,
        tokenMint: position.tokenMint,
        tokenSymbol: position.tokenSymbol,
        action: sellPct >= 100 || position.remainingTokens <= 0 ? "sell" : "partial_sell",
        amountSol: soldSol,
        price: position.currentPrice,
        pnlPct,
        pnlSol,
        rocketScore: position.rocketScore,
        triggerWallet: position.triggerWallet,
        reason,
        timestamp: Date.now(),
        signature,
      };

      for (const callback of this.onFundsReleaseCallbacks) {
        try {
          callback(originalCost, soldSol);
        } catch (err) {
          log.error(`Funds release callback error: ${err}`);
        }
      }

      for (const callback of this.onTradeLogCallbacks) {
        try {
          callback(tradeLog);
        } catch (err) {
          log.error(`Trade log callback error: ${err}`);
        }
      }
    } catch (err) {
      log.error(`SELL FAILED: ${position.tokenSymbol} | ${reason} | ${err}`);
    }
  }

  async emergencyExitAll(reason: string): Promise<void> {
    log.warn(`EMERGENCY EXIT ALL: ${reason}`);
    const openPositions = this.getOpenPositions();

    for (const position of openPositions) {
      try {
        await this.executeSell(position, 100, `Emergency: ${reason}`);
        position.status = PositionStatus.EMERGENCY_EXIT;
      } catch (err) {
        log.error(`Emergency exit failed for ${position.tokenSymbol}: ${err}`);
      }
    }
  }

  getPortfolioSummary() {
    const positions = this.getOpenPositions();
    const totalInvested = positions.reduce((s, p) => s + p.entryAmountSol, 0);
    const totalPnlSol = positions.reduce((s, p) => s + p.pnlSol, 0);
    const totalPnlPct = totalInvested > 0 ? (totalPnlSol / totalInvested) * 100 : 0;

    return {
      openPositions: positions.length,
      totalInvested,
      totalPnlSol,
      totalPnlPct,
      positions: positions.map((p) => ({
        symbol: p.tokenSymbol,
        pnlPct: p.pnlPct,
        pnlSol: p.pnlSol,
        status: p.status,
        rocketScore: p.rocketScore,
      })),
    };
  }
}
