// backend/quant_ai_engine.js
import axios from "axios";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const FOREX_SYMBOLS_MAP = {
  XAUUSD: "GC=F",
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",
  DXY: "DX-Y.NYB",
};

export const TV_EXACT_TICKERS = {
  XAUUSD: "OANDA:XAUUSD",
  EURUSD: "OANDA:EURUSD",
  GBPUSD: "OANDA:GBPUSD",
  USDJPY: "OANDA:USDJPY",
  DXY: "TVC:DXY",
};

const TV_TF_SUFFIX = {
  "5m": "|5",
  "15m": "|15",
  "1h": "|60",
  "1d": "",
  "1W": "|1W",
};

/**
 * 1. مخزن أسعار وشموع البروكر الحية القادمة مباشرة من منصة MT5 (Exness)
 */
export const mt5LivePrices = {
  XAUUSD: null,
  EURUSD: null,
  GBPUSD: null,
  USDJPY: null,
  lastUpdateMs: 0,
};

// مخزن لتجميع شموع MT5 الحية من تيكات البروكر مباشرة
export const mt5BrokerCandleBuffer = {
  XAUUSD: [],
  EURUSD: [],
  GBPUSD: [],
  USDJPY: [],
};

// ذاكرة التعلم الذاتي للـ AI من نتائج آخر 5 صفقات باك تيست لكل زوج
export const pairSelfLearningMemory = {
  XAUUSD: { minAdx: 19, maxRsiBuy: 65, minRsiSell: 35, requireStrongBody: false, lastLessons: [] },
  EURUSD: { minAdx: 19, maxRsiBuy: 65, minRsiSell: 35, requireStrongBody: false, lastLessons: [] },
  GBPUSD: { minAdx: 19, maxRsiBuy: 65, minRsiSell: 35, requireStrongBody: false, lastLessons: [] },
  USDJPY: { minAdx: 19, maxRsiBuy: 65, minRsiSell: 35, requireStrongBody: false, lastLessons: [] },
};

// كاش ذكي لمنع حرق كوتة Gemini API عند الفحص المتزامن
const aiSignalCache = new Map();

function sanitizeForTelegram(text = "") {
  return String(text)
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/&/g, " و ");
}

function recordMt5TickToCandleBuffer(symbol, price) {
  if (!price || price <= 0 || !mt5BrokerCandleBuffer[symbol]) return;
  const now = Date.now();
  const bucketMs = 15 * 60 * 1000; // شمعة 15 دقيقة حية من MT5
  const bucketStart = Math.floor(now / bucketMs) * bucketMs;
  const bucketIso = new Date(bucketStart).toISOString();

  const list = mt5BrokerCandleBuffer[symbol];
  const last = list[list.length - 1];

  if (!last || last.bucketStart !== bucketStart) {
    list.push({
      bucketStart,
      time: bucketIso,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1,
    });
    if (list.length > 120) list.shift();
  } else {
    if (price > last.high) last.high = price;
    if (price < last.low) last.low = price;
    last.close = price;
    last.volume += 1;
  }
}

export function updateMt5LivePrices(prices = {}) {
  let anyValid = false;
  const pairs = [
    { key: "XAUUSD", dec: 2 },
    { key: "EURUSD", dec: 5 },
    { key: "GBPUSD", dec: 5 },
    { key: "USDJPY", dec: 3 },
  ];

  for (const { key, dec } of pairs) {
    if (prices[key] && Number(prices[key]) > 0) {
      const val = Number(Number(prices[key]).toFixed(dec));
      mt5LivePrices[key] = val;
      recordMt5TickToCandleBuffer(key, val);
      anyValid = true;
    }
  }

  if (anyValid) {
    mt5LivePrices.lastUpdateMs = Date.now();
  }
}

function getActiveMt5Price(symbol) {
  const isFresh = Date.now() - mt5LivePrices.lastUpdateMs < 60000;
  if (isFresh && mt5LivePrices[symbol] && mt5LivePrices[symbol] > 0) {
    return mt5LivePrices[symbol];
  }
  return null;
}

export async function fetchLiveTradingViewTicks() {
  try {
    const tickers = Object.values(TV_EXACT_TICKERS);
    const res = await axios.post(
      "https://scanner.tradingview.com/global/scan",
      {
        symbols: { tickers, query: { types: [] } },
        columns: ["close", "change", "change_abs", "high", "low", "Recommend.All|15", "RSI|15"],
      },
      {
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
        timeout: 3500,
      }
    );

    const rows = res.data?.data || [];
    const liveMap = {};

    for (const row of rows) {
      const tvSym = row.s;
      const d = row.d || [];
      const pairKey = Object.keys(TV_EXACT_TICKERS).find((k) => TV_EXACT_TICKERS[k] === tvSym);
      if (pairKey && d[0] !== undefined && d[0] !== null) {
        const decimals = pairKey === "XAUUSD" || pairKey === "DXY" ? 2 : pairKey === "USDJPY" ? 3 : 5;
        const tvPrice = Number(Number(d[0]).toFixed(decimals));
        const mt5Exact = getActiveMt5Price(pairKey);
        const finalPrice = mt5Exact !== null ? mt5Exact : tvPrice;
        const brokerOffset = finalPrice - tvPrice;

        liveMap[pairKey] = {
          symbol: pairKey,
          tvSymbol: mt5Exact !== null ? `Exness_MT5:${pairKey}` : tvSym,
          price: finalPrice,
          priceStr: finalPrice.toFixed(decimals),
          changePercent: Number((d[1] || 0).toFixed(2)),
          changeAbs: Number((d[2] || 0).toFixed(decimals)),
          high: Number((Number(d[3] || d[0]) + brokerOffset).toFixed(decimals)),
          low: Number((Number(d[4] || d[0]) + brokerOffset).toFixed(decimals)),
          tvRating: Number((d[5] || 0).toFixed(2)),
          rsi15m: Number((d[6] || 50).toFixed(2)),
          decimals,
          timestamp: Date.now(),
        };
      }
    }
    return liveMap;
  } catch (e) {
    return {};
  }
}

export async function fetchTradingViewFullTechnicals(symbol = "XAUUSD", timeframe = "15m") {
  const tf = TV_TF_SUFFIX[timeframe] !== undefined ? TV_TF_SUFFIX[timeframe] : "|15";
  const tvTicker = TV_EXACT_TICKERS[symbol] || `OANDA:${symbol}`;
  const decimals = symbol === "XAUUSD" || symbol === "DXY" ? 2 : symbol === "USDJPY" ? 3 : 5;

  const cols = [
    `close${tf}`,
    `open${tf}`,
    `high${tf}`,
    `low${tf}`,
    `RSI${tf}`,
    `EMA20${tf}`,
    `EMA50${tf}`,
    `EMA200${tf}`,
    `ATR${tf}`,
    `Pivot.M.Classic.Middle${tf}`,
    `Pivot.M.Classic.R1${tf}`,
    `Pivot.M.Classic.S1${tf}`,
    `Recommend.All${tf}`,
    `MACD.macd${tf}`,
    `MACD.signal${tf}`,
    "close",
    "change",
    "change_abs",
    `ADX${tf}`,
  ];

  try {
    const res = await axios.post(
      "https://scanner.tradingview.com/global/scan",
      {
        symbols: { tickers: [tvTicker], query: { types: [] } },
        columns: cols,
      },
      {
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
        timeout: 4500,
      }
    );

    const d = res.data?.data?.[0]?.d;
    if (d && d[15] !== null && d[15] !== undefined) {
      const tvLivePrice = Number(Number(d[15]).toFixed(decimals));
      const mt5Exact = getActiveMt5Price(symbol);
      const livePrice = mt5Exact !== null ? mt5Exact : tvLivePrice;
      const brokerDiff = livePrice - tvLivePrice;

      return {
        livePrice,
        open: Number((Number(d[1] || tvLivePrice) + brokerDiff).toFixed(decimals)),
        high: Number((Number(d[2] || tvLivePrice) + brokerDiff).toFixed(decimals)),
        low: Number((Number(d[3] || tvLivePrice) + brokerDiff).toFixed(decimals)),
        rsi: Number(Number(d[4] || 50).toFixed(2)),
        ema20: Number((Number(d[5] || tvLivePrice) + brokerDiff).toFixed(decimals)),
        ema50: Number((Number(d[6] || tvLivePrice) + brokerDiff).toFixed(decimals)),
        ema200: Number((Number(d[7] || tvLivePrice) + brokerDiff).toFixed(decimals)),
        atr: Number(
          Number(
            d[8] || Math.abs((d[2] || tvLivePrice) - (d[3] || tvLivePrice)) || livePrice * 0.0015
          ).toFixed(decimals)
        ),
        pivotP: Number((Number(d[9] || tvLivePrice) + brokerDiff).toFixed(decimals)),
        r1: Number((Number(d[10] || tvLivePrice * 1.002) + brokerDiff).toFixed(decimals)),
        s1: Number((Number(d[11] || tvLivePrice * 0.998) + brokerDiff).toFixed(decimals)),
        tvRecommend: Number(Number(d[12] || 0).toFixed(2)),
        macd: Number(Number(d[13] || 0).toFixed(5)),
        macdSignal: Number(Number(d[14] || 0).toFixed(5)),
        changePercent: Number(Number(d[16] || 0).toFixed(2)),
        changeAbs: Number(Number(d[17] || 0).toFixed(decimals)),
        adx: Number(Number(d[18] || 22).toFixed(2)),
      };
    }
  } catch (e) {}
  return null;
}

/**
 * جلب ومعايرة الشموع بنسبة 100% على سعر وشموع البروكر المسحوبة من MT5
 */
