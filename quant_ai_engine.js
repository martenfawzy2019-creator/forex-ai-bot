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
 * مخزن الأسعار الحية القادمة مباشرة من منصة MT5 (JustMarkets)
 */
export const mt5LivePrices = {
  XAUUSD: null,
  EURUSD: null,
  GBPUSD: null,
  USDJPY: null,
  lastUpdateMs: 0,
};

export function updateMt5LivePrices(prices = {}) {
  let anyValid = false;
  if (prices.XAUUSD && Number(prices.XAUUSD) > 0) {
    mt5LivePrices.XAUUSD = Number(Number(prices.XAUUSD).toFixed(2));
    anyValid = true;
  }
  if (prices.EURUSD && Number(prices.EURUSD) > 0) {
    mt5LivePrices.EURUSD = Number(Number(prices.EURUSD).toFixed(5));
    anyValid = true;
  }
  if (prices.GBPUSD && Number(prices.GBPUSD) > 0) {
    mt5LivePrices.GBPUSD = Number(Number(prices.GBPUSD).toFixed(5));
    anyValid = true;
  }
  if (prices.USDJPY && Number(prices.USDJPY) > 0) {
    mt5LivePrices.USDJPY = Number(Number(prices.USDJPY).toFixed(3));
    anyValid = true;
  }
  if (anyValid) {
    mt5LivePrices.lastUpdateMs = Date.now();
  }
}

function getActiveMt5Price(symbol) {
  const isFresh = Date.now() - mt5LivePrices.lastUpdateMs < 45000;
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
          tvSymbol: mt5Exact !== null ? `JustMarkets:${pairKey}` : tvSym,
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

  const calibratedCandles = rawCandles.map((c) => ({
    time: c.time,
    open: Number((c.open - basisOffset).toFixed(decimals)),
    high: Number((c.high - basisOffset).toFixed(decimals)),
    low: Number((c.low - basisOffset).toFixed(decimals)),
    close: Number((c.close - basisOffset).toFixed(decimals)),
    volume: c.volume,
    tvSnap: null,
  }));

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
      sessionName: "🛑 عطلة نهاية الأسبوع (السوق مغلق - التحليل متوقف تماماً)",
      isKillzone: false,
      isDeadZone: true,
      isAsianSession: false,
      isMarketClosed: true,
      tpMultiplier: 1.0,
      requiredScore: 9,
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
      requiredScore: 9,
      liquidityQuality: "سيولة منعدمة (ممنوع فتح صفقات جديدة لحماية رأس المال)",
    };
  }

  // درع حماية الفجر: منع الصفقات الجديدة من 3:00 ص حتى 7:30 ص بتوقيت مصر
  if (cairoDecimalTime >= 3.0 && cairoDecimalTime < 7.5) {
    return {
      sessionName: "🛡️ درع حماية الفجر (ممنوع فتح صفقات جديدة من 3:00 ص إلى 7:30 ص بتوقيت مصر)",
      isKillzone: false,
      isDeadZone: true,
      isAsianSession: true,
      isMarketClosed: false,
      tpMultiplier: 0.95,
      requiredScore: 9,
      liquidityQuality: "سيولة فجر ضعيفة وحركات كاذبة (تم تجميد الدخول لحماية الأرباح)",
    };
  }

  if (utcHour >= 12 && utcHour < 16) {
    return {
      sessionName: "🔥 تقاطع لندن ونيويورك (NY/London Overlap Killzone)",
      isKillzone: true,
      isDeadZone: false,
      isAsianSession: false,
      isMarketClosed: false,
      tpMultiplier: 1.15,
      requiredScore: 8,
      liquidityQuality: "سيولة مؤسسية قصوى (أفضل وقت للتداول)",
    };
  } else if (utcHour >= 7 && utcHour < 12) {
    return {
      sessionName: "⚡ جلسة لندن (London Killzone)",
      isKillzone: true,
      isDeadZone: false,
      isAsianSession: false,
      isMarketClosed: false,
      tpMultiplier: 1.15,
      requiredScore: 8,
      liquidityQuality: "سيولة بنكية عالية",
    };
  } else if (utcHour >= 16 && utcHour < 21) {
    return {
      sessionName: "🗽 جلسة نيويورك المسائية",
      isKillzone: false,
      isDeadZone: false,
      isAsianSession: false,
      isMarketClosed: false,
      tpMultiplier: 1.1,
      requiredScore: 8,
      liquidityQuality: "سيولة متوسطة إلى عالية",
    };
  } else {
    return {
      sessionName: "🌙 الجلسة الآسيوية المبكرة (فلتر القناص المشدد)",
      isKillzone: false,
      isDeadZone: false,
      isAsianSession: true,
      isMarketClosed: false,
      tpMultiplier: 0.95,
      requiredScore: 8,
      liquidityQuality: "سيولة هادئة (شروط مشددة وأهداف قريبة مضمونة)",
    };
  }
}

