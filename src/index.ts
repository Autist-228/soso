import { WalletCrawler } from "./crawler/walletCrawler";
import { DevTracker } from "./crawler/devTracker";
import { RealtimeMonitor } from "./monitor/realtimeMonitor";
import { TwitterMonitor } from "./monitor/twitterMonitor";
import { TokenAnalyzer } from "./analyzer/tokenAnalyzer";
import { RocketDetector } from "./scoring/rocketScore";
import { TradeFilter } from "./trading/tradeFilter";
import { TradeExecutor } from "./trading/tradeExecutor";
import { PositionManager } from "./trading/positionManager";
import { RiskManager } from "./trading/riskManager";
import { TelegramNotifier } from "./notifications/telegramBot";
import { Analytics } from "./analytics/analytics";
import { config, getFixedPositionSol } from "./config";
import { createLogger } from "./utils/logger";
import { getTokenPrice } from "./utils/jupiter";
import { WalletTrade, TrackedWallet, WalletTier, RocketSignal, TradeConfidence } from "./types";

const log = createLogger("Main");

class SmartCopyTradeBot {
  private crawler: WalletCrawler;
  private devTracker: DevTracker;
  private monitor: RealtimeMonitor;
  private twitter: TwitterMonitor;
  private tokenAnalyzer: TokenAnalyzer;
  private rocketDetector: RocketDetector;
  private tradeFilter: TradeFilter;
  private tradeExecutor: TradeExecutor;
  private positionManager: PositionManager;
  private riskManager: RiskManager;
  private telegram: TelegramNotifier;
  private analytics: Analytics;
  private isRunning = false;
  private lastTradeTimestamp = 0;
  private tradesThisMinute = 0;
  private minuteResetTimer: ReturnType<typeof setInterval> | null = null;
  private pendingSignals: Map<string, {
    signal: RocketSignal;
    positionSol: number;
    initialPrice: number;
    triggerWallet: TrackedWallet;
    tradeSol: number;
    queuedAt: number;
  }> = new Map();
  private confirmationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor() {
    this.crawler = new WalletCrawler();
    this.devTracker = new DevTracker();
    this.monitor = new RealtimeMonitor();
    this.twitter = new TwitterMonitor();
    this.tokenAnalyzer = new TokenAnalyzer();
    this.rocketDetector = new RocketDetector();
    this.tradeFilter = new TradeFilter(
      this.tokenAnalyzer,
      this.rocketDetector,
      this.devTracker
    );
    this.tradeExecutor = new TradeExecutor();
    this.positionManager = new PositionManager();
    this.riskManager = new RiskManager();
    this.telegram = new TelegramNotifier();
    this.analytics = new Analytics();
  }

  async start(): Promise<void> {
    log.info("=== SMART COPY-TRADE BOT STARTING ===");
    log.info(`Bank: ${config.trading.bankSizeSol} SOL`);
    log.info(`Max position: ${config.trading.maxPositionPct}%`);
    log.info(`Max open positions: ${config.trading.maxOpenPositions}`);
    log.info(`Min rocket score: ${config.trading.minRocketScore}`);

    this.isRunning = true;

    await this.riskManager.syncBalance();
    this.riskManager.startDailyReset();

    log.info("[1/5] Starting Wallet Crawler...");
    await this.crawler.start();

    log.info("[2/5] Starting Real-Time Monitor...");
    const topWallets = this.crawler.getTopWallets();
    if (topWallets.length > 0) {
      await this.monitor.start(topWallets);
    } else {
      log.warn("No wallets found yet, monitor will start when wallets are discovered");
    }

    log.info("[3/5] Starting Twitter Monitor...");
    await this.twitter.start();

    log.info("[4/5] Starting Position Manager...");
    await this.positionManager.startMonitoring();

    log.info("[5/5] Connecting event handlers...");
    this.connectEventHandlers();

    log.info("=== BOT IS LIVE ===");
    await this.telegram.sendAlert(
      "Bot Started",
      `Bank: ${config.trading.bankSizeSol} SOL\nTracking ${topWallets.length} wallets`
    );

    this.minuteResetTimer = setInterval(() => { this.tradesThisMinute = 0; }, 60_000);
    this.startPeriodicTasks();
  }