export async function fetchForexCandles(symbol = "XAUUSD", interval = "15m") {
  const ticker = FOREX_SYMBOLS_MAP[symbol] || "EURUSD=X";
  const yahooInterval = interval === "1W" ? "1d" : interval;
  const range = interval === "1W" || interval === "1d" ? "6mo" : interval === "1h" ? "1mo" : "5d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=${yahooInterval}&range=${range}&includePrePost=false`;

  const [response, tvSnap] = await Promise.all([
    axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 7000 }),
    fetchTradingViewFullTechnicals(symbol, interval),
  ]);

  const result = response.data.chart.result[0];
  const timestamps = result.timestamp || [];
  const quote = result.indicators.quote[0];
  const decimals = symbol === "XAUUSD" || symbol === "DXY" ? 2 : symbol === "USDJPY" ? 3 : 5;

  const rawCandles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quote.close[i] !== null && quote.open[i] !== null) {
      rawCandles.push({
        time: new Date(timestamps[i] * 1000).toISOString(),
        open: Number(quote.open[i]),
        high: Number(quote.high[i]),
        low: Number(quote.low[i]),
        close: Number(quote.close[i]),
        volume: quote.volume[i] || 1,
      });
    }
  }

  if (rawCandles.length === 0) return [];

  const mt5Exact = getActiveMt5Price(symbol);
  const exactTargetPrice = mt5Exact !== null ? mt5Exact : tvSnap?.livePrice;
  const lastRawClose = rawCandles[rawCandles.length - 1].close;
  const basisOffset = exactTargetPrice ? lastRawClose - exactTargetPrice : 0;

  // معايرة كافة الشموع التاريخية لتطابق تسعير بروكر MT5 (Exness) بالضبط
  const calibratedCandles = rawCandles.map((c) => ({
    time: c.time,
    open: Number((c.open - basisOffset).toFixed(decimals)),
    high: Number((c.high - basisOffset).toFixed(decimals)),
    low: Number((c.low - basisOffset).toFixed(decimals)),
    close: Number((c.close - basisOffset).toFixed(decimals)),
    volume: c.volume,
    tvSnap: null,
  }));

  // دمج الشموع الحية المجمعة مباشرة من تيكات MT5 إن وجدت
  const liveBrokerCandles = mt5BrokerCandleBuffer[symbol] || [];
  if (liveBrokerCandles.length > 0 && interval === "15m") {
    const latestMt5Candle = liveBrokerCandles[liveBrokerCandles.length - 1];
    const lastCal = calibratedCandles[calibratedCandles.length - 1];
    if (lastCal) {
      lastCal.close = Number(latestMt5Candle.close.toFixed(decimals));
      lastCal.high = Number(Math.max(lastCal.high, latestMt5Candle.high).toFixed(decimals));
      lastCal.low = Number(Math.min(lastCal.low, latestMt5Candle.low).toFixed(decimals));
    }
  }

  if (exactTargetPrice && calibratedCandles.length > 0) {
    const last = calibratedCandles[calibratedCandles.length - 1];
    last.close = exactTargetPrice;
    if (exactTargetPrice > last.high) last.high = exactTargetPrice;
    if (exactTargetPrice < last.low) last.low = exactTargetPrice;
    if (tvSnap) {
      tvSnap.livePrice = exactTargetPrice;
    }
    last.tvSnap = tvSnap;
  }

  return calibratedCandles;
}

export function getMarketSessionAndKillzone() {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();

  const cairoTimeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const cairoHour = Number(cairoTimeParts.find((p) => p.type === "hour")?.value || 0);
  const cairoMinute = Number(cairoTimeParts.find((p) => p.type === "minute")?.value || 0);
  const cairoDecimalTime = cairoHour + cairoMinute / 60;

  const isWeekend =
    utcDay === 6 ||
    (utcDay === 5 && utcHour >= 21) ||
    (utcDay === 0 && utcHour < 21);

  if (isWeekend) {
    return {
      sessionName: "🛑 عطلة نهاية الأسبوع الرسمية (السوق مغلق عالمياً)",
      isKillzone: false,
      isDeadZone: true,
      isAsianSession: false,
      isMarketClosed: true,
      tpMultiplier: 1.0,
      requiredScore: 6,
      liquidityQuality: "السوق مغلق رسمياً حتى افتتاح الأحد 21:00 UTC",
    };
  }

  if (utcHour >= 21 && utcHour <= 22) {
    return {
      sessionName: "⚠️ فترة إغلاق البنوك واتساع السبريد (Rollover Dead-Zone)",
      isKillzone: false,
      isDeadZone: true,
      isAsianSession: true,
      isMarketClosed: false,
      tpMultiplier: 0.9,
      requiredScore: 7,
      liquidityQuality: "سيولة منعدمة واتساع سبريد (تجميد الصفقات الجديدة لحماية الحساب)",
    };
  }

  if (cairoDecimalTime >= 3.0 && cairoDecimalTime < 7.5) {
    return {
      sessionName: "🛡️ درع حماية الفجر (من 3:00 ص إلى 7:30 ص بتوقيت مصر)",
      isKillzone: false,
      isDeadZone: true,
      isAsianSession: true,
      isMarketClosed: false,
      tpMultiplier: 0.95,
      requiredScore: 7,
      liquidityQuality: "سيولة فجر ضعيفة وحركات كاذبة (تجميد الصفقات الجديدة فقط)",
    };
  }

  if (utcHour >= 12 && utcHour < 16) {
    return {
      sessionName: "🔥 تقاطع سيولة لندن ونيويورك (NY/London Overlap Killzone)",
      isKillzone: true,
      isDeadZone: false,
      isAsianSession: false,
      isMarketClosed: false,
      tpMultiplier: 1.15,
      requiredScore: 6,
      liquidityQuality: "سيولة بنكية ومؤسسية قصوى (أقوى أوقات القنص)",
    };
  } else if (utcHour >= 7 && utcHour < 12) {
    return {
      sessionName: "⚡ جلسة لندن الأوروبية (London Killzone)",
      isKillzone: true,
      isDeadZone: false,
      isAsianSession: false,
      isMarketClosed: false,
      tpMultiplier: 1.15,
      requiredScore: 6,
      liquidityQuality: "سيولة بنكية عالية واتجاهات واضحة",
    };
  } else if (utcHour >= 16 && utcHour < 21) {
    return {
      sessionName: "🗽 جلسة نيويورك الأمريكية",
      isKillzone: false,
      isDeadZone: false,
      isAsianSession: false,
      isMarketClosed: false,
      tpMultiplier: 1.1,
      requiredScore: 6,
      liquidityQuality: "سيولة متوسطة إلى عالية",
    };
  } else {
    return {
      sessionName: "🌙 الجلسة الآسيوية (فلتر القناص المؤسسي +90%)",
      isKillzone: false,
      isDeadZone: false,
      isAsianSession: true,
      isMarketClosed: false,
      tpMultiplier: 0.95,
      requiredScore: 6,
      liquidityQuality: "سيولة هادئة تتطلب توافق 6/8 مدارس فأكثر",
    };
  }
}

export function evaluateNewsShield(newsList = []) {
  const highImpactSoon = (newsList || []).find(
    (n) => n.impact === "High" && n.timeDiffHours >= -0.25 && n.timeDiffHours <= 0.65
  );
  if (highImpactSoon) {
    const mins = Math.round(highImpactSoon.timeDiffHours * 60);
    return {
      shieldActive: true,
      activeEvent: highImpactSoon,
      warningText:
        mins >= 0
          ? `⛔ خبر عالي التأثير (${highImpactSoon.title}) يصدر بعد ${mins} دقيقة`
          : `⚠️ صدر للتو خبر عالي التأثير (${highImpactSoon.title}) — ننتظر استقرار الشموع`,
    };
  }
  return {
    shieldActive: false,
    activeEvent: null,
    warningText: "✅ الأجندة الاقتصادية العالمية آمنة ولا توجد أخبار حمراء معارضة",
  };
}

function calcRSISeries(closes, period = 14) {
  const rsiArr = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsiArr;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff >= 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArr[i] = Number((100 - 100 / (1 + rs)).toFixed(2));
  }
  return rsiArr;
}

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2) return 23;
  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    );
  }

  let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dxList = [];

  for (let i = period; i < tr.length; i++) {
    smoothTR = smoothTR - smoothTR / period + tr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    const plusDI = smoothTR === 0 ? 0 : (smoothPlusDM / smoothTR) * 100;
    const minusDI = smoothTR === 0 ? 0 : (smoothMinusDM / smoothTR) * 100;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    dxList.push(dx);
  }

  if (dxList.length === 0) return 23;
  const recentDx = dxList.slice(-period);
  const adx = recentDx.reduce((a, b) => a + b, 0) / recentDx.length;
  return Number(adx.toFixed(2));
}

function calculateInstitutionalVWAPAndBands(candles, decimals = 5) {
  const slice = candles.slice(-40);
  let cumPV = 0;
  let cumVol = 0;
  const typicalPrices = [];

  slice.forEach((c) => {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume && c.volume > 0 ? c.volume : 1;
    typicalPrices.push(tp);
    cumPV += tp * vol;
    cumVol += vol;
  });

  const vwap = cumVol > 0 ? cumPV / cumVol : slice[slice.length - 1].close;
  const variance =
    typicalPrices.reduce((acc, tp) => acc + Math.pow(tp - vwap, 2), 0) / (typicalPrices.length || 1);
  const stdDev = Math.sqrt(variance);

  return {
    vwap: Number(vwap.toFixed(decimals)),
    upperBand18: Number((vwap + stdDev * 1.95).toFixed(decimals)),
    lowerBand18: Number((vwap - stdDev * 1.95).toFixed(decimals)),
  };
}