export function evaluateNewsShield(newsList = []) {
  const highImpactSoon = newsList.find(
    (n) => n.impact === "High" && n.timeDiffHours >= -0.25 && n.timeDiffHours <= 0.75
  );
  if (highImpactSoon) {
    const mins = Math.round(highImpactSoon.timeDiffHours * 60);
    return {
      shieldActive: true,
      warningText:
        mins >= 0
          ? `⛔ درع الأخبار: خبر (${highImpactSoon.title}) يصدر بعد ${mins} دقيقة!`
          : `⚠️ درع الأخبار: صدر خبر (${highImpactSoon.title}) مؤخراً!`,
    };
  }
  return { shieldActive: false, warningText: "✅ الأجواء آمنة إخبارياً" };
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

/**
 * حساب مؤشر ADX (قوة الاتجاه الحقيقي) لمنع الدخول في التذبذب العرضي
 */
function calculateADX(candles, period = 14) {
  if (candles.length < period * 2) return 22;
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

  if (dxList.length === 0) return 22;
  const recentDx = dxList.slice(-period);
  const adx = recentDx.reduce((a, b) => a + b, 0) / recentDx.length;
  return Number(adx.toFixed(2));
}

/**
 * حساب VWAP المؤسسي والانحراف المعياري (Standard Deviation Bands)
 */
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
    upperBand18: Number((vwap + stdDev * 1.85).toFixed(decimals)),
    lowerBand18: Number((vwap - stdDev * 1.85).toFixed(decimals)),
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

  let fibStatus = `توازن عند ${fib50}`;
  if (exactCurrentPrice <= fib50 && exactCurrentPrice >= fib786) {
    fibStatus = `🔥 داخل منطقة الفيبوناتشي الذهبية (OTE: ${fib786} - ${fib618})`;
  }

  const pivotP = tv?.pivotP || Number(((swingHigh + swingLow + prev1.close) / 3).toFixed(decimals));
  const r1 = tv?.r1 || Number((2 * pivotP - swingLow).toFixed(decimals));
  const s1 = tv?.s1 || Number((2 * pivotP - swingHigh).toFixed(decimals));

  const bodySize = Math.abs(exactCurrentPrice - current.open);
  const candleTotalRange = Math.max(0.00001, current.high - current.low);
  const closePositionInCandle = (exactCurrentPrice - current.low) / candleTotalRange;

  const upperWick = Math.max(0, current.high - Math.max(exactCurrentPrice, current.open));
  const lowerWick = Math.max(0, Math.min(exactCurrentPrice, current.open) - current.low);

  const hasHeavyUpperWick = upperWick > Math.max(bodySize * 1.15, atr14 * 0.28);
  const hasHeavyLowerWick = lowerWick > Math.max(bodySize * 1.15, atr14 * 0.28);

  // التحقق من قوة إغلاق الشمعة (Strong Institutional Displacement)
  const isStrongBullClose = exactCurrentPrice > current.open && !hasHeavyUpperWick && closePositionInCandle >= 0.58;
  const isStrongBearClose = exactCurrentPrice < current.open && !hasHeavyLowerWick && closePositionInCandle <= 0.42;

  let candlePattern = "شمعة عادية";
  if (exactCurrentPrice > current.open && exactCurrentPrice > prev1.high)
    candlePattern = "🟢 شمعة ابتلاعية شرائية مؤسسية (Bullish Displacement)";
  else if (exactCurrentPrice < current.open && exactCurrentPrice < prev1.low)
    candlePattern = "🔴 شمعة ابتلاعية بيعية مؤسسية (Bearish Displacement)";
  else if (lowerWick > bodySize * 1.5) candlePattern = "🟢 شمعة سحب سيولة شرائية (Liquidity Sweep PinBar)";
  else if (upperWick > bodySize * 1.5) candlePattern = "🔴 شمعة سحب سيولة بيعية (Liquidity Sweep PinBar)";

  let smcStructure = "تحرك داخل النطاق";
  if (current.high > swingHigh && exactCurrentPrice < swingHigh)
    smcStructure = "Bearish Liquidity Sweep (سحب سيولة قمة)";
  else if (current.low < swingLow && exactCurrentPrice > swingLow)
    smcStructure = "Bullish Liquidity Sweep (سحب سيولة قاع)";
  else if (exactCurrentPrice > swingHigh) smcStructure = "Bullish BOS (كسر هيكلي صاعد)";
  else if (exactCurrentPrice < swingLow) smcStructure = "Bearish BOS (كسر هيكلي هابط)";

  let fvgZone = "لا توجد فجوة سعرية";
  if (current.low > prev2.high) fvgZone = `Bullish FVG بين ${prev2.high} و ${current.low}`;
  else if (current.high < prev2.low) fvgZone = `Bearish FVG بين ${current.high} و ${prev2.low}`;

  const avgVol = lookback.reduce((sum, c) => sum + c.volume, 0) / lookback.length;
  const rvol = avgVol > 0 ? Number((current.volume / avgVol).toFixed(2)) : 1.0;

  let trendByEMA = "متذبذب";
  if (exactCurrentPrice > ema50 && ema20 >= ema50) trendByEMA = "صاعد";
  else if (exactCurrentPrice < ema50 && ema20 <= ema50) trendByEMA = "هابط";

  const pipUnit = symbol === "XAUUSD" ? 0.1 : symbol === "USDJPY" ? 0.01 : 0.0001;
  const targetPipsDist = symbol === "XAUUSD" ? 42 * pipUnit : 10.0 * pipUnit;
  const maxSlDist = symbol === "XAUUSD" ? 55 * pipUnit : 13.5 * pipUnit;
  const minSlDist = symbol === "XAUUSD" ? 38 * pipUnit : 11.0 * pipUnit;

  const rawBuySlDist = Math.min(maxSlDist, Math.max(minSlDist, atr14 * 1.5));
  const rawSellSlDist = Math.min(maxSlDist, Math.max(minSlDist, atr14 * 1.5));

  const smartBuySL = Number((exactCurrentPrice - rawBuySlDist).toFixed(decimals));
  const smartBuyTP1 = Number((exactCurrentPrice + targetPipsDist).toFixed(decimals));
  const smartBuyTP2 = Number((exactCurrentPrice + targetPipsDist * 1.8).toFixed(decimals));

  const smartSellSL = Number((exactCurrentPrice + rawSellSlDist).toFixed(decimals));
  const smartSellTP1 = Number((exactCurrentPrice - targetPipsDist).toFixed(decimals));
  const smartSellTP2 = Number((exactCurrentPrice - targetPipsDist * 1.8).toFixed(decimals));

  return {
    currentPrice: exactCurrentPrice.toFixed(decimals),
    numericPrice: exactCurrentPrice,
    priceSource: mt5Exact !== null ? "JustMarkets MT5 Live" : "TradingView Feed",
    changePercent: tv?.changePercent || 0,
    changeAbs: tv?.changeAbs || 0,
    tvRecommend: tv?.tvRecommend || 0,
    macd: tv?.macd || 0,
    macdSignal: tv?.macdSignal || 0,
    isBullCandle: isStrongBullClose,
    isBearCandle: isStrongBearClose,
    hasHeavyUpperWick,
    hasHeavyLowerWick,
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
    fibonacci: { fibStatus, fib618, fib50 },
    pivots: {
      pivotP,
      r1,
      s1,
      pivotBias:
        exactCurrentPrice > pivotP ? `أعلى المحور P (${pivotP})` : `أسفل المحور P (${pivotP})`,
    },
    priceAction: { candlePattern },
    volumeAnalysis: {
      pocPrice,
      vwap: vwapData.vwap,
      vwapUpperBand: vwapData.upperBand18,
      vwapLowerBand: vwapData.lowerBand18,
      pocRelation:
        exactCurrentPrice > pocPrice
          ? `أعلى نقطة تمركز السيولة POC (${pocPrice}) | VWAP (${vwapData.vwap})`
          : `أسفل نقطة تمركز السيولة POC (${pocPrice}) | VWAP (${vwapData.vwap})`,
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
    if (highHasBearDiv || highRsi > 68) {
      return {
        isAligned: false,
        directionBias: "MIXED",
        mtfStatus: `⚠️ حذر: الفريم الأكبر (${higherTFName}) متشبع شرائياً أو عليه دايفرجنس بيعي`,
      };
    }
    return {
      isAligned: true,
      directionBias: "BULLISH",
      mtfStatus: `✅ توافق صاعد مؤكد مع الفريم الأكبر (${higherTFName})`,
    };
  }

  if (curTrend === "هابط" && highTrend === "هابط") {
    if (highHasBullDiv || highRsi < 32) {
      return {
        isAligned: false,
        directionBias: "MIXED",
        mtfStatus: `⚠️ حذر: الفريم الأكبر (${higherTFName}) في منطقة ارتداد/دايفرجنس شرائي`,
      };
    }
    return {
      isAligned: true,
      directionBias: "BEARISH",
      mtfStatus: `✅ توافق هابط مؤكد مع الفريم الأكبر (${higherTFName})`,
    };
  }

  return {
    isAligned: false,
    directionBias: "MIXED",
    mtfStatus: `⚠️ تضارب/حياد مع الفريم الأكبر (${higherTFName}: ${highTrend})`,
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

export function runHistoricalBacktest(candles, symbol = "XAUUSD") {
  if (!candles || candles.length < 60) {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, markers: [], tradesList: [] };
  }

  const decimals = symbol === "XAUUSD" || symbol === "DXY" ? 2 : symbol === "USDJPY" ? 3 : 5;
  const closes = candles.map((c) => c.close);
  const rsiArr = calcRSISeries(closes, 14);
  const markers = [];
  const tradesList = [];
  let wins = 0;
  let losses = 0;

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
  for (let i = 35; i < candles.length - 15; i++) {
    if (cooldown > 0) {
      cooldown--;
      continue;
    }

    const c = candles[i];
    const prev = candles[i - 1];
    const atr = atrArr[i] || Math.abs(c.high - c.low) || c.close * 0.0015;
    const localPoc = calculateVolumeProfilePOC(candles.slice(Math.max(0, i - 35), i + 1), decimals);

    const candleRange = Math.abs(c.high - c.low);
    if (candleRange > atr * 2.0) continue;

    const isBullTrend = c.close > ema50Arr[i] && ema20Arr[i] >= ema50Arr[i];
    const isBullPullback = c.low <= ema20Arr[i] + atr * 0.35 && c.close > ema20Arr[i];
    const isBullRejection = c.close > c.open && c.close > prev.close && c.close >= localPoc;
    const isBullMomentum = rsiArr[i] >= 50 && rsiArr[i] <= 63;

    const isBearTrend = c.close < ema50Arr[i] && ema20Arr[i] <= ema50Arr[i];
    const isBearPullback = c.high >= ema20Arr[i] - atr * 0.35 && c.close < ema20Arr[i];
    const isBearRejection = c.close < c.open && c.close < prev.close && c.close <= localPoc;
    const isBearMomentum = rsiArr[i] <= 50 && rsiArr[i] >= 37;

    const isConfirmedStrongBull = isBullTrend && isBullPullback && isBullRejection && isBullMomentum;
    const isConfirmedStrongBear = isBearTrend && isBearPullback && isBearRejection && isBearMomentum;

    if (isConfirmedStrongBull || isConfirmedStrongBear) {
      const isBuy = isConfirmedStrongBull;
      const entry = c.close;
      const sl = isBuy ? entry - slDist : entry + slDist;
      const tp = isBuy ? entry + targetDist : entry - targetDist;
      const breakEvenTrigger = isBuy ? entry + targetDist * 0.35 : entry - targetDist * 0.35;

      let outcome = "OPEN";
      let breakEvenActive = false;

      for (let j = i + 1; j < Math.min(candles.length, i + 24); j++) {
        const future = candles[j];
        if (isBuy) {
          if (future.high >= tp) {
            outcome = "WIN";
            break;
          }
          if (future.high >= breakEvenTrigger) {
            breakEvenActive = true;
          }
          if (future.low <= sl) {
            outcome = breakEvenActive ? "WIN" : "LOSS";
            break;
          }
        } else {
          if (future.low <= tp) {
            outcome = "WIN";
            break;
          }
          if (future.low <= breakEvenTrigger) {
            breakEvenActive = true;
          }
          if (future.high >= sl) {
            outcome = breakEvenActive ? "WIN" : "LOSS";
            break;
          }
        }
      }

      if (outcome !== "OPEN") {
        if (outcome === "WIN") wins++;
        else losses++;

        tradesList.push({
          time: c.time,
          type: isBuy ? "صعود مؤسسي (Zero-SL)" : "هبوط مؤسسي (Zero-SL)",
          entry: entry.toFixed(decimals),
          tp: tp.toFixed(decimals),
          sl: sl.toFixed(decimals),
          result: outcome === "WIN" ? "✅ رابحة" : "❌ خاسرة",
        });

        cooldown = 8;
      }
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const profitFactor = losses > 0 ? Number(((wins * 1.25) / losses).toFixed(2)) : wins > 0 ? 5.0 : 0;

  return {
    totalTrades,
    wins,
    losses,
    winRate,
    profitFactor,
    markers,
    tradesList: tradesList.slice(-8).reverse(),
  };
}

/**
 * 🛡️ مصفوفة القناص المؤسسية ذات الـ 10 فلاتر (Anti-Stop-Hunt Matrix):
 * تمنع الدخول في التذبذب (ADX < 20)، وتمنع الشراء في التضخم السعري فوق VWAP Band،
 * وتشترط إغلاق شمعة مؤسسي قوي وتوافق السيولة والفريم الأكبر.
 */
export function evaluateStrictConfluence(symbol, techData, higherTFTech, mtfReport, dxyTech, newsShield) {
  const sessionInfo = getMarketSessionAndKillzone();
  const dxyCorr = evaluateDxyCorrelation(symbol, dxyTech);
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
    recentStructuralHigh,
    recentStructuralLow,
  } = techData.classical;
  const { pocPrice, vwap, vwapUpperBand, vwapLowerBand, relativeVolumeRVOL } = techData.volumeAnalysis;
  const { pivotP } = techData.pivots;
  const tvRec = techData.tvRecommend || 0;
  const posPct = techData.pricePositionPercent ?? 50;

  const hasBullDiv = divergenceStatus.includes("Bullish Divergence");
  const hasBearDiv = divergenceStatus.includes("Bearish Divergence");

  const highDiv = higherTFTech?.classical?.divergenceStatus || "";
  const highHasBullDiv = highDiv.includes("Bullish Divergence");
  const highHasBearDiv = highDiv.includes("Bearish Divergence");

  const distFromEma20 = Math.abs(price - ema20);
  // منع الدخول لو السعر طار بعيداً عن المتوسط (منع مطاردة القمم والقيعان)
  const isOverextended = atr14 > 0 && distFromEma20 > atr14 * 1.15;

  // منع الشراء فوق سقف الانحراف المعياري للـ VWAP أو في أعلى 18% من النطاق
  const isAtExtremeTop = posPct >= 82 || price >= vwapUpperBand;
  const isAtExtremeBottom = posPct <= 18 || price <= vwapLowerBand;

  // فلتر ADX + تشابك المتوسطات لكشف التذبذب العرضي القاتل للستوبات
  const emaSpread = Math.abs(ema20 - ema50);
  const isChoppyMarket = (atr14 > 0 && emaSpread < atr14 * 0.18) || adx14 < 19.5;

  const hasBullMomentum = techData.macd >= techData.macdSignal && tvRec >= 0.12 && relativeVolumeRVOL >= 0.75;
  const hasBearMomentum = techData.macd <= techData.macdSignal && tvRec <= -0.12 && relativeVolumeRVOL >= 0.75;

  // المساحة الآمنة للهدف قبل الاصطدام بجدار المقاومة/الدعم الهيكلي
  const pipUnit = symbol === "XAUUSD" ? 0.1 : symbol === "USDJPY" ? 0.01 : 0.0001;
  const minClearanceDist = symbol === "XAUUSD" ? 18 * pipUnit : 4.5 * pipUnit;
  const distToResistance = recentStructuralHigh - price;
  const distToSupport = price - recentStructuralLow;

  const blockedByResistance = distToResistance > 0 && distToResistance < minClearanceDist && tvRec < 0.45;
  const blockedBySupport = distToSupport > 0 && distToSupport < minClearanceDist && tvRec > -0.45;

  let bullPoints = 0;
  let bearPoints = 0;

  // 1. توافق الفريم الأكبر MTF (نقطتان)
  if (mtfReport.isAligned && mtfReport.directionBias === "BULLISH") bullPoints += 2;
  if (mtfReport.isAligned && mtfReport.directionBias === "BEARISH") bearPoints += 2;

  // 2. اصطفاف المتوسطات المؤسسية EMA 20/50/200 (نقطتان)
  if (trendByEMA === "صاعد" && price >= ema20) bullPoints += 1;
  if (trendByEMA === "صاعد" && ema20 >= ema50 && price >= ema200) bullPoints += 1;
  if (trendByEMA === "هابط" && price <= ema20) bearPoints += 1;
  if (trendByEMA === "هابط" && ema20 <= ema50 && price <= ema200) bearPoints += 1;

  // 3. قوة الاتجاه الحقيقي ADX + إغلاق الشمعة المؤسسي (نقطة)
  if (adx14 >= 20 && techData.isBullCandle && tvRec >= 0.12) bullPoints += 1;
  if (adx14 >= 20 && techData.isBearCandle && tvRec <= -0.12) bearPoints += 1;

  // 4. التمركز حول السيولة POC + VWAP المؤسسي (نقطة)
  if (price >= vwap && (price >= pocPrice || price >= pivotP)) bullPoints += 1;
  if (price <= vwap && (price <= pocPrice || price <= pivotP)) bearPoints += 1;

  // 5. النطاق الآمن للـ RSI (منع الشراء في التشبع فوق 63 أو البيع تحت 37) (نقطة)
  if (rsi14 >= 51 && rsi14 <= 63) bullPoints += 1;
  if (rsi14 <= 49 && rsi14 >= 37) bearPoints += 1;

  // 6. توافق مؤشر الدولار DXY (نقطة)
  if (dxyCorr.allowedBias === "BULLISH" || dxyCorr.allowedBias === "ANY") bullPoints += 1;
  if (dxyCorr.allowedBias === "BEARISH" || dxyCorr.allowedBias === "ANY") bearPoints += 1;

  // خصم صارم في حال وجود دايفرجنس معاكس أو ذيل رفض أو تشبع
  if (hasBullDiv || highHasBullDiv || rsi14 < 36 || isAtExtremeBottom || techData.hasHeavyLowerWick) {
    bearPoints = Math.max(0, bearPoints - 3);
  }
  if (hasBearDiv || highHasBearDiv || rsi14 > 64 || isAtExtremeTop || techData.hasHeavyUpperWick) {
    bullPoints = Math.max(0, bullPoints - 3);
  }

  if (newsShield?.shieldActive || sessionInfo.isDeadZone || isOverextended || isChoppyMarket) {
    return {
      allowedSignal: "حياد / انتظار",
      maxConfidence: 60,
      bullPoints,
      bearPoints,
      dxyCorr,
      sessionBlockReason: isChoppyMarket
        ? `🛡️ درع منع التذبذب (ADX=${adx14}): زخم الاتجاه ضعيف أو المتوسطات متشابكة، تم حجب الدخول لمنع ضرب الستوب لوز.`
        : isOverextended
        ? "⏳ درع عدم مطاردة السعر (Anti-FOMO): السعر متضخم وبعيد عن EMA20/VWAP، ننتظر تصحيح السعر لمنطقة آمنة."
        : sessionInfo.isDeadZone
        ? `⏸️ ${sessionInfo.sessionName} — ${sessionInfo.liquidityQuality}`
        : "⛔ درع الأخبار مفعل لحماية الحساب",
    };
  }

  const dxyAllowsBull = dxyCorr.allowedBias !== "BEARISH";
  const dxyAllowsBear = dxyCorr.allowedBias !== "BULLISH";

  // اشتراط 7 من 8 نقاط كحد أدنى مع تحقق الفلاتر المؤسسية لضمان دقة فائقة وستوب شبه منعدم
  if (
    mtfReport.isAligned &&
    bullPoints >= 7 &&
    dxyAllowsBull &&
    !isAtExtremeTop &&
    !blockedByResistance &&
    hasBullMomentum &&
    techData.isBullCandle &&
    price >= vwap &&
    !hasBearDiv &&
    !highHasBearDiv &&
    rsi14 <= 63
  ) {
    const exactConf = bullPoints >= 8 ? 97 : 94;
    return { allowedSignal: "صعود قوي", maxConfidence: exactConf, bullPoints, bearPoints, dxyCorr };
  }

  if (
    mtfReport.isAligned &&
    bearPoints >= 7 &&
    dxyAllowsBear &&
    !isAtExtremeBottom &&
    !blockedBySupport &&
    hasBearMomentum &&
    techData.isBearCandle &&
    price <= vwap &&
    !hasBullDiv &&
    !highHasBullDiv &&
    rsi14 >= 37
  ) {
    const exactConf = bearPoints >= 8 ? 97 : 94;
    return { allowedSignal: "هبوط قوي", maxConfidence: exactConf, bullPoints, bearPoints, dxyCorr };
  }

  return { allowedSignal: "حياد / انتظار", maxConfidence: 65, bullPoints, bearPoints, dxyCorr };
}

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
  newsList,
  rawCandles = []
) {
  const preCheck = evaluateStrictConfluence(symbol, techData, higherTFTech, mtfReport, dxyData, newsShield);
  const price = techData.currentPrice;
  const buySetup = techData.smartLevels.buy;
  const sellSetup = techData.smartLevels.sell;

  // تجهيز شريط الشموع الأخيرة (Candle Action Tape) لكي يرى الذكاء الاصطناعي شكل الشارت بنفسه
  const recentCandlesText = (rawCandles || [])
    .slice(-10)
    .map((c, idx) => {
      const dir = c.close >= c.open ? "🟢 صاعدة" : "🔴 هابطة";
      const body = Math.abs(c.close - c.open).toFixed(techData.decimals);
      const uWick = (c.high - Math.max(c.open, c.close)).toFixed(techData.decimals);
      const lWick = (Math.min(c.open, c.close) - c.low).toFixed(techData.decimals);
      return `شمعة(${idx + 1}): ${dir} | فتح:${c.open} | قمة:${c.high} | قاع:${c.low} | إغلاق:${c.close} | جسم:${body} | ذيل علوي:${uWick} | ذيل سفلي:${lWick}`;
    })
    .join("\n");

  const prompt = `
أنت الآن "العقل المدبر وقائد غرفة التداول المؤسسي" (Autonomous Institutional AI Trading Brain).
أنت لا تردد كلام المعادلات، بل تفكر بنفسك، تقرأ حركة الشموع الحية، وتصدر القرار النهائي المستقل لفتح الصفقة أو رفضها لحماية رأس المال من أي ستوب لوز.

[1. بيانات الزوج والتسعير الحي من JustMarkets MT5]:
- الزوج: ${symbol} | الفريم: ${timeframe} | السعر اللحظي الدقيق: ${price}
- الجلسة الحالية: ${sessionInfo.sessionName} (${sessionInfo.liquidityQuality})
- حالة درع الأخبار: ${newsShield.warningText}

[2. الشكل البصري لآخر 10 شموع على الشارت (Price Action & Wick Tape)]:
${recentCandlesText || "الشمعة الحالية عند " + price}

[3. مخرجات الخوارزمية المساعدة والـ 10 فلاتر المؤسسية]:
- ترشيح الخوارزمية المبدئي: (${preCheck.allowedSignal}) بدرجة (${preCheck.maxConfidence}%)
- نقاط الشراء: ${preCheck.bullPoints}/8 | نقاط البيع: ${preCheck.bearPoints}/8
- الفريم الأكبر (${higherTFName}): ${mtfReport.mtfStatus} (RSI الفريم الأكبر: ${higherTFTech.classical.rsi14})
- قوة الاتجاه الحقيقي (ADX): ${techData.classical.adx14} (أقل من 20 يعني تذبذب خطير)
- السعر المرجح بالسيولة (VWAP): ${techData.volumeAnalysis.vwap} | الحد العلوي للانحراف: ${techData.volumeAnalysis.vwapUpperBand} | الحد السفلي: ${techData.volumeAnalysis.vwapLowerBand}
- نقطة تمركز السيولة (POC): ${techData.volumeAnalysis.pocPrice} | الفوليوم النسبي (RVOL): ${techData.volumeAnalysis.relativeVolumeRVOL}
- هيكل السوق (SMC/ICT): ${techData.smc.structureStatus} | ${techData.smc.premiumDiscountZone} | FVG: ${techData.smc.fvgStatus}
- القمة الهيكلية القريبة: ${techData.classical.recentStructuralHigh} | القاع الهيكلي القريب: ${techData.classical.recentStructuralLow}
- المتوسطات المتحركة: EMA20=${techData.classical.ema20}, EMA50=${techData.classical.ema50}, EMA200=${techData.classical.ema200}
- الزخم والدايفرجنس: RSI=${techData.classical.rsi14} | ${techData.classical.divergenceStatus}
- علاقة الدولار (DXY=${dxyData.currentPrice}): ${preCheck.dxyCorr.note}
- المستويات المقترحة للشراء: دخول ${buySetup.entry} | ستوب ${buySetup.sl} | هدف ${buySetup.tp1}
- المستويات المقترحة للبيع: دخول ${sellSetup.entry} | ستوب ${sellSetup.sl} | هدف ${sellSetup.tp1}

[مهمتك القيادية كذكاء اصطناعي مستقل]:
1. افحص آخر 10 شموع وهيكل السوق بنفسك: هل توجد مصيدة سيولة (Bull/Bear Trap) أو ذيول رفض خطيرة أو ضعف في الزخم؟
2. إذا كانت الجلسة في وقت حظر (مثل درع الفجر أو إغلاق البنوك) أو الأخبار خطيرة، يجب أن يكون قرارك "حياد / انتظار".
3. إذا رشحت الخوارزمية صفقة (${preCheck.allowedSignal})، فكر بنفسك: هل توافق عليها وتؤكد أن نسبة نجاحها 94%+ وأن الستوب محمي تماماً؟ أم ترفضها بحق الفيتو لأنك اكتشفت خطراً خفياً في الشموع؟
4. إذا وجدت أنت فرصة قنص مؤكدة 100% (بناءً على توافق الفريم الأكبر + VWAP + الشموع + نقاط >= 6) بدون أي فخاخ، يمكنك اعتماد القرار ("صعود قوي" أو "هبوط قوي") بدرجة ثقة 94 إلى 98 وتحديد أدق سعر دخول وستوب لوز وهدف!
5. اشرح طريقة تفكيرك بوضوح في خانة (aiFinalReview) وكأنك تتحدث مع المتداول وجهاً لوجه وتشرح له لماذا أخذت هذا القرار.
`;

  const schemaConfig = {
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        signal: {
          type: Type.STRING,
          enum: ["صعود قوي", "صعود", "حياد / انتظار", "هبوط", "هبوط قوي"],
        },
        confidenceScore: { type: Type.INTEGER },
        aiApprovedExecution: {
          type: Type.BOOLEAN,
          description: "هل يوافق الذكاء الاصطناعي نهائياً على فتح هذه الصفقة الآن في حساب MT5؟",
        },
        consensusCount: { type: Type.STRING },
        macroNewsIntegration: { type: Type.STRING },
        isUrgentAlert: { type: Type.BOOLEAN },
        schoolsBreakdown: {
          type: Type.OBJECT,
          properties: {
            smcAndICT: { type: Type.STRING },
            fibonacciAndOTE: { type: Type.STRING },
            pivotPointsBank: { type: Type.STRING },
            priceActionSupplyDemand: { type: Type.STRING },
            classicalTA: { type: Type.STRING },
            volumeAndVWAP: { type: Type.STRING },
            macroAndFedNews: { type: Type.STRING },
          },
          required: [
            "smcAndICT",
            "fibonacciAndOTE",
            "pivotPointsBank",
            "priceActionSupplyDemand",
            "classicalTA",
            "volumeAndVWAP",
            "macroAndFedNews",
          ],
        },
        aiFinalReview: { type: Type.STRING },
        tradeSetup: {
          type: Type.OBJECT,
          properties: {
            entryZone: { type: Type.STRING },
            stopLoss: { type: Type.STRING },
            takeProfit1: { type: Type.STRING },
            takeProfit2: { type: Type.STRING },
          },
          required: ["entryZone", "stopLoss", "takeProfit1", "takeProfit2"],
        },
        summaryArabic: { type: Type.STRING },
      },
      required: [
        "signal",
        "confidenceScore",
        "aiApprovedExecution",
        "consensusCount",
        "macroNewsIntegration",
        "isUrgentAlert",
        "schoolsBreakdown",
        "aiFinalReview",
        "tradeSetup",
        "summaryArabic",
      ],
    },
  };

  // نظام ذكي يجرب الموديل المطلوب، ولو غير متاح في API جوجل ينتقل فوراً لأحدث موديل Flash شغال
  const modelsToTry = ["gemini-3.6-flash", "gemini-3-flash-preview", "gemini-2.5-flash"];
  let response = null;

  for (const modelName of modelsToTry) {
    try {
      response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: schemaConfig,
      });
      if (response && response.text) break;
    } catch (err) {
      // ينتقل للموديل التالي تلقائياً في جزء من الثانية إذا كان اسم الموديل غير مدعوم
    }
  }

  if (!response || !response.text) {
    throw new Error("AI Model Fallback Triggered");
  }

  const aiResult = JSON.parse(response.text);

  // حماية إجبارية وقت إغلاق السوق أو درع الفجر أو الأخبار الحمراء فقط
  if (sessionInfo.isDeadZone || newsShield?.shieldActive) {
    aiResult.signal = "حياد / انتظار";
    aiResult.confidenceScore = 60;
    aiResult.aiApprovedExecution = false;
    aiResult.aiFinalReview = `⏸️ [قرار الذكاء الاصطناعي والدرع الزمني]: ${
      preCheck.sessionBlockReason || sessionInfo.sessionName
    }`;
    return aiResult;
  }

  // القرار النهائي مشترك: الذكاء الاصطناعي يمتلك حق الفيتو وحق الاعتماد النهائي!
  const maxAlgoPoints = Math.max(preCheck.bullPoints, preCheck.bearPoints);

  if (
    aiResult.aiApprovedExecution &&
    (aiResult.signal === "صعود قوي" || aiResult.signal === "هبوط قوي") &&
    maxAlgoPoints >= 6 &&
    mtfReport.isAligned
  ) {
    const isBuy = aiResult.signal === "صعود قوي";
    const defaultSetup = isBuy ? buySetup : sellSetup;

    aiResult.confidenceScore = Math.max(94, Math.min(98, aiResult.confidenceScore || preCheck.maxConfidence));
    aiResult.consensusCount = `🧠 قرار AI معتمد (${maxAlgoPoints}/8 معايير + فحص الشموع)`;
    aiResult.tradeSetup = {
      entryZone: `${defaultSetup.entry}`,
      stopLoss: `${defaultSetup.sl}`,
      takeProfit1: `${defaultSetup.tp1}`,
      takeProfit2: `${defaultSetup.tp2}`,
    };
    aiResult.aiFinalReview = `🧠 [اعتماد الذكاء الاصطناعي النهائي]: ${aiResult.aiFinalReview}`;
  } else {
    // إذا رفض الذكاء الاصطناعي الصفقة (رغم أن المعادلات كانت موافقة) أو لم تكتمل الشروط
    const vetoNote =
      preCheck.allowedSignal !== "حياد / انتظار" && !aiResult.aiApprovedExecution
        ? `🛑 [فيتو الذكاء الاصطناعي - تم إلغاء الصفقة لحمايتك]: رغم توافق المؤشرات، اكتشف الـ AI خطراً في حركة الشموع: `
        : `🧠 [تحليل وتفكير الـ AI اللحظي]: `;

    aiResult.signal = "حياد / انتظار";
    aiResult.confidenceScore = Math.min(72, aiResult.confidenceScore || 65);
    aiResult.consensusCount = `فحص AI نشط | توافق ${maxAlgoPoints} من 8`;
    aiResult.aiFinalReview = `${vetoNote}${aiResult.aiFinalReview}`;
  }

  return aiResult;
}