  async stop(): Promise<void> {
    log.info("=== SHUTTING DOWN ===");
    this.isRunning = false;

    this.crawler.stop();
    this.monitor.stop();
    this.twitter.stop();
    this.positionManager.stopMonitoring();
    this.riskManager.stopDailyReset();
    if (this.minuteResetTimer) clearInterval(this.minuteResetTimer);

    const report = this.analytics.formatReport();
    log.info(report);
    await this.telegram.sendAlert("Bot Stopped", report);

    log.info("=== SHUTDOWN COMPLETE ===");
  }

  private connectEventHandlers(): void {
    this.monitor.onTrade(async (trade: WalletTrade) => {
      await this.handleWalletTrade(trade);
    });

    this.twitter.onMention((mention, tokenMint) => {
      this.tradeFilter.registerTwitterMention(tokenMint, mention);
    });

    this.positionManager.onTradeLog((tradeLog) => {
      this.riskManager.recordTrade(tradeLog);
      this.analytics.recordTrade(tradeLog);
      this.telegram.sendSellNotification(tradeLog);
    });

    this.positionManager.onFundsRelease((originalAmount, returnedAmount) => {
      this.riskManager.releaseFunds(originalAmount, returnedAmount);
    });
  }

  private async handleWalletTrade(trade: WalletTrade): Promise<void> {
    if (!this.isRunning) return;

    const trackedWallets = this.crawler.getTrackedWallets();
    const triggerWallet = trackedWallets.find((w) => w.address === trade.wallet);
    if (!triggerWallet) return;

    if (trade.type === "sell") {
      const existingPosition = this.positionManager.getPositionByToken(trade.tokenMint);
      if (existingPosition) {
        log.trade(
          `Tracked wallet ${triggerWallet.tier} selling ${trade.tokenMint.slice(0, 8)}... — COPY SELL triggered`
        );
        await this.positionManager.triggerWalletSell(trade.tokenMint, trade.wallet);
      }
      return;
    }

    const isPumpFunToken = trade.tokenMint.endsWith("pump");
    if (triggerWallet.tier !== WalletTier.S && triggerWallet.tier !== WalletTier.A) {
      if (!(isPumpFunToken && triggerWallet.tier === WalletTier.B && trade.amountSol >= 0.05)) {
        return;
      }
    }

    if (trade.amountSol < config.trading.minWalletTradeSol) {
      return;
    }

    const existingPos = this.positionManager.getPositionByToken(trade.tokenMint);
    if (existingPos) {
      log.info(`Signal rejected: Already holding ${existingPos.tokenSymbol}`);
      return;
    }

    if (this.positionManager.getPositionCount() >= config.trading.maxOpenPositions) {
      log.warn("Max open positions reached, skipping signal");
      return;
    }

    const now = Date.now();
    if (now - this.lastTradeTimestamp < 10_000) {
      log.info("Signal rejected: Global trade cooldown (10s)");
      return;
    }
    if (this.tradesThisMinute >= 6) {
      log.info("Signal rejected: Max 6 trades per minute");
      return;
    }

    const filterResult = await this.tradeFilter.evaluateTrade(trade, triggerWallet);

    if (!filterResult.shouldTrade || !filterResult.signal) {
      if (filterResult.rejectReason) {
        log.info(`Signal rejected: ${filterResult.rejectReason}`);
      }
      return;
    }

    const signal = filterResult.signal;

    if (signal.confidence === TradeConfidence.WEAK) {
      log.info(`Signal rejected: WEAK confidence (${signal.rocketScore}) — only NORMAL+ allowed`);
      return;
    }

    const bankState = this.riskManager.getBankState();

    let positionSol = getFixedPositionSol(signal.confidence);

    const multiWalletBuys = this.tradeFilter.getWalletBuyCount(signal.tokenMint);
    if (multiWalletBuys >= 3) {
      positionSol = Math.min(positionSol * 2.0, bankState.availableSol * 0.2);
      log.trade(`MULTI-WALLET BOOST: ${multiWalletBuys} wallets bought ${signal.tokenInfo.symbol}, position x2`);
    } else if (multiWalletBuys >= 2) {
      positionSol = Math.min(positionSol * 1.5, bankState.availableSol * 0.15);
      log.trade(`MULTI-WALLET BOOST: ${multiWalletBuys} wallets bought ${signal.tokenInfo.symbol}, position x1.5`);
    }

    if (positionSol > bankState.availableSol) {
      log.warn(`Position ${positionSol.toFixed(4)} SOL exceeds available ${bankState.availableSol.toFixed(4)} SOL`);
      return;
    }

    const canTrade = this.riskManager.canTrade(positionSol);

    if (!canTrade.allowed) {
      log.warn(`Trade blocked by risk manager: ${canTrade.reason}`);
      return;
    }

    if (this.pendingSignals.has(signal.tokenMint)) {
      log.info(`Signal already pending confirmation: ${signal.tokenInfo.symbol}`);
      return;
    }

    const initialPrice = await getTokenPrice(signal.tokenMint);
    if (initialPrice <= 0) {
      log.warn(`No price for ${signal.tokenInfo.symbol} — skipping confirmation queue`);
      return;
    }

    this.pendingSignals.set(signal.tokenMint, {
      signal,
      positionSol,
      initialPrice,
      triggerWallet,
      tradeSol: trade.amountSol,
      queuedAt: Date.now(),
    });

    const confirmDelay = signal.confidence === TradeConfidence.ROCKET ? 10_000
      : signal.confidence === TradeConfidence.STRONG ? 15_000
      : 20_000;

    log.info(
      `QUEUED for confirmation: ${signal.tokenInfo.symbol} | Price: ${initialPrice.toExponential(3)} | ` +
      `Score: ${signal.rocketScore} | ${signal.confidence} | Checking in ${confirmDelay / 1000}s...`
    );

    const timer = setTimeout(() => this.confirmAndExecute(signal.tokenMint), confirmDelay);
    this.confirmationTimers.set(signal.tokenMint, timer);
  }