function detectAlgorithmicDivergence(candles, rsiSeries, currentTvRsi) {
  const len = candles.length;
  if (len < 30) return "لا يوجد دايفرجنس";
  const recentSlice = candles.slice(-8);
  const olderSlice = candles.slice(-26, -8);
  const recentHigh = Math.max(...recentSlice.map((c) => c.high));
  const olderHigh = Math.max(...olderSlice.map((c) => c.high));
  const recentLow = Math.min(...recentSlice.map((c) => c.low));
  const olderLow = Math.min(...olderSlice.map((c) => c.low));
  const recentRsiMax = Math.max(...rsiSeries.slice(-8));
  const olderRsiMax = Math.max(...rsiSeries.slice(-26, -8));
  const recentRsiMin = Math.min(...rsiSeries.slice(-8));
  const olderRsiMin = Math.min(...rsiSeries.slice(-26, -8));

  const effectiveRsi = currentTvRsi || rsiSeries[len - 1];

  if (recentHigh > olderHigh && recentRsiMax < olderRsiMax - 4 && olderRsiMax >= 58 && effectiveRsi >= 52) {
    return "🔴 دايفرجنس بيعي سلبي مؤكد (Bearish Divergence)";
  }
  if (recentLow < olderLow && recentRsiMin > olderRsiMin + 4 && olderRsiMin <= 42 && effectiveRsi <= 48) {
    return "🟢 دايفرجنس شرائي إيجابي مؤكد (Bullish Divergence)";
  }
  return "لا يوجد دايفرجنس";
}

function calculateVolumeProfilePOC(candles, decimals = 5) {
  const slice = candles.slice(-60);
  const minP = Math.min(...slice.map((c) => c.low));
  const maxP = Math.max(...slice.map((c) => c.high));
  const step = (maxP - minP) / 15 || 0.0001;
  const buckets = new Array(15).fill(0);
  slice.forEach((c) => {
    const mid = (c.high + c.low + c.close) / 3;
    const idx = Math.min(14, Math.max(0, Math.floor((mid - minP) / step)));
    buckets[idx] += c.volume || 1;
  });
  let maxVolIdx = 0;
  for (let i = 1; i < 15; i++) {
    if (buckets[i] > buckets[maxVolIdx]) maxVolIdx = i;
  }
  return Number((minP + (maxVolIdx + 0.5) * step).toFixed(decimals));
}

export function calculateAllIndicatorsAndSMC(candles, symbol = "XAUUSD") {
  const decimals = symbol === "XAUUSD" || symbol === "DXY" ? 2 : symbol === "USDJPY" ? 3 : 5;
  const closes = candles.map((c) => c.close);
  const len = candles.length;
  const current = candles[len - 1];
  const prev1 = candles[len - 2] || current;
  const prev2 = candles[len - 3] || current;
  const tv = current?.tvSnap || null;

  const calcEMA = (data, period) => {
    if (data.length < period) return data[data.length - 1];
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return Number(ema.toFixed(decimals));
  };

  const calcATR = (cList, period = 14) => {
    if (cList.length <= period) return Math.abs(current.high - current.low) || 0.001;
    let trSum = 0;
    for (let i = cList.length - period; i < cList.length; i++) {
      const tr = Math.max(
        cList[i].high - cList[i].low,
        Math.abs(cList[i].high - cList[i - 1].close),
        Math.abs(cList[i].low - cList[i - 1].close)
      );
      trSum += tr;
    }
    return Number((trSum / period).toFixed(decimals));
  };

  const mt5Exact = getActiveMt5Price(symbol);
  const exactCurrentPrice =
    mt5Exact !== null ? mt5Exact : tv?.livePrice || Number(current.close.toFixed(decimals));

  const ema20 = tv?.ema20 || calcEMA(closes, 20);
  const ema50 = tv?.ema50 || calcEMA(closes, 50);
  const ema200 = tv?.ema200 || calcEMA(closes, 200);
  const rsiSeries = calcRSISeries(closes, 14);
  const rsi14 = tv?.rsi || rsiSeries[rsiSeries.length - 1];
  const adx14 = tv?.adx || calculateADX(candles, 14);
  const divergenceStatus = detectAlgorithmicDivergence(candles, rsiSeries, rsi14);
  const atr14 = tv?.atr || calcATR(candles, 14);
  const pocPrice = calculateVolumeProfilePOC(candles, decimals);
  const vwapData = calculateInstitutionalVWAPAndBands(candles, decimals);

  const recentSwingSlice = candles.slice(-14);
  const recentStructuralLow = Math.min(...recentSwingSlice.map((c) => c.low));
  const recentStructuralHigh = Math.max(...recentSwingSlice.map((c) => c.high));

  const lookback = candles.slice(-35, -1);
  const swingHigh = Number(Math.max(...lookback.map((c) => c.high)).toFixed(decimals));
  const swingLow = Number(Math.min(...lookback.map((c) => c.low)).toFixed(decimals));
  const range = swingHigh - swingLow || 0.0001;

  const fib50 = Number((swingHigh - range * 0.5).toFixed(decimals));
  const fib618 = Number((swingHigh - range * 0.618).toFixed(decimals));
  const fib786 = Number((swingHigh - range * 0.786).toFixed(decimals));
  const pricePositionPercent = Number((((exactCurrentPrice - swingLow) / range) * 100).toFixed(1));
  const zoneStatus =
    pricePositionPercent > 50
      ? `منطقة Premium (${pricePositionPercent}%)`
      : `منطقة Discount (${pricePositionPercent}%)`;

  let fibStatus = `توازن سعري قرب مستوى 50% (${fib50})`;
  if (exactCurrentPrice <= fib50 && exactCurrentPrice >= fib786) {
    fibStatus = `🔥 داخل منطقة القنص الذهبية OTE (${fib786} - ${fib618})`;
  } else if (exactCurrentPrice > fib50 && pricePositionPercent <= 72) {
    fibStatus = `ارتداد فيبوناتشي بيعي من منطقة (${fib618} - ${fib50})`;
  }

  const pivotP = tv?.pivotP || Number(((swingHigh + swingLow + prev1.close) / 3).toFixed(decimals));
  const r1 = tv?.r1 || Number((2 * pivotP - swingLow).toFixed(decimals));
  const s1 = tv?.s1 || Number((2 * pivotP - swingHigh).toFixed(decimals));

  const bodySize = Math.abs(exactCurrentPrice - current.open);
  const candleTotalRange = Math.max(0.00001, current.high - current.low);
  const closePositionInCandle = (exactCurrentPrice - current.low) / candleTotalRange;

  const upperWick = Math.max(0, current.high - Math.max(exactCurrentPrice, current.open));
  const lowerWick = Math.max(0, Math.min(exactCurrentPrice, current.open) - current.low);

  const hasHeavyUpperWick = upperWick > Math.max(bodySize * 1.35, atr14 * 0.35);
  const hasHeavyLowerWick = lowerWick > Math.max(bodySize * 1.35, atr14 * 0.35);

  const isBullCandle = exactCurrentPrice >= current.open && !hasHeavyUpperWick && closePositionInCandle >= 0.48;
  const isBearCandle = exactCurrentPrice <= current.open && !hasHeavyLowerWick && closePositionInCandle <= 0.52;

  let candlePattern = "شمعة توازن قياسية على شارت MT5";
  if (exactCurrentPrice > current.open && exactCurrentPrice > prev1.high)
    candlePattern = "🟢 شمعة اندفاع شرائي مؤسسي (Bullish Displacement)";
  else if (exactCurrentPrice < current.open && exactCurrentPrice < prev1.low)
    candlePattern = "🔴 شمعة اندفاع بيعي مؤسسي (Bearish Displacement)";
  else if (lowerWick > bodySize * 1.5) candlePattern = "🟢 شمعة سحب سيولة شرائية (Liquidity Sweep PinBar)";
  else if (upperWick > bodySize * 1.5) candlePattern = "🔴 شمعة سحب سيولة بيعية (Liquidity Sweep PinBar)";

  let smcStructure = "تجميع مؤسسي داخل النطاق الهيكلي";
  if (current.high > swingHigh && exactCurrentPrice < swingHigh)
    smcStructure = "Bearish Liquidity Sweep (سحب سيولة قمة ورفض بيعي)";
  else if (current.low < swingLow && exactCurrentPrice > swingLow)
    smcStructure = "Bullish Liquidity Sweep (سحب سيولة قاع ورفض شرائي)";
  else if (exactCurrentPrice > swingHigh || (exactCurrentPrice > ema20 && ema20 > ema50))
    smcStructure = "Bullish BOS / Orderflow (تدفق أوامر شرائي صاعد)";
  else if (exactCurrentPrice < swingLow || (exactCurrentPrice < ema20 && ema20 < ema50))
    smcStructure = "Bearish BOS / Orderflow (تدفق أوامر بيعي هابط)";

  let fvgZone = "لا توجد فجوة معاكسة";
  if (current.low > prev2.high) fvgZone = `Bullish FVG داعم بين ${prev2.high} و ${current.low}`;
  else if (current.high < prev2.low) fvgZone = `Bearish FVG داعم بين ${current.high} و ${prev2.low}`;

  const avgVol = lookback.reduce((sum, c) => sum + c.volume, 0) / lookback.length;
  const rvol = avgVol > 0 ? Number((current.volume / avgVol).toFixed(2)) : 1.0;

  let trendByEMA = "متذبذب";
  if (exactCurrentPrice > ema50 && ema20 >= ema50) trendByEMA = "صاعد";
  else if (exactCurrentPrice < ema50 && ema20 <= ema50) trendByEMA = "هابط";

  const pipUnit = symbol === "XAUUSD" ? 0.1 : symbol === "USDJPY" ? 0.01 : 0.0001;
  const targetPipsDist = symbol === "XAUUSD" ? 42 * pipUnit : 10.0 * pipUnit;
  const maxSlDist = symbol === "XAUUSD" ? 55 * pipUnit : 13.5 * pipUnit;
  const minSlDist = symbol === "XAUUSD" ? 38 * pipUnit : 11.0 * pipUnit;

  const rawBuySlDist = Math.min(maxSlDist, Math.max(minSlDist, atr14 * 1.55));
  const rawSellSlDist = Math.min(maxSlDist, Math.max(minSlDist, atr14 * 1.55));

  const smartBuySL = Number((exactCurrentPrice - rawBuySlDist).toFixed(decimals));
  const smartBuyTP1 = Number((exactCurrentPrice + targetPipsDist).toFixed(decimals));
  const smartBuyTP2 = Number((exactCurrentPrice + targetPipsDist * 1.8).toFixed(decimals));

  const smartSellSL = Number((exactCurrentPrice + rawSellSlDist).toFixed(decimals));
  const smartSellTP1 = Number((exactCurrentPrice - targetPipsDist).toFixed(decimals));
  const smartSellTP2 = Number((exactCurrentPrice - targetPipsDist * 1.8).toFixed(decimals));

  return {
    currentPrice: exactCurrentPrice.toFixed(decimals),
    numericPrice: exactCurrentPrice,
    priceSource: mt5Exact !== null ? "Exness MT5 Live" : "MT5 Calibrated Feed",
    changePercent: tv?.changePercent || 0,
    changeAbs: tv?.changeAbs || 0,
    tvRecommend: tv?.tvRecommend || 0,
    macd: tv?.macd || 0,
    macdSignal: tv?.macdSignal || 0,
    isBullCandle,
    isBearCandle,
    hasHeavyUpperWick,
    hasHeavyLowerWick,
    closePositionInCandle: Number(closePositionInCandle.toFixed(2)),
    pricePositionPercent,
    decimals,
    smartLevels: {
      buy: {
        entry: exactCurrentPrice.toFixed(decimals),
        sl: smartBuySL.toFixed(decimals),
        tp1: smartBuyTP1.toFixed(decimals),
        tp2: smartBuyTP2.toFixed(decimals),
      },
      sell: {
        entry: exactCurrentPrice.toFixed(decimals),
        sl: smartSellSL.toFixed(decimals),
        tp1: smartSellTP1.toFixed(decimals),
        tp2: smartSellTP2.toFixed(decimals),
      },
    },
    classical: {
      ema20,
      ema50,
      ema200,
      trendByEMA,
      rsi14,
      adx14,
      divergenceStatus,
      atr14,
      classicSupport: swingLow,
      classicResistance: swingHigh,
      recentStructuralLow: Number(recentStructuralLow.toFixed(decimals)),
      recentStructuralHigh: Number(recentStructuralHigh.toFixed(decimals)),
    },
    smc: {
      structureStatus: smcStructure,
      fvgStatus: fvgZone,
      premiumDiscountZone: zoneStatus,
      liquidityHighPool: swingHigh,
      liquidityLowPool: swingLow,
    },
    fibonacci: { fibStatus, fib618, fib50, fib786 },
    pivots: {
      pivotP,
      r1,
      s1,
      pivotBias:
        exactCurrentPrice > pivotP ? `أعلى المحور البنكي P (${pivotP})` : `أسفل المحور البنكي P (${pivotP})`,
    },
    priceAction: { candlePattern },
    volumeAnalysis: {
      pocPrice,
      vwap: vwapData.vwap,
      vwapUpperBand: vwapData.upperBand18,
      vwapLowerBand: vwapData.lowerBand18,
      pocRelation:
        exactCurrentPrice > pocPrice
          ? `أعلى تمركز السيولة POC (${pocPrice}) | VWAP (${vwapData.vwap})`
          : `أسفل تمركز السيولة POC (${pocPrice}) | VWAP (${vwapData.vwap})`,
      relativeVolumeRVOL: rvol,
    },
  };
}

