import dotenv from "dotenv";
import { ExitStrategy, TradeConfidence } from "./types";

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  helius: {
    rpcUrl: requireEnv("HELIUS_RPC_URL"),
    wsUrl: optionalEnv(
      "HELIUS_WS_URL",
      requireEnv("HELIUS_RPC_URL").replace("https://", "wss://")
    ),
    apiUrl: optionalEnv(
      "HELIUS_API_URL",
      "https://api-mainnet.helius-rpc.com/v0"
    ),
    apiKey: requireEnv("HELIUS_API_KEY"),
  },

  codex: {
    apiKey: requireEnv("CODEX_API_KEY"),
    apiUrl: "https://graph.codex.io/graphql",
  },

  twitter: {
    apiKey: requireEnv("TWITTER_API_KEY"),
    apiUrl: "https://api.twitterapi.io/twitter",
  },

  telegram: {
    botToken: optionalEnv("TELEGRAM_BOT_TOKEN", ""),
    chatId: optionalEnv("TELEGRAM_CHAT_ID", ""),
  },

  wallet: {
    privateKey: optionalEnv("WALLET_PRIVATE_KEY", ""),
  },

  paperTrading: {
    enabled: optionalEnv("PAPER_TRADING", "false") === "true",
    fakeBalanceSol: parseFloat(optionalEnv("PAPER_BALANCE_SOL", "1.14")),
  },

  trading: {
    bankSizeSol: parseFloat(optionalEnv("BANK_SIZE_SOL", "1.14")),
    maxPositionPct: parseFloat(optionalEnv("MAX_POSITION_PCT", "5")),
    fixedPositionSol: parseFloat(optionalEnv("FIXED_POSITION_SOL", "0.1")),
    maxOpenPositions: parseInt(optionalEnv("MAX_OPEN_POSITIONS", "10")),
    dailyLossLimitPct: parseFloat(optionalEnv("DAILY_LOSS_LIMIT_PCT", "20")),
    minRocketScore: parseInt(optionalEnv("MIN_ROCKET_SCORE", "20")),
    minWalletTradeSol: parseFloat(optionalEnv("MIN_WALLET_TRADE_SOL", "0.02")),
    slippageBps: parseInt(optionalEnv("SLIPPAGE_BPS", "300")),
    priorityFeeLamports: parseInt(
      optionalEnv("PRIORITY_FEE_LAMPORTS", "100000")
    ),
  },

  crawler: {
    scanIntervalMs: 60_000,
    minTradesForScoring: 3,
    minWinRate: 0.4,
    topWalletsCount: 50,
    walletRefreshIntervalMs: 24 * 60 * 60 * 1000,
    blacklistCheckIntervalMs: 6 * 60 * 60 * 1000,
  },

  scoring: {
    weights: {
      winRate: 0.25,
      avgRoi: 0.2,
      activity: 0.1,
      maxDrawdown: 0.15,
      entrySpeed: 0.15,
      consistency: 0.15,
    },
    tierThresholds: {
      S: 70,
      A: 50,
      B: 30,
      C: 15,
    },
  },
};

export function getExitStrategy(confidence: TradeConfidence): ExitStrategy {
  switch (confidence) {
    case TradeConfidence.ROCKET:
      return {
        profitLadder: [
          {
            triggerPct: 100,
            sellPct: 25,
            description: "2x - take 25%",
          },
          { triggerPct: 300, sellPct: 25, description: "4x - take 25%" },
          { triggerPct: 500, sellPct: 25, description: "6x - take 25%" },
        ],
        stopLoss: [
          { triggerPct: -20, sellPct: 50, description: "Partial stop loss" },
          { triggerPct: -35, sellPct: 100, description: "Full stop loss" },
        ],
        trailingStops: [
          { activateAtPct: 500, stopPct: 20 },
          { activateAtPct: 1000, stopPct: 15 },
        ],
        maxHoldTime: 24 * 60 * 60 * 1000,
        flatlineTimeout: 4 * 60 * 60 * 1000,
        minLiquidity: 2000,
      };

    case TradeConfidence.STRONG:
      return {
        profitLadder: [
          { triggerPct: 50, sellPct: 30, description: "1.5x - take 30%" },
          { triggerPct: 150, sellPct: 30, description: "2.5x - take 30%" },
          { triggerPct: 400, sellPct: 100, description: "5x - full exit" },
        ],
        stopLoss: [
          { triggerPct: -15, sellPct: 50, description: "Partial stop loss" },
          { triggerPct: -30, sellPct: 100, description: "Full stop loss" },
        ],
        trailingStops: [{ activateAtPct: 200, stopPct: 25 }],
        maxHoldTime: 12 * 60 * 60 * 1000,
        flatlineTimeout: 3 * 60 * 60 * 1000,
        minLiquidity: 2000,
      };

    case TradeConfidence.NORMAL:
      return {
        profitLadder: [
          { triggerPct: 30, sellPct: 40, description: "1.3x - take 40%" },
          { triggerPct: 80, sellPct: 30, description: "1.8x - take 30%" },
          { triggerPct: 200, sellPct: 100, description: "3x - full exit" },
        ],
        stopLoss: [
          { triggerPct: -15, sellPct: 50, description: "Partial stop loss" },
          { triggerPct: -25, sellPct: 100, description: "Full stop loss" },
        ],
        trailingStops: [{ activateAtPct: 100, stopPct: 25 }],
        maxHoldTime: 6 * 60 * 60 * 1000,
        flatlineTimeout: 2 * 60 * 60 * 1000,
        minLiquidity: 5000,
      };

    default:
      return {
        profitLadder: [
          { triggerPct: 20, sellPct: 50, description: "Lock half profit" },
          { triggerPct: 50, sellPct: 30, description: "Take more profit" },
          { triggerPct: 150, sellPct: 100, description: "Moon exit" },
        ],
        stopLoss: [
          { triggerPct: -10, sellPct: 50, description: "Partial stop loss" },
          { triggerPct: -20, sellPct: 100, description: "Full stop loss" },
        ],
        trailingStops: [{ activateAtPct: 40, stopPct: 20 }],
        maxHoldTime: 4 * 60 * 60 * 1000,
        flatlineTimeout: 2 * 60 * 60 * 1000,
        minLiquidity: 5000,
      };
  }
}

export function getPositionSizePct(
  rocketScore: number,
  confidence: TradeConfidence
): number {
  const maxPct = config.trading.maxPositionPct;

  switch (confidence) {
    case TradeConfidence.ROCKET:
      return Math.min(maxPct, 10 + (rocketScore - 70) * 0.3);
    case TradeConfidence.STRONG:
      return Math.min(maxPct * 0.8, 7 + (rocketScore - 50) * 0.2);
    case TradeConfidence.NORMAL:
      return Math.min(maxPct * 0.5, 4 + (rocketScore - 30) * 0.15);
    case TradeConfidence.WEAK:
      return Math.min(maxPct * 0.3, 2);
    default:
      return 1;
  }
}

export function getFixedPositionSol(
  confidence: TradeConfidence
): number {
  const base = config.trading.fixedPositionSol;
  switch (confidence) {
    case TradeConfidence.ROCKET:
      return base * 2;
    case TradeConfidence.STRONG:
      return base * 1.5;
    case TradeConfidence.NORMAL:
      return base;
    case TradeConfidence.WEAK:
      return base * 0.5;
    default:
      return base * 0.3;
  }
}