  private async confirmAndExecute(tokenMint: string): Promise<void> {
    const pending = this.pendingSignals.get(tokenMint);
    this.pendingSignals.delete(tokenMint);
    this.confirmationTimers.delete(tokenMint);

    if (!pending || !this.isRunning) return;

    const { signal, positionSol, initialPrice, triggerWallet, tradeSol } = pending;

    const currentPrice = await getTokenPrice(tokenMint);
    if (currentPrice <= 0) {
      log.warn(`[CONFIRM] No price for ${signal.tokenInfo.symbol} — REJECT`);
      return;
    }

    const priceChangePct = ((currentPrice - initialPrice) / initialPrice) * 100;
    const elapsedSec = Math.round((Date.now() - pending.queuedAt) / 1000);

    const minChangePct = signal.confidence === TradeConfidence.ROCKET ? -3
      : signal.confidence === TradeConfidence.STRONG ? -3
      : -2;

    if (priceChangePct < -5) {
      log.warn(
        `[CONFIRM] DUMP REJECT ${signal.tokenInfo.symbol}: ${priceChangePct.toFixed(1)}% in ${elapsedSec}s ` +
        `(${initialPrice.toExponential(3)} → ${currentPrice.toExponential(3)})`
      );
      return;
    }

    if (priceChangePct < minChangePct) {
      log.warn(
        `[CONFIRM] REJECT ${signal.tokenInfo.symbol}: ${priceChangePct.toFixed(1)}% in ${elapsedSec}s ` +
        `(${signal.confidence} needs >${minChangePct}%)`
      );
      return;
    }

    log.trade(
      `[CONFIRM] ROCKET CONFIRMED: ${signal.tokenInfo.symbol} | ${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(1)}% in ${elapsedSec}s | ` +
      `${initialPrice.toExponential(3)} → ${currentPrice.toExponential(3)} | ${signal.confidence} | BUYING!`
    );

    const existingPos = this.positionManager.getPositionByToken(tokenMint);
    if (existingPos) {
      log.info(`[CONFIRM] Already holding ${signal.tokenInfo.symbol} — skip`);
      return;
    }

    const bankState = this.riskManager.getBankState();
    if (positionSol > bankState.availableSol) {
      log.warn(`[CONFIRM] Insufficient funds for ${signal.tokenInfo.symbol}`);
      return;
    }

    this.riskManager.lockFunds(positionSol);

    await this.telegram.sendSignal(signal);

    const position = await this.tradeExecutor.executeBuy(signal, positionSol);

    if (position) {
      this.positionManager.addPosition(position);
      this.lastTradeTimestamp = Date.now();
      this.tradesThisMinute++;
      await this.telegram.sendBuyNotification(position);

      log.trade(
        `BOUGHT: ${signal.tokenInfo.symbol} | ${positionSol.toFixed(4)} SOL | Score: ${signal.rocketScore} | ${signal.confidence} | ` +
        `Holders: ${signal.tokenInfo.holderCount} | Wallet: ${triggerWallet.tier} bet ${tradeSol.toFixed(2)} SOL | ` +
        `CONFIRMED ${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(1)}% in ${elapsedSec}s`
      );

      const buyLog = this.tradeExecutor.createTradeLog(
        position,
        "buy",
        position.entryAmountSol,
        "",
        `Score: ${signal.rocketScore} | ${signal.confidence} | Confirmed ${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(1)}%`
      );
      this.analytics.recordTrade(buyLog);
    } else {
      this.riskManager.releaseFunds(positionSol, positionSol);
    }
  }