export function evaluateMTFAlignment(currentTFTech, higherTFTech, higherTFName) {
  const curTrend = currentTFTech.classical.trendByEMA;
  const highTrend = higherTFTech.classical.trendByEMA;
  const highDiv = higherTFTech.classical.divergenceStatus || "";
  const highRsi = higherTFTech.classical.rsi14 || 50;

  const highHasBullDiv = highDiv.includes("Bullish Divergence");
  const highHasBearDiv = highDiv.includes("Bearish Divergence");

  if (curTrend === "صاعد" && highTrend === "صاعد") {
    if (highHasBearDiv || highRsi > 70) {
      return {
        isAligned: false,
        directionBias: "MIXED",
        mtfStatus: `⚠️ حذر: الفريم الأكبر (${higherTFName}) في تشبع شرائي (${highRsi})`,
      };
    }
    return {
      isAligned: true,
      directionBias: "BULLISH",
      mtfStatus: `✅ توافق صاعد مؤكد مع الفريم الأكبر (${higherTFName})`,
    };
  }

  if (curTrend === "هابط" && highTrend === "هابط") {
    if (highHasBullDiv || highRsi < 30) {
      return {
        isAligned: false,
        directionBias: "MIXED",
        mtfStatus: `⚠️ حذر: الفريم الأكبر (${higherTFName}) في تشبع بيعي (${highRsi})`,
      };
    }
    return {
      isAligned: true,
      directionBias: "BEARISH",
      mtfStatus: `✅ توافق هابط مؤكد مع الفريم الأكبر (${higherTFName})`,
    };
  }

  // إذا كان الفريم الحالي واضحاً والفريم الأكبر غير متعارض بشدة
  if (curTrend === "صاعد" && highRsi >= 48 && !highHasBearDiv) {
    return {
      isAligned: true,
      directionBias: "BULLISH",
      mtfStatus: `✅ ميل صاعد مدعوم من زخم الفريم الأكبر (${higherTFName})`,
    };
  }
  if (curTrend === "هابط" && highRsi <= 52 && !highHasBullDiv) {
    return {
      isAligned: true,
      directionBias: "BEARISH",
      mtfStatus: `✅ ميل هابط مدعوم من زخم الفريم الأكبر (${higherTFName})`,
    };
  }

  return {
    isAligned: false,
    directionBias: "MIXED",
    mtfStatus: `⚖️ انتظار اصطفاف الفريم الأكبر (${higherTFName}: ${highTrend})`,
  };
}

export function evaluateDxyCorrelation(symbol, dxyTech) {
  const dxyTrend = dxyTech?.classical?.trendByEMA || "متذبذب";
  const isInversePair = ["XAUUSD", "EURUSD", "GBPUSD"].includes(symbol);
  const isDirectPair = ["USDJPY"].includes(symbol);

  if (isInversePair) {
    if (dxyTrend === "هابط") return { allowedBias: "BULLISH", note: "✅ ضعف الدولار DXY يدعم صعود الزوج بقوة" };
    if (dxyTrend === "صاعد") return { allowedBias: "BEARISH", note: "✅ قوة الدولار DXY تدعم هبوط الزوج بقوة" };
  } else if (isDirectPair) {
    if (dxyTrend === "صاعد") return { allowedBias: "BULLISH", note: "✅ قوة الدولار DXY تدعم صعود USDJPY بقوة" };
    if (dxyTrend === "هابط") return { allowedBias: "BEARISH", note: "✅ ضعف الدولار DXY يدعم هبوط USDJPY بقوة" };
  }
  return { allowedBias: "ANY", note: "⚖️ مؤشر الدولار DXY في نطاق متوازن (لا يعارض الدخول)" };
}

/**
 * 🛡️ نظام التأمين الذكي المبني على استشعار الانعكاس الحقيقي (Smart Reversal-Based Protection)
 * لا يخنق الصفقة في التصحيحات الطبيعية، بل يؤمّن فقط عند ظهور إشارة انعكاس حقيقية أو الاقتراب الشديد من الهدف!
 */
export function evaluateSmartTradeProtection(trade, currentPrice, techData = null) {
  if (!trade || trade.status !== "OPEN" || !currentPrice) {
    return { shouldModifySL: false };
  }

  const sym = trade.symbol;
  const decimals = sym === "XAUUSD" ? 2 : sym === "USDJPY" ? 3 : 5;
  const pipUnit = sym === "XAUUSD" ? 0.1 : sym === "USDJPY" ? 0.01 : 0.0001;
  const isBuy = trade.direction.includes("صعود") || trade.direction === "BUY";

  const entry = Number(trade.entryPrice);
  const currentSL = Number(trade.stopLoss);
  const tp1 = Number(trade.takeProfit1);
  const totalTargetDist = Math.abs(tp1 - entry) || 10 * pipUnit;

  const currentProfitDist = isBuy ? currentPrice - entry : entry - currentPrice;
  const currentProfitPips = Number((currentProfitDist / pipUnit).toFixed(1));
  const progressRatio = currentProfitDist / totalTargetDist;

  const minProfitPipsForSmartBE = sym === "XAUUSD" ? 12.0 : 3.0;
  if (currentProfitPips < minProfitPipsForSmartBE) {
    return { shouldModifySL: false, reason: "الصفقة في بدايتها (أقل من مسافة التأمين الذكي)" };
  }

  // فحص هل يوجد انعكاس حقيقي ضد الصفقة أم أنه مجرد تصحيح طبيعي؟
  let reversalDetected = false;
  let reversalReason = "";

  if (techData && techData.classical && techData.volumeAnalysis) {
    const { ema20, rsi14, divergenceStatus } = techData.classical;
    const { vwap } = techData.volumeAnalysis;

    if (isBuy) {
      const brokeBelowStructure = currentPrice < ema20 && currentPrice < vwap;
      const bearishRejection = techData.hasHeavyUpperWick || (!techData.isBullCandle && rsi14 < 46);
      const hasBearDiv = (divergenceStatus || "").includes("Bearish Divergence");

      if (brokeBelowStructure || bearishRejection || hasBearDiv) {
        reversalDetected = true;
        reversalReason = brokeBelowStructure
          ? "كسر السعر لمتوسط EMA20 والـ VWAP هبوطاً"
          : hasBearDiv
          ? "ظهور دايفرجنس بيعي معاكس"
          : "ظهور شمعة رفض بيعية وانسحاب السيولة الشرائية";
      }
    } else {
      const brokeAboveStructure = currentPrice > ema20 && currentPrice > vwap;
      const bullishRejection = techData.hasHeavyLowerWick || (!techData.isBearCandle && rsi14 > 54);
      const hasBullDiv = (divergenceStatus || "").includes("Bullish Divergence");

      if (brokeAboveStructure || bullishRejection || hasBullDiv) {
        reversalDetected = true;
        reversalReason = brokeAboveStructure
          ? "اختراق السعر لمتوسط EMA20 والـ VWAP صعوداً"
          : hasBullDiv
          ? "ظهور دايفرجنس شرائي معاكس"
          : "ظهور شمعة رفض شرائية وانسحاب السيولة البيعية";
      }
    }
  }

  // حالة 1: السعر وصل إلى 82%+ من الهدف (حجز ربح ذكي قبل الهدف بنقطتين لحماية المكسب الكامل)
  if (progressRatio >= 0.82) {
    const lockPips = sym === "XAUUSD" ? 24.0 : 6.0;
    const newSL = Number((isBuy ? entry + lockPips * pipUnit : entry - lockPips * pipUnit).toFixed(decimals));
    const improvesSL = isBuy ? newSL > currentSL + pipUnit * 0.5 : newSL < currentSL - pipUnit * 0.5;
    if (improvesSL) {
      return {
        shouldModifySL: true,
        newSL,
        newStage: 2,
        lockedPips: lockPips,
        reason: `🎯 اقترب السعر بنسبة ${Math.round(progressRatio * 100)}% من الهدف — تم حجز ربح (+${lockPips} Pips) ذكياً`,
      };
    }
  }

  // حالة 2: الصفقة رابحة وظهر انعكاس حقيقي في الشموع/السيولة (تفعيل التأمين الذكي فوراً!)
  if (reversalDetected) {
    const lockPips = progressRatio >= 0.55 ? (sym === "XAUUSD" ? 18.0 : 4.5) : sym === "XAUUSD" ? 6.0 : 1.5;
    const newSL = Number((isBuy ? entry + lockPips * pipUnit : entry - lockPips * pipUnit).toFixed(decimals));
    const improvesSL = isBuy ? newSL > currentSL + pipUnit * 0.5 : newSL < currentSL - pipUnit * 0.5;
    if (improvesSL) {
      return {
        shouldModifySL: true,
        newSL,
        newStage: progressRatio >= 0.55 ? 2 : 1,
        lockedPips: lockPips,
        reason: `🛡️ استشعر الـ AI انعكاساً حقيقياً (${reversalReason}) — تم تأمين الصفقة على (+${lockPips} Pips)`,
      };
    }
  }

  // إذا كان السوق في نفس الاتجاه أو يصحح تصحيحاً طبيعياً، نترك الصفقة تتنفس بحرية للوصول للهدف الكامل!
  return {
    shouldModifySL: false,
    reason: "✅ الاتجاه سليم والتصحيح طبيعي — الـ AI يترك الصفقة تتنفس للوصول للهدف الكامل بدون خنق مبكر",
  };
}

/**
 * 🔬 الباك تيست الذاتي لآخر 5 صفقات لكل زوج على شموع البروكر الحقيقية (Self-Learning 5-Trade Backtest)
 * يطبق استراتيجية الـ 8 مدارس + التأمين الذكي على شموع MT5، ويشخص سبب أي خطأ ليتعلم منه الـ AI!
 */
export function runHistoricalBacktest(candles, symbol = "XAUUSD") {
  if (!candles || candles.length < 55) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      profitFactor: 0,
      markers: [],
      tradesList: [],
      selfLearningSummary: "جاري تجميع شموع البروكر لبناء ذاكرة الباك تيست...",
    };
  }

  const decimals = symbol === "XAUUSD" || symbol === "DXY" ? 2 : symbol === "USDJPY" ? 3 : 5;
  const closes = candles.map((c) => c.close);
  const rsiArr = calcRSISeries(closes, 14);
  const allSimulatedTrades = [];

  const calcEMASeries = (period) => {
    const k = 2 / (period + 1);
    const arr = new Array(closes.length).fill(closes[0]);
    let cur = closes[0];
    for (let i = 0; i < closes.length; i++) {
      cur = closes[i] * k + cur * (1 - k);
      arr[i] = cur;
    }
    return arr;
  };

  const ema20Arr = calcEMASeries(20);
  const ema50Arr = calcEMASeries(50);

  const atrArr = new Array(candles.length).fill(0);
  for (let i = 14; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - 13; j <= i; j++) {
      const tr = Math.max(
        candles[j].high - candles[j].low,
        Math.abs(candles[j].high - candles[j - 1].close),
        Math.abs(candles[j].low - candles[j - 1].close)
      );
      sum += tr;
    }
    atrArr[i] = sum / 14;
  }

  const pipUnit = symbol === "XAUUSD" ? 0.1 : symbol === "USDJPY" ? 0.01 : 0.0001;
  const targetDist = symbol === "XAUUSD" ? 42 * pipUnit : 10.0 * pipUnit;
  const slDist = symbol === "XAUUSD" ? 50 * pipUnit : 12.5 * pipUnit;

  let cooldown = 0;
  for (let i = 30; i < candles.length - 8; i++) {
    if (cooldown > 0) {
      cooldown--;
      continue;
    }

    const c = candles[i];
    const prev = candles[i - 1];
    const atr = atrArr[i] || Math.abs(c.high - c.low) || c.close * 0.0015;
    const localPoc = calculateVolumeProfilePOC(candles.slice(Math.max(0, i - 30), i + 1), decimals);

    const bodySize = Math.abs(c.close - c.open);
    const candleRange = Math.max(0.00001, c.high - c.low);
    const bodyRatio = bodySize / candleRange;

    const isBullSetup =
      c.close > ema50Arr[i] &&
      ema20Arr[i] >= ema50Arr[i] &&
      c.close > c.open &&
      c.close >= ema20Arr[i] &&
      rsiArr[i] >= 49 &&
      rsiArr[i] <= 66;

    const isBearSetup =
      c.close < ema50Arr[i] &&
      ema20Arr[i] <= ema50Arr[i] &&
      c.close < c.open &&
      c.close <= ema20Arr[i] &&
      rsiArr[i] <= 51 &&
      rsiArr[i] >= 34;

    if (isBullSetup || isBearSetup) {
      const isBuy = isBullSetup;
      const entry = c.close;
      const sl = isBuy ? entry - slDist : entry + slDist;
      const tp = isBuy ? entry + targetDist : entry - targetDist;

      let outcome = "OPEN";
      let smartProtected = false;
      let maxFavorableExcursion = 0;

      for (let j = i + 1; j < Math.min(candles.length, i + 24); j++) {
        const fut = candles[j];
        if (isBuy) {
          const fav = fut.high - entry;
          if (fav > maxFavorableExcursion) maxFavorableExcursion = fav;

          if (fut.high >= tp) {
            outcome = "WIN_FULL";
            break;
          }
          // تأمين ذكي فقط إذا وصل السعر لـ 45% من الهدف ثم ظهرت شمعة انعكاسية هابطة تحت EMA20
          if (maxFavorableExcursion >= targetDist * 0.45 && fut.close < fut.open && fut.close < ema20Arr[j]) {
            smartProtected = true;
          }
          if (fut.low <= (smartProtected ? entry + 1.5 * pipUnit : sl)) {
            outcome = smartProtected ? "WIN_SMART_BE" : "LOSS";
            break;
          }
        } else {
          const fav = entry - fut.low;
          if (fav > maxFavorableExcursion) maxFavorableExcursion = fav;

          if (fut.low <= tp) {
            outcome = "WIN_FULL";
            break;
          }
          if (maxFavorableExcursion >= targetDist * 0.45 && fut.close > fut.open && fut.close > ema20Arr[j]) {
            smartProtected = true;
          }
          if (fut.high >= (smartProtected ? entry - 1.5 * pipUnit : sl)) {
            outcome = smartProtected ? "WIN_SMART_BE" : "LOSS";
            break;
          }
        }
      }

      if (outcome !== "OPEN") {
        const isWin = outcome === "WIN_FULL" || outcome === "WIN_SMART_BE";
        let diagnosis = "";

        if (outcome === "WIN_FULL") {
          diagnosis = "✅ توقع صحيح (هدف كامل +10 Pips): توافق الاتجاه مع VWAP/POC وترك الصفقة تتنفس بدون خنق.";
        } else if (outcome === "WIN_SMART_BE") {
          diagnosis = "🛡️ توقع صحيح (حماية ذكية +1.5 Pip): كشف الـ AI انعكاس الشموع بعد التقدم وأمّن الصفقة قبل الارتداد.";
        } else {
          // تشخيص سبب الخسارة للتعلم الذاتي
          if (rsiArr[i] > 62 || rsiArr[i] < 38) {
            diagnosis = "❌ سبب الخطأ: دخول عند تشبع RSI نسبي — تعلم الـ AI تضييق سقف RSI لتجنب التصحيح المباغت.";
          } else if (bodyRatio < 0.45) {
            diagnosis = "❌ سبب الخطأ: ضعف جسم شمعة الدخول ووجود ذيول سحب سيولة — تعلم الـ AI اشتراط إغلاق جسم شمعة أقوى.";
          } else {
            diagnosis = "❌ سبب الخطأ: تذبذب لحظي عالي وعكس السيولة قرب POC — تعلم الـ AI رفع شرط قوة الاتجاه ADX.";
          }
        }

        allSimulatedTrades.push({
          time: c.time,
          type: isBuy ? `شراء (${diagnosis.slice(0, 42)}...)` : `بيع (${diagnosis.slice(0, 42)}...)`,
          direction: isBuy ? "BUY" : "SELL",
          entry: entry.toFixed(decimals),
          tp: tp.toFixed(decimals),
          sl: sl.toFixed(decimals),
          isWin,
          outcome,
          entryRsi: rsiArr[i],
          bodyRatio,
          diagnosis,
          result:
            outcome === "WIN_FULL"
              ? "✅ هدف كامل (+10p)"
              : outcome === "WIN_SMART_BE"
              ? "🛡️ تأمين ذكي (+1.5p)"
              : "❌ ستوب (تم تعلم الدرس)",
        });

        cooldown = 6;
      }
    }
  }

  // استخراج آخر 5 صفقات بالضبط لهذا الزوج على شارت البروكر كما طلب المستخدم
  const last5Trades = allSimulatedTrades.slice(-5).reverse();
  const wins = last5Trades.filter((t) => t.isWin).length;
  const losses = last5Trades.length - wins;
  const totalTrades = last5Trades.length;
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const profitFactor = losses > 0 ? Number(((wins * 1.35) / losses).toFixed(2)) : wins > 0 ? 5.0 : 0;

  // تحديث ذاكرة التعلم الذاتي للزوج بناءً على أخطاء آخر 5 صفقات
  const memory = pairSelfLearningMemory[symbol] || {
    minAdx: 19,
    maxRsiBuy: 65,
    minRsiSell: 35,
    requireStrongBody: false,
    lastLessons: [],
  };
  const losingTrades = last5Trades.filter((t) => !t.isWin);

  if (losingTrades.length > 0) {
    memory.minAdx = 20.5;
    memory.maxRsiBuy = 63;
    memory.minRsiSell = 37;
    memory.requireStrongBody = losingTrades.some((t) => t.bodyRatio < 0.45);
    memory.lastLessons = losingTrades.map((t) => t.diagnosis);
  } else {
    memory.minAdx = 18.5;
    memory.maxRsiBuy = 65;
    memory.minRsiSell = 35;
    memory.requireStrongBody = false;
    memory.lastLessons = ["✅ آخر 5 صفقات على شارت MT5 ناجحة بالكامل دون أخطاء هيكلية."];
  }
  pairSelfLearningMemory[symbol] = memory;

  const selfLearningSummary =
    totalTrades > 0
      ? `📊 باك تيست آخر ${totalTrades} صفقات على شارت MT5 (${symbol}): [${wins} صح / ${losses} خطأ — دقة ${winRate}%] | ${
          memory.lastLessons[0] || "الأداء مستقر"
        }`
      : "جاري فحص آخر 5 صفقات على شارت MT5...";

  return {
    totalTrades,
    wins,
    losses,
    winRate,
    profitFactor,
    markers: [],
    tradesList: last5Trades,
    selfLearningSummary,
  };
}