  private startPeriodicTasks(): void {
    setInterval(() => {
      if (!this.isRunning) return;

      const topWallets = this.crawler.getTopWallets();
      for (const wallet of topWallets) {
        if (!this.monitor.getStatus().subscribedWallets) {
          this.monitor.addWallet(wallet);
        }
      }

      this.tradeFilter.cleanupOldData();
      this.tokenAnalyzer.clearCache();
    }, 5 * 60 * 1000);

    setInterval(async () => {
      if (!this.isRunning) return;

      await this.riskManager.syncBalance();
      const stats = this.riskManager.getStats();
      const bankState = this.riskManager.getBankState();
      const portfolio = this.positionManager.getPortfolioSummary();
      const crawlerStats = this.crawler.getStats();

      log.info(
        `[STATUS] Bank: ${bankState.availableSol.toFixed(4)} SOL | ` +
        `Positions: ${portfolio.openPositions} | ` +
        `PnL: ${bankState.totalPnl >= 0 ? "+" : ""}${bankState.totalPnl.toFixed(4)} SOL | ` +
        `Wallets: ${crawlerStats.walletsTracked} (S:${crawlerStats.tiers.S} A:${crawlerStats.tiers.A} B:${crawlerStats.tiers.B} C:${crawlerStats.tiers.C}) | ` +
        `Win rate: ${(stats.winRate * 100).toFixed(1)}%`
      );
    }, 60 * 1000);

    setInterval(async () => {
      if (!this.isRunning) return;

      const bankState = this.riskManager.getBankState();
      const stats = this.riskManager.getStats();
      await this.telegram.sendDailyReport(bankState, {
        winRate: stats.winRate,
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
      });
    }, 6 * 60 * 60 * 1000);
  }
}

async function main(): Promise<void> {
  const bot = new SmartCopyTradeBot();

  process.on("SIGINT", async () => {
    log.info("Received SIGINT, shutting down...");
    await bot.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    log.info("Received SIGTERM, shutting down...");
    await bot.stop();
    process.exit(0);
  });

  process.on("unhandledRejection", (reason) => {
    log.error(`Unhandled rejection: ${reason}`);
  });

  await bot.start();
}

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