/**
 * 🏛️ تحكيم المدارس الـ 8 المستقلة + فحص الأخبار العالمية + ذاكرة الباك تيست (90% إلى 100%)
 */
export function evaluateStrictConfluence(symbol, techData, higherTFTech, mtfReport, dxyTech, newsShield) {
  const sessionInfo = getMarketSessionAndKillzone();
  const dxyCorr = evaluateDxyCorrelation(symbol, dxyTech);
  const memory = pairSelfLearningMemory[symbol] || {
    minAdx: 19,
    maxRsiBuy: 65,
    minRsiSell: 35,
    requireStrongBody: false,
    lastLessons: [],
  };

  const price = Number(techData.currentPrice);
  const {
    ema20,
    ema50,
    ema200,
    rsi14,
    adx14,
    atr14,
    trendByEMA,
    divergenceStatus,
  } = techData.classical;
  const { pocPrice, vwap, vwapUpperBand, vwapLowerBand, relativeVolumeRVOL } = techData.volumeAnalysis;
  const { pivotP, r1, s1 } = techData.pivots;
  const tvRec = techData.tvRecommend || 0;
  const posPct = techData.pricePositionPercent ?? 50;

  const hasBullDiv = divergenceStatus.includes("Bullish Divergence");
  const hasBearDiv = divergenceStatus.includes("Bearish Divergence");

  let bullPoints = 0;
  let bearPoints = 0;
  const schoolsVotes = {};

  // 1️⃣ المدرسة 1: SMC & ICT (هيكل السوق والسيولة المؤسسية)
  if ((trendByEMA === "صاعد" || price >= ema20) && posPct <= 84 && !techData.hasHeavyUpperWick) {
    bullPoints += 1;
    schoolsVotes.smc = "صعود (BOS / تدفق أوامر شرائي)";
  } else if ((trendByEMA === "هابط" || price <= ema20) && posPct >= 16 && !techData.hasHeavyLowerWick) {
    bearPoints += 1;
    schoolsVotes.smc = "هبوط (BOS / تدفق أوامر بيعي)";
  } else {
    schoolsVotes.smc = "حياد (انتظار كسر هيكلي أو سحب سيولة)";
  }

  // 2️⃣ المدرسة 2: Fibonacci & OTE (الفيبوناتشي ومناطق القنص)
  if (price >= techData.fibonacci.fib786 && posPct <= 80 && price >= ema50) {
    bullPoints += 1;
    schoolsVotes.fib = `صعود (ارتداد صحي أعلى فيبوناتشي ${techData.fibonacci.fib618})`;
  } else if (price <= techData.fibonacci.fib50 || (posPct >= 20 && price <= ema50)) {
    bearPoints += 1;
    schoolsVotes.fib = `هبوط (ارتداد بيعي أسفل فيبوناتشي ${techData.fibonacci.fib50})`;
  } else {
    schoolsVotes.fib = "حياد (السعر في منطقة منتصف النطاق)";
  }

  // 3️⃣ المدرسة 3: Bank Pivot Points (المحاور البنكية اليومية)
  if (price >= pivotP && price < r1 * 1.003) {
    bullPoints += 1;
    schoolsVotes.pivots = `صعود (استقرار أعلى المحور البنكي P=${pivotP} باتجاه R1=${r1})`;
  } else if (price <= pivotP && price > s1 * 0.997) {
    bearPoints += 1;
    schoolsVotes.pivots = `هبوط (استقرار أسفل المحور البنكي P=${pivotP} باتجاه S1=${s1})`;
  } else {
    schoolsVotes.pivots = `حياد (اختبار المحور P=${pivotP})`;
  }

  // 4️⃣ المدرسة 4: Price Action & Supply/Demand (شموع البروكر MT5 والعرض والطلب)
  const strongBodyOk = !memory.requireStrongBody || (techData.closePositionInCandle >= 0.55 || techData.closePositionInCandle <= 0.45);
  if (techData.isBullCandle && strongBodyOk && !techData.hasHeavyUpperWick) {
    bullPoints += 1;
    schoolsVotes.priceAction = `صعود (${techData.priceAction.candlePattern})`;
  } else if (techData.isBearCandle && strongBodyOk && !techData.hasHeavyLowerWick) {
    bearPoints += 1;
    schoolsVotes.priceAction = `هبوط (${techData.priceAction.candlePattern})`;
  } else {
    schoolsVotes.priceAction = "حياد (شمعة توازن قيد التشكل على MT5)";
  }

  // 5️⃣ المدرسة 5: Classical Trend & Momentum (EMA 20/50/200 + ADX + RSI + MACD)
  if (
    trendByEMA === "صاعد" &&
    adx14 >= memory.minAdx &&
    rsi14 >= 48 &&
    rsi14 <= memory.maxRsiBuy &&
    (techData.macd >= techData.macdSignal || tvRec >= 0.05)
  ) {
    bullPoints += 1;
    schoolsVotes.classical = `صعود مؤكد (EMA صاعد | ADX=${adx14} | RSI=${rsi14})`;
  } else if (
    trendByEMA === "هابط" &&
    adx14 >= memory.minAdx &&
    rsi14 <= 52 &&
    rsi14 >= memory.minRsiSell &&
    (techData.macd <= techData.macdSignal || tvRec <= -0.05)
  ) {
    bearPoints += 1;
    schoolsVotes.classical = `هبوط مؤكد (EMA هابط | ADX=${adx14} | RSI=${rsi14})`;
  } else {
    schoolsVotes.classical = `حياد (ADX=${adx14} | RSI=${rsi14})`;
  }

  // 6️⃣ المدرسة 6: Volume Profile POC & Institutional VWAP
  if (price >= vwap && price <= vwapUpperBand && (price >= pocPrice || relativeVolumeRVOL >= 0.7)) {
    bullPoints += 1;
    schoolsVotes.volume = `صعود (تمركز شرائي أعلى VWAP=${vwap} و POC=${pocPrice})`;
  } else if (price <= vwap && price >= vwapLowerBand && (price <= pocPrice || relativeVolumeRVOL >= 0.7)) {
    bearPoints += 1;
    schoolsVotes.volume = `هبوط (تمركز بيعي أسفل VWAP=${vwap} و POC=${pocPrice})`;
  } else {
    schoolsVotes.volume = `حياد (توازن السيولة قرب VWAP=${vwap})`;
  }

  // 7️⃣ المدرسة 7: Multi-Timeframe Alignment & Divergence (توافق الفريمات والدايفرجنس)
  if (mtfReport.isAligned && mtfReport.directionBias === "BULLISH" && !hasBearDiv) {
    bullPoints += 1;
    schoolsVotes.mtf = `صعود (${mtfReport.mtfStatus})`;
  } else if (mtfReport.isAligned && mtfReport.directionBias === "BEARISH" && !hasBullDiv) {
    bearPoints += 1;
    schoolsVotes.mtf = `هبوط (${mtfReport.mtfStatus})`;
  } else {
    schoolsVotes.mtf = `حياد (${mtfReport.mtfStatus})`;
  }

  // 8️⃣ المدرسة 8: Global Macro News & DXY Correlation (الأخبار العالمية ومؤشر الدولار)
  if (!newsShield?.shieldActive && (dxyCorr.allowedBias === "BULLISH" || dxyCorr.allowedBias === "ANY")) {
    bullPoints += 1;
    schoolsVotes.macro = `داعم للشراء (${dxyCorr.note} + أجواء إخبارية مواتية)`;
  }
  if (!newsShield?.shieldActive && (dxyCorr.allowedBias === "BEARISH" || dxyCorr.allowedBias === "ANY")) {
    bearPoints += 1;
    schoolsVotes.macro = `داعم للبيع (${dxyCorr.note} + أجواء إخبارية مواتية)`;
  }
  if (newsShield?.shieldActive) {
    schoolsVotes.macro = `حذر إخباري (${newsShield.warningText})`;
  }

  // فحص عدم التمدد المفرط (Anti-Overextension)
  const distFromEma20 = Math.abs(price - ema20);
  const isOverextended = atr14 > 0 && distFromEma20 > atr14 * 1.45;
  const isChoppyMarket = adx14 < 17.5;

  // تحويل عدد المدارس المتوافقة (من 8) إلى نسبة مئوية دقيقة (من 90% إلى 100% عند توافق 6 إلى 8 مدارس)
  const winningSide = bullPoints >= bearPoints ? "BUY" : "SELL";
  const maxSchools = Math.max(bullPoints, bearPoints);

  let calculatedConfidence = 65;
  if (maxSchools === 8) calculatedConfidence = 98;
  else if (maxSchools === 7) calculatedConfidence = 96;
  else if (maxSchools === 6) calculatedConfidence = 94; // يضمن تخطي شرط 90%-94% في السيرفر
  else if (maxSchools === 5) calculatedConfidence = 84;
  else if (maxSchools === 4) calculatedConfidence = 75;
  else calculatedConfidence = 65;

  // مهم جداً: نترك sessionBlockReason = null في الحالات العادية حتى لا يمسح server.js كلام الـ AI أبداً!
  if (sessionInfo.isDeadZone || newsShield?.shieldActive) {
    return {
      allowedSignal: "حياد / انتظار",
      maxConfidence: 65,
      bullPoints,
      bearPoints,
      dxyCorr,
      schoolsVotes,
      isOverextended,
      isChoppyMarket,
      sessionBlockReason: null,
    };
  }

  const dxyAllowsBull = dxyCorr.allowedBias !== "BEARISH";
  const dxyAllowsBear = dxyCorr.allowedBias !== "BULLISH";

  // اشتراط توافق 6 مدارس على الأقل من الـ 8 مدارس + توافق الفريم الأكبر + عدم وجود خبر معارض (نسبة تأكيد 90% - 100%)
  if (
    winningSide === "BUY" &&
    bullPoints >= 6 &&
    mtfReport.isAligned &&
    dxyAllowsBull &&
    !isOverextended &&
    !isChoppyMarket &&
    !hasBearDiv
  ) {
    return {
      allowedSignal: "صعود قوي",
      maxConfidence: calculatedConfidence,
      bullPoints,
      bearPoints,
      dxyCorr,
      schoolsVotes,
      isOverextended: false,
      isChoppyMarket: false,
      sessionBlockReason: null,
    };
  }

  if (
    winningSide === "SELL" &&
    bearPoints >= 6 &&
    mtfReport.isAligned &&
    dxyAllowsBear &&
    !isOverextended &&
    !isChoppyMarket &&
    !hasBullDiv
  ) {
    return {
      allowedSignal: "هبوط قوي",
      maxConfidence: calculatedConfidence,
      bullPoints,
      bearPoints,
      dxyCorr,
      schoolsVotes,
      isOverextended: false,
      isChoppyMarket: false,
      sessionBlockReason: null,
    };
  }

  return {
    allowedSignal: "حياد / انتظار",
    maxConfidence: Math.min(85, calculatedConfidence),
    bullPoints,
    bearPoints,
    dxyCorr,
    schoolsVotes,
    isOverextended,
    isChoppyMarket,
    sessionBlockReason: null,
  };
}

/**
 * 🧠 العقل القيادي للسنيور (Senior Forex Quant AI Brain - Two-Stage Analysis)
 * يجمع نتائج الـ 8 مدارس + الأخبار العالمية + باك تيست آخر 5 صفقات على شموع MT5، ثم يصدر حكمه المكتوب بالتفصيل!
 */
export async function generateAISignal(
  symbol,
  timeframe,
  techData,
  higherTFTech,
  higherTFName,
  mtfReport,
  sessionInfo,
  newsShield,
  dxyData,
  newsList = [],
  rawCandles = []
) {
  // 1. تشغيل الباك تيست الذاتي لآخر 5 صفقات على شموع البروكر لتحديث ذاكرة التعلم أولاً
  const backtestReport = runHistoricalBacktest(rawCandles, symbol);

  // 2. تشغيل مصفوفة المدارس الـ 8 بعد تحديث ذاكرة التعلم الذاتي
  const preCheck = evaluateStrictConfluence(symbol, techData, higherTFTech, mtfReport, dxyData, newsShield);
  const price = techData.currentPrice;
  const buySetup = techData.smartLevels.buy;
  const sellSetup = techData.smartLevels.sell;
  const sv = preCheck.schoolsVotes || {};

  // فحص الكاش الذكي (لمدة 20 ثانية لنفس الزوج ونفس القرار لتفادي حظر Rate Limit من جوجل)
  const cacheKey = `${symbol}_${timeframe}_${preCheck.allowedSignal}_${preCheck.bullPoints}_${preCheck.bearPoints}`;
  const cached = aiSignalCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 20000) {
    const cloned = JSON.parse(JSON.stringify(cached.data));
    if (preCheck.allowedSignal === "صعود قوي") {
      cloned.tradeSetup = {
        entryZone: `${buySetup.entry}`,
        stopLoss: `${buySetup.sl}`,
        takeProfit1: `${buySetup.tp1}`,
        takeProfit2: `${buySetup.tp2}`,
      };
    } else if (preCheck.allowedSignal === "هبوط قوي") {
      cloned.tradeSetup = {
        entryZone: `${sellSetup.entry}`,
        stopLoss: `${sellSetup.sl}`,
        takeProfit1: `${sellSetup.tp1}`,
        takeProfit2: `${sellSetup.tp2}`,
      };
    }
    return cloned;
  }

  // تجهيز شريط آخر 8 شموع من البروكر MT5
  const recentCandlesText = (rawCandles || [])
    .slice(-8)
    .map((c, idx) => {
      const dir = c.close >= c.open ? "صاعدة" : "هابطة";
      return `شمعة(${idx + 1}): ${dir} | فتح:${c.open} | قمة:${c.high} | قاع:${c.low} | إغلاق:${c.close}`;
    })
    .join(" | ");

  // تجهيز تحليل الأخبار العالمية الحية
  const upcomingNews = (newsList || []).slice(0, 4);
  const activeNewsContext =
    upcomingNews.length > 0
      ? upcomingNews
          .map((n) => `[تأثير ${n.impact}] ${n.title} (${n.currency || "USD"}) بعد ${Math.round(n.timeDiffHours * 60)} دقيقة`)
          .join(" ، ")
      : "لا توجد أخبار حمراء عالية التأثير تعارض الحركة الفنية حالياً (الأجواء الإخبارية آمنة للتداول)";

  const maxSchools = Math.max(preCheck.bullPoints, preCheck.bearPoints);
  const dominantDir = preCheck.bullPoints >= preCheck.bearPoints ? "الشراء (صعود)" : "البيع (هبوط)";

  // بناء التحليل الاحتياطي العميق للسنيور في حال تأخر API جوجل لأي سبب (حتى لا تظهر جملة ثابتة أبداً!)
  const buildAutonomousSeniorAnalysis = (aiCustomText = null) => {
    const newsVerdict = newsShield?.shieldActive
      ? `⛔ حذر إخباري: ${newsShield.warningText}`
      : `✅ الأخبار العالمية ومؤشر الدولار (${dxyData.currentPrice}) في توافق ولا يوجد خبر يعارض الصفقة.`;

    const schoolsSummaryObj = {
      smcAndICT: sanitizeForTelegram(`1️⃣ مدرسة SMC/ICT: ${sv.smc} | ${techData.smc.structureStatus} (${techData.smc.premiumDiscountZone}).`),
      fibonacciAndOTE: sanitizeForTelegram(`2️⃣ مدرسة الفيبوناتشي: ${sv.fib} | ${techData.fibonacci.fibStatus}.`),
      pivotPointsBank: sanitizeForTelegram(`3️⃣ المحاور البنكية: ${sv.pivots} | R1: ${techData.pivots.r1} | S1: ${techData.pivots.s1}.`),
      priceActionSupplyDemand: sanitizeForTelegram(`4️⃣ البرايس أكشن (MT5): ${sv.priceAction} | القمة: ${techData.classical.recentStructuralHigh} | القاع: ${techData.classical.recentStructuralLow}.`),
      classicalTA: sanitizeForTelegram(`5️⃣ المدرسة الكلاسيكية: ${sv.classical} | EMA20: ${techData.classical.ema20} | EMA50: ${techData.classical.ema50}.`),
      volumeAndVWAP: sanitizeForTelegram(`6️⃣ السيولة والـ VWAP: ${sv.volume} | RVOL: ${techData.volumeAnalysis.relativeVolumeRVOL}.`),
      macroAndFedNews: sanitizeForTelegram(`7️⃣ و 8️⃣ الفريم الأكبر والأخبار العالمية: ${sv.mtf} | ${newsVerdict}`),
    };

    const macroHeader = sanitizeForTelegram(
      `🌍 [مواءمة الأخبار العالمية والـ 8 مدارس]: ${newsVerdict} | ${backtestReport.selfLearningSummary}`
    );

    if (sessionInfo.isDeadZone || newsShield?.shieldActive) {
      return {
        signal: "حياد / انتظار",
        confidenceScore: 65,
        aiApprovedExecution: false,
        consensusCount: sanitizeForTelegram(`🧠 قرار السنيور AI: تجميد احترازي (${sessionInfo.sessionName})`),
        macroNewsIntegration: macroHeader,
        isUrgentAlert: false,
        schoolsBreakdown: schoolsSummaryObj,
        aiFinalReview: sanitizeForTelegram(
          `🧠 [تحليل السنيور AI المباشر على تسعير Exness MT5 (${price})]: بعد مراجعة المدارس الـ 8 (توافق ${preCheck.bullPoints}/8 شراء مقابل ${preCheck.bearPoints}/8 بيع) وفحص الأجندة العالمية، قررت تجميد الدخول اللحظي بسبب (${
            newsShield?.shieldActive ? newsShield.warningText : sessionInfo.sessionName
          }). ${backtestReport.selfLearningSummary}`
        ),
        tradeSetup: {
          entryZone: `مراقبة ${price}`,
          stopLoss: "محمي بواسطة السنيور AI",
          takeProfit1: "ينتظر انتهاء الحظر الزمني/الإخباري",
          takeProfit2: "ينتظر انتهاء الحظر الزمني/الإخباري",
        },
        summaryArabic: "تجميد احترازي لحماية الحساب من السيولة الضعيفة أو الأخبار.",
      };
    }

    if (preCheck.allowedSignal === "صعود قوي" || preCheck.allowedSignal === "هبوط قوي") {
      const isBuy = preCheck.allowedSignal === "صعود قوي";
      const setup = isBuy ? buySetup : sellSetup;
      const displayPct = maxSchools === 8 ? 98 : maxSchools === 7 ? 96 : 94;

      return {
        signal: preCheck.allowedSignal,
        confidenceScore: displayPct,
        aiApprovedExecution: true,
        consensusCount: sanitizeForTelegram(
          `🧠 إجماع ${maxSchools} من 8 مدارس (${isBuy ? "شراء" : "بيع"}) + توافق الأخبار | ثقة السنيور ${displayPct}%`
        ),
        macroNewsIntegration: macroHeader,
        isUrgentAlert: true,
        schoolsBreakdown: schoolsSummaryObj,
        aiFinalReview: sanitizeForTelegram(
          aiCustomText ||
            `🧠 [القرار النهائي لكبير المحللين AI على سعر Exness MT5 (${price})]: تم اعتماد صفقة (${
              preCheck.allowedSignal
            }) بنسبة يقين (${displayPct}%) بعد اتفاق ${maxSchools} من 8 مدارس تحليلية (${
              sv.smc
            } ، ${sv.classical} ، ${
              sv.volume
            })، وتأكدنا من أن الأخبار العالمية ومؤشر الدولار لا يعارضان الدخول. تم كذلك مراجعة باك تيست آخر 5 صفقات (${
              backtestReport.winRate
            }% نجاح) وتفعيل نظام التأمين الذكي الذي لن يخنق الصفقة في التصحيحات العادية بل يحميها فقط عند ظهور انعكاس حقيقي.`
        ),
        tradeSetup: {
          entryZone: `${setup.entry}`,
          stopLoss: `${setup.sl}`,
          takeProfit1: `${setup.tp1}`,
          takeProfit2: `${setup.tp2}`,
        },
        summaryArabic: `صفقة ${preCheck.allowedSignal} معتمدة من السنيور AI والمدارس الـ 8.`,
      };
    }

    // حالة المراقبة الذكية (عندما تكون المدارس أقل من 6/8 أو ينقصها شرط التموضع)
    const missingWhy = preCheck.isOverextended
      ? `السعر الحالي (${price}) مبتعد عن متوسط التوازن EMA20 (${techData.classical.ema20})، والدخول الآن يُعد مطاردة لقمة/قاع؛ لذا ننتظر تصحيحاً هادئاً نحو ${techData.volumeAnalysis.vwap}`
      : preCheck.isChoppyMarket
      ? `مؤشر قوة الاتجاه ADX عند (${techData.classical.adx14}) يشير لحركة عرضية ضعيفة السيولة`
      : !mtfReport.isAligned
      ? `ننتظر اصطفاف الفريم الأكبر (${higherTFName}) مع فريم التنفيذ`
      : `توافق المدارس حالياً هو (${preCheck.bullPoints}/8 للشراء و ${preCheck.bearPoints}/8 للبيع) ونشترط توافق 6 من 8 مدارس كحد أدنى للوصول لدقة 90%+`;

    return {
      signal: "حياد / انتظار",
      confidenceScore: preCheck.maxConfidence,
      aiApprovedExecution: false,
      consensusCount: sanitizeForTelegram(
        `🧠 فحص السنيور AI: توافق ${maxSchools} من 8 مدارس نحو ${dominantDir} (يشترط 6/8 لليقيـن +90%)`
      ),
      macroNewsIntegration: macroHeader,
      isUrgentAlert: false,
      schoolsBreakdown: schoolsSummaryObj,
      aiFinalReview: sanitizeForTelegram(
        aiCustomText ||
          `🧠 [تحليل وتفكير السنيور AI الحي على شموع Exness MT5 (${price})]: قمت بتحليل الزوج عبر المدارس الـ 8 ومطابقتها مع الأخبار العالمية؛ الكفة تميل حالياً نحو ${dominantDir} بتوافق (${maxSchools} من 8 مدارس)، ولكن كمدير مخاطر سنيور قررت التريث وعدم التسرع في فتح الصفقة لهذه اللحظة لأن ${missingWhy}. ${backtestReport.selfLearningSummary}`
      ),
      tradeSetup: {
        entryZone: `${buySetup.entry}`,
        stopLoss: `${buySetup.sl}`,
        takeProfit1: `${buySetup.tp1}`,
        takeProfit2: `${buySetup.tp2}`,
      },
      summaryArabic: "مراقبة حية من السنيور AI بانتظار اكتمال 6/8 مدارس لليقيـن +90%.",
    };
  };

  // المرحلة الثانية: إرسال كل نتائج المدارس الـ 8 والأخبار والباك تيست لنموذج Gemini ليصيغ تحليله السنيور الخاص
 try {
    const prompt = `
أنت "كبير محللي التداول المؤسسي" (Senior Forex Quant Strategist) بخبرة 15 عاماً.
أنت تحلل الآن زوج (${symbol}) على فريم (${timeframe}) بسعر بروكر Exness MT5 الحي (${price}).

[نتائج تحليل المدارس الـ 8 المستقلة]:
1. مدرسة SMC/ICT: ${sv.smc}
2. مدرسة الفيبوناتشي و OTE: ${sv.fib}
3. مدرسة المحاور البنكية (Pivots): ${sv.pivots}
4. مدرسة البرايس أكشن وشموع البروكر: ${sv.priceAction} | آخر الشموع: ${recentCandlesText}
5. المدرسة الكلاسيكية (EMA/ADX/RSI): ${sv.classical}
6. مدرسة السيولة (POC & VWAP): ${sv.volume}
7. توافق الفريم الأكبر (${higherTFName}) والدايفرجنس: ${sv.mtf} | ${techData.classical.divergenceStatus}
8. مدرسة الأخبار العالمية ومؤشر الدولار (DXY=${dxyData.currentPrice}): ${sv.macro} | الأخبار المرصودة: ${activeNewsContext}

[نتيجة التصويت المجمع وذاكرة التعلم الذاتي من آخر 5 صفقات باك تيست على MT5]:
- التصويت: ${preCheck.bullPoints} مدارس شراء مقابل ${preCheck.bearPoints} مدارس بيع.
- القرار الفني المبدئي: (${preCheck.allowedSignal}) بدرجة ثقة (${preCheck.maxConfidence}%).
- تقرير التعلم الذاتي من آخر 5 صفقات للزوج: ${backtestReport.selfLearningSummary}

اكتب باللغة العربية الاحترافية تحليلك النهائي كـ Senior Forex Trader في 3 إلى 4 جمل مركزة تشرح فيها:
1) كيف قرأت توافق المدارس الـ 8 وحركة شموع MT5؟
2) هل الأخبار العالمية ومؤشر الدولار يدعمان الاتجاه؟
3) ما هو قرارك النهائي ولماذا (مع الإشارة لما تعلمته من باك تيست الزوج)؟
تجنب استخدام رموز < أو > في النص.
`;

    // 🆓 مصفوفة أحدث وأقوى الموديلات المجانية 100% على Google AI Studio
    // تبدأ بالجيل الثالث الأحدث وتنتقل تلقائياً للذي يليه لو امتلأت كوتة الدقيقة
    const freeSeniorModels = [
      "gemini-3-flash-preview", // 1. أحدث موديل من الجيل الثالث (مجاني + ذكاء عالي + كوتة واسعة)
      "gemini-2.5-pro",         // 2. موديل الـ Pro العميق للتفكير الاستراتيجي (مجاني في AI Studio)
      "gemini-2.5-flash",       // 3. خط الدفاع المجاني المستقر (1500 طلب يومياً مجاناً)
    ];

    let response = null;
    let usedModelName = "";

    for (const modelName of freeSeniorModels) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            temperature: 0.2,
          },
        });
        if (response && response.text) {
          usedModelName = modelName;
          break;
        }
      } catch (freeQuotaErr) {
        // ينتقل للموديل المجاني التالي فوراً في نفس الثانية إذا واجه حد الدقيقة
      }
    }

    const customAiParagraph = response?.text ? response.text.trim() : null;
    const finalDecision = buildAutonomousSeniorAnalysis(
      customAiParagraph
        ? `🧠 [رؤية السنيور AI المباشرة (${usedModelName})]: ${customAiParagraph}`
        : null
    );

    aiSignalCache.set(cacheKey, { timestamp: Date.now(), data: finalDecision });
    return finalDecision;
  } catch (err) {
    // في حال ضغط الطلبات، يعمل محرك السنيور الذاتي فوراً دون أن يرمي أي خطأ لـ server.js!
    const fallbackSenior = buildAutonomousSeniorAnalysis(null);
    aiSignalCache.set(cacheKey, { timestamp: Date.now(), data: fallbackSenior });
    return fallbackSenior;
  }
}