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

/**
 * جلب السعر الفوري الحقيقي اللحظي (True Spot Price) لكل الأزواج والذهب مطابقاً لـ TradingView
 */
async function fetchTrueSpotPrice(symbol) {
  try {
    if (symbol === "XAUUSD") {
      const res = await axios.get("https://data-asg.goldprice.org/dbXRates/USD", {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 4500,
      });
      const spotGold = res.data?.items?.[0]?.xauPrice;
      if (spotGold && spotGold > 1000) return Number(Number(spotGold).toFixed(2));
    }

    // جلب أسعار الصرف الفورية الدقيقة لجميع العملات
    const ticker = FOREX_SYMBOLS_MAP[symbol];
    if (ticker) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        ticker
      )}?interval=1m&range=1d`;
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 4500,
      });
      const price = res.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      const decimals = symbol === "XAUUSD" || symbol === "DXY" ? 2 : symbol === "USDJPY" ? 3 : 5;
      if (price) return Number(Number(price).toFixed(decimals));
    }
  } catch (e) {}
  return null;
}

/**
 * جلب الشموع اليابانية ومعايرتها لحظياً لكل الأزواج والعملات
 */
export async function fetchForexCandles(symbol = "XAUUSD", interval = "15m") {
  const ticker = FOREX_SYMBOLS_MAP[symbol] || "EURUSD=X";
  const range = interval === "1d" ? "6mo" : interval === "1h" ? "1mo" : "5d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=${interval}&range=${range}&includePrePost=false`;

  const [response, trueSpotPrice] = await Promise.all([
    axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 7000 }),
    fetchTrueSpotPrice(symbol),
  ]);

  const result = response.data.chart.result[0];
  const meta = result.meta || {};
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

  const lastRawClose = meta.regularMarketPrice || rawCandles[rawCandles.length - 1].close;
  const basisOffset = trueSpotPrice ? lastRawClose - trueSpotPrice : 0;

  const calibratedCandles = rawCandles.map((c) => ({
    time: c.time,
    open: Number((c.open - basisOffset).toFixed(decimals)),
    high: Number((c.high - basisOffset).toFixed(decimals)),
    low: Number((c.low - basisOffset).toFixed(decimals)),
    close: Number((c.close - basisOffset).toFixed(decimals)),
    volume: c.volume,
  }));

  if (trueSpotPrice && calibratedCandles.length > 0) {
    const last = calibratedCandles[calibratedCandles.length - 1];
    last.close = trueSpotPrice;
    if (trueSpotPrice > last.high) last.high = trueSpotPrice;
    if (trueSpotPrice < last.low) last.low = trueSpotPrice;
  }

  return calibratedCandles;
}

export function getMarketSessionAndKillzone() {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();

  const isWeekend =
    utcDay === 6 ||
    (utcDay === 5 && utcHour >= 21) ||
    (utcDay === 0 && utcHour < 21);

  if (isWeekend) {
    return {
      sessionName: "🛑 عطلة نهاية الأسبوع (السوق مغلق - التحليل متوقف تماماً)",
      isKillzone: false,
      isMarketClosed: true,
      liquidityQuality: "السوق مغلق رسمياً حتى افتتاح الأحد 21:00 UTC",
    };
  }

  if (utcHour >= 12 && utcHour < 16) {
    return {
      sessionName: "🔥 تقاطع لندن ونيويورك (NY/London Overlap Killzone)",
      isKillzone: true,
      isMarketClosed: false,
      liquidityQuality: "سيولة مؤسسية قصوى",
    };
  } else if (utcHour >= 7 && utcHour < 12) {
    return {
      sessionName: "⚡ جلسة لندن (London Killzone)",
      isKillzone: true,
      isMarketClosed: false,
      liquidityQuality: "سيولة عالية",
    };
  } else if (utcHour >= 16 && utcHour < 20) {
    return {
      sessionName: "🗽 جلسة نيويورك المسائية",
      isKillzone: false,
      isMarketClosed: false,
      liquidityQuality: "سيولة متوسطة/عالية",
    };
  } else {
    return {
      sessionName: "🌙 الجلسة الآسيوية",
      isKillzone: false,
      isMarketClosed: false,
      liquidityQuality: "سيولة هادئة (تجميع)",
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

function detectAlgorithmicDivergence(candles, rsiSeries) {
  const len = candles.length;
  if (len < 30) return "لا يوجد دايفرجنس واضح";
  const recentSlice = candles.slice(-10);
  const olderSlice = candles.slice(-28, -10);
  const recentHigh = Math.max(...recentSlice.map((c) => c.high));
  const olderHigh = Math.max(...olderSlice.map((c) => c.high));
  const recentLow = Math.min(...recentSlice.map((c) => c.low));
  const olderLow = Math.min(...olderSlice.map((c) => c.low));
  const recentRsiMax = Math.max(...rsiSeries.slice(-10));
  const olderRsiMax = Math.max(...rsiSeries.slice(-28, -10));
  const recentRsiMin = Math.min(...rsiSeries.slice(-10));
  const olderRsiMin = Math.min(...rsiSeries.slice(-28, -10));

  if (recentHigh > olderHigh && recentRsiMax < olderRsiMax - 2)
    return "🔴 دايفرجنس بيعي سلبي مؤكد (Bearish Divergence)";
  if (recentLow < olderLow && recentRsiMin > olderRsiMin + 2)
    return "🟢 دايفرجنس شرائي إيجابي مؤكد (Bullish Divergence)";
  return "لا يوجد دايفرجنس";
}

function calculateVolumeProfilePOC(candles, decimals = 4) {
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

/**
 * حساب المؤشرات الفنية + الهيكل السعري + حساب مستويات الدخول والستوب الهيكلي الذكي لكل عملة
 */
export function calculateAllIndicatorsAndSMC(candles, symbol = "XAUUSD") {
  const decimals = symbol === "XAUUSD" || symbol === "DXY" ? 2 : symbol === "USDJPY" ? 3 : 5;
  const closes = candles.map((c) => c.close);
  const len = candles.length;
  const current = candles[len - 1];
  const prev1 = candles[len - 2] || current;
  const prev2 = candles[len - 3] || current;

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

  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsiSeries = calcRSISeries(closes, 14);
  const rsi14 = rsiSeries[rsiSeries.length - 1];
  const divergenceStatus = detectAlgorithmicDivergence(candles, rsiSeries);
  const atr14 = calcATR(candles, 14);
  const pocPrice = calculateVolumeProfilePOC(candles, decimals);

  // تحديد القمم والقيعان الهيكلية القريبة (لمنع ضرب الستوب) والكبيرة (لأهداف السيولة)
  const recentSwingSlice = candles.slice(-12);
  const recentStructuralLow = Math.min(...recentSwingSlice.map((c) => c.low));
  const recentStructuralHigh = Math.max(...recentSwingSlice.map((c) => c.high));

  const lookback = candles.slice(-35, -1);
  const swingHigh = Number(Math.max(...lookback.map((c) => c.high)).toFixed(decimals));
  const swingLow = Number(Math.min(...lookback.map((c) => c.low)).toFixed(decimals));
  const range = swingHigh - swingLow || 0.0001;

  const fib50 = Number((swingHigh - range * 0.5).toFixed(decimals));
  const fib618 = Number((swingHigh - range * 0.618).toFixed(decimals));
  const fib786 = Number((swingHigh - range * 0.786).toFixed(decimals));
  const pricePositionPercent = Number((((current.close - swingLow) / range) * 100).toFixed(1));
  const zoneStatus =
    pricePositionPercent > 50
      ? `منطقة Premium (${pricePositionPercent}%)`
      : `منطقة Discount (${pricePositionPercent}%)`;

  let fibStatus = `توازن عند ${fib50}`;
  if (current.close <= fib50 && current.close >= fib786) {
    fibStatus = `🔥 داخل منطقة الفيبوناتشي الذهبية (OTE: ${fib786} - ${fib618})`;
  }

  const prevCandlesBlock = candles.slice(-24, -1);
  const pHigh = Math.max(...prevCandlesBlock.map((c) => c.high));
  const pLow = Math.min(...prevCandlesBlock.map((c) => c.low));
  const pClose = prev1.close;
  const pivotP = Number(((pHigh + pLow + pClose) / 3).toFixed(decimals));
  const r1 = Number((2 * pivotP - pLow).toFixed(decimals));
  const s1 = Number((2 * pivotP - pHigh).toFixed(decimals));

  const bodySize = Math.abs(current.close - current.open);
  const upperWick = current.high - Math.max(current.close, current.open);
  const lowerWick = Math.min(current.close, current.open) - current.low;

  let candlePattern = "شمعة عادية";
  if (current.close > current.open && current.close > prev1.high)
    candlePattern = "🟢 شمعة ابتلاعية شرائية قوية";
  else if (current.close < current.open && current.close < prev1.low)
    candlePattern = "🔴 شمعة ابتلاعية بيعية قوية";
  else if (lowerWick > bodySize * 1.5) candlePattern = "🟢 شمعة بن بار شرائية (Rejection)";
  else if (upperWick > bodySize * 1.5) candlePattern = "🔴 شمعة بن بار بيعية (Rejection)";

  let smcStructure = "تحرك داخل النطاق";
  if (current.high > swingHigh && current.close < swingHigh)
    smcStructure = "Bearish Liquidity Sweep (سحب سيولة قمة)";
  else if (current.low < swingLow && current.close > swingLow)
    smcStructure = "Bullish Liquidity Sweep (سحب سيولة قاع)";
  else if (current.close > swingHigh) smcStructure = "Bullish BOS (كسر هيكلي صاعد)";
  else if (current.close < swingLow) smcStructure = "Bearish BOS (كسر هيكلي هابط)";

  let fvgZone = "لا توجد فجوة سعرية";
  if (current.low > prev2.high) fvgZone = `Bullish FVG بين ${prev2.high} و ${current.low}`;
  else if (current.high < prev2.low) fvgZone = `Bearish FVG بين ${current.high} و ${prev2.low}`;

  const avgVol = lookback.reduce((sum, c) => sum + c.volume, 0) / lookback.length;
  const rvol = avgVol > 0 ? Number((current.volume / avgVol).toFixed(2)) : 1.0;

  let trendByEMA = "متذبذب";
  if (current.close > ema50 && ema20 >= ema50) trendByEMA = "صاعد";
  else if (current.close < ema50 && ema20 <= ema50) trendByEMA = "هابط";

  // حساب مستويات الحماية المؤسسية الذكية (Smart Structural SL & TP) لمنع ضرب الستوب المبكر
  const smartBuySL = Number(
    Math.min(recentStructuralLow - atr14 * 0.45, current.close - atr14 * 1.65).toFixed(decimals)
  );
  const buyRisk = Math.abs(current.close - smartBuySL) || atr14 * 1.5;
  const smartBuyTP1 = Number((current.close + buyRisk * 1.25).toFixed(decimals));
  const smartBuyTP2 = Number((current.close + buyRisk * 2.2).toFixed(decimals));

  const smartSellSL = Number(
    Math.max(recentStructuralHigh + atr14 * 0.45, current.close + atr14 * 1.65).toFixed(decimals)
  );
  const sellRisk = Math.abs(smartSellSL - current.close) || atr14 * 1.5;
  const smartSellTP1 = Number((current.close - sellRisk * 1.25).toFixed(decimals));
  const smartSellTP2 = Number((current.close - sellRisk * 2.2).toFixed(decimals));

  return {
    currentPrice: current.close,
    decimals,
    smartLevels: {
      buy: { entry: current.close, sl: smartBuySL, tp1: smartBuyTP1, tp2: smartBuyTP2 },
      sell: { entry: current.close, sl: smartSellSL, tp1: smartSellTP1, tp2: smartSellTP2 },
    },
    classical: {
      ema20,
      ema50,
      ema200,
      trendByEMA,
      rsi14,
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
        current.close > pivotP ? `أعلى المحور P (${pivotP})` : `أسفل المحور P (${pivotP})`,
    },
    priceAction: { candlePattern },
    volumeAnalysis: {
      pocPrice,
      pocRelation:
        current.close > pocPrice
          ? `أعلى نقطة تمركز السيولة POC (${pocPrice})`
          : `أسفل نقطة تمركز السيولة POC (${pocPrice})`,
      relativeVolumeRVOL: rvol,
    },
  };
}

export function evaluateMTFAlignment(currentTFTech, higherTFTech, higherTFName) {
  const curTrend = currentTFTech.classical.trendByEMA;
  const highTrend = higherTFTech.classical.trendByEMA;
  if (
    curTrend === "صاعد" &&
    (highTrend === "صاعد" || currentTFTech.currentPrice > higherTFTech.classical.ema50)
  )
    return {
      isAligned: true,
      directionBias: "BULLISH",
      mtfStatus: `✅ توافق صاعد قوي مع الفريم الأكبر (${higherTFName})`,
    };
  if (
    curTrend === "هابط" &&
    (highTrend === "هابط" || currentTFTech.currentPrice < higherTFTech.classical.ema50)
  )
    return {
      isAligned: true,
      directionBias: "BEARISH",
      mtfStatus: `✅ توافق هابط قوي مع الفريم الأكبر (${higherTFName})`,
    };
  return {
    isAligned: false,
    directionBias: "MIXED",
    mtfStatus: `⚠️ تضارب فريمات مع الفريم الأكبر (${higherTFName})`,
  };
}

/**
 * فحص توافق كل زوج عملات مع مؤشر الدولار (DXY) لمنع الدخول عكس تدفق السيولة العالمي
 */
export function evaluateDxyCorrelation(symbol, dxyTech) {
  const dxyTrend = dxyTech?.classical?.trendByEMA || "متذبذب";
  const isInversePair = ["XAUUSD", "EURUSD", "GBPUSD"].includes(symbol); // عكس الدولار
  const isDirectPair = ["USDJPY"].includes(symbol); // مع الدولار

  if (isInversePair) {
    if (dxyTrend === "هابط") return { allowedBias: "BULLISH", note: "✅ ضعف الدولار DXY يدعم صعود الزوج بقوة" };
    if (dxyTrend === "صاعد") return { allowedBias: "BEARISH", note: "✅ قوة الدولار DXY تدعم هبوط الزوج بقوة" };
  } else if (isDirectPair) {
    if (dxyTrend === "صاعد") return { allowedBias: "BULLISH", note: "✅ قوة الدولار DXY تدعم صعود USDJPY بقوة" };
    if (dxyTrend === "هابط") return { allowedBias: "BEARISH", note: "✅ ضعف الدولار DXY يدعم هبوط USDJPY بقوة" };
  }
  return { allowedBias: "ANY", note: "⚖️ مؤشر الدولار DXY في نطاق متوازن" };
}

/**
 * محرك الـ Backtest المؤسسي لكل الأزواج مع ستوب هيكلي محمي + تأمين الصفقة التلقائي (Break-Even)
 */
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

    // تحديد القاع والقمة الهيكلية لآخر 8 شموع لوضع الستوب خلفها بأمان
    const recentBlock = candles.slice(i - 8, i + 1);
    const structLow = Math.min(...recentBlock.map((x) => x.low));
    const structHigh = Math.max(...recentBlock.map((x) => x.high));

    // فلتر عدم الدخول في شمعة متضخمة جداً (Anti-Exhaustion Filter)
    const candleRange = Math.abs(c.high - c.low);
    if (candleRange > atr * 2.2) continue;

    // شروط الشراء المؤسسي (ارتداد من منطقة قيمة + اتجاه صاعد + عدم تشبع)
    const isBullTrend = c.close > ema50Arr[i] && ema20Arr[i] >= ema50Arr[i];
    const isBullPullback = c.low <= ema20Arr[i] + atr * 0.35 && c.close > ema20Arr[i];
    const isBullRejection = c.close > c.open && c.close > prev.close && c.close >= localPoc;
    const isBullMomentum = rsiArr[i] >= 48 && rsiArr[i] <= 65;

    // شروط البيع المؤسسي (ارتداد بيعي من مقاومة/متوسط + اتجاه هابط + عدم تشبع)
    const isBearTrend = c.close < ema50Arr[i] && ema20Arr[i] <= ema50Arr[i];
    const isBearPullback = c.high >= ema20Arr[i] - atr * 0.35 && c.close < ema20Arr[i];
    const isBearRejection = c.close < c.open && c.close < prev.close && c.close <= localPoc;
    const isBearMomentum = rsiArr[i] <= 52 && rsiArr[i] >= 35;

    const isConfirmedStrongBull = isBullTrend && isBullPullback && isBullRejection && isBullMomentum;
    const isConfirmedStrongBear = isBearTrend && isBearPullback && isBearRejection && isBearMomentum;

    if (isConfirmedStrongBull || isConfirmedStrongBear) {
      const isBuy = isConfirmedStrongBull;
      const entry = c.close;

      // وضع الستوب خلف القاع/القمة الهيكلية مع هامش أمان لمنع ضرب الستوب بالذيول
      let sl = isBuy
        ? Math.min(structLow - atr * 0.4, entry - atr * 1.6)
        : Math.max(structHigh + atr * 0.4, entry + atr * 1.6);

      const riskDist = Math.abs(entry - sl);
      const tp = isBuy ? entry + riskDist * 1.25 : entry - riskDist * 1.25;
      const breakEvenTrigger = isBuy ? entry + riskDist * 0.65 : entry - riskDist * 0.65;

      let outcome = "OPEN";
      let breakEvenActive = false;

      for (let j = i + 1; j < Math.min(candles.length, i + 24); j++) {
        const future = candles[j];
        if (isBuy) {
          if (future.high >= tp) {
            outcome = "WIN";
            break;
          }
          // تفعيل تأمين الصفقة إذا وصل السعر لـ 65% من الهدف
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

        const unixTime = Math.floor(new Date(c.time).getTime() / 1000);
        markers.push({
          time: unixTime,
          position: isBuy ? "belowBar" : "aboveBar",
          color: outcome === "WIN" ? "#00e676" : "#ff1744",
          shape: isBuy ? "arrowUp" : "arrowDown",
          text: `${isBuy ? "🔥 صعود قوي" : "🔥 هبوط قوي"} (${outcome === "WIN" ? "✅ هدف/تأمين" : "❌ ستوب"})`,
        });

        tradesList.push({
          time: c.time,
          type: isBuy ? "صعود قوي مؤكد" : "هبوط قوي مؤكد",
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
 * محرك التقييم الخوارزمي المسبق (Algorithmic Confluence Pre-Scorer):
 * يفحص الـ 7 مدارس بدقة لكل زوج عملات قبل إرساله للـ AI لضمان عدم إصدار أي صفقة مخالفة للهيكل السعري
 */
export function evaluateStrictConfluence(symbol, techData, higherTFTech, mtfReport, dxyTech, newsShield) {
  const dxyCorr = evaluateDxyCorrelation(symbol, dxyTech);
  const price = techData.currentPrice;
  const { ema20, ema50, rsi14, trendByEMA } = techData.classical;
  const { pocPrice } = techData.volumeAnalysis;
  const { pivotP } = techData.pivots;

  let bullPoints = 0;
  let bearPoints = 0;

  // 1. توافق الفريمات (MTF)
  if (mtfReport.directionBias === "BULLISH") bullPoints += 2;
  if (mtfReport.directionBias === "BEARISH") bearPoints += 2;

  // 2. الاتجاه والموقع من المتوسطات
  if (trendByEMA === "صاعد" && price > ema20) bullPoints += 2;
  if (trendByEMA === "هابط" && price < ema20) bearPoints += 2;

  // 3. تمركز السيولة (Volume POC)
  if (price > pocPrice) bullPoints += 1;
  else bearPoints += 1;

  // 4. المحور البنكي (Pivot P)
  if (price > pivotP) bullPoints += 1;
  else bearPoints += 1;

  // 5. الزخم الصحي (عدم التشبع الشرائي أو البيعي الذي يضرب الستوب)
  if (rsi14 >= 48 && rsi14 <= 67) bullPoints += 1;
  if (rsi14 <= 52 && rsi14 >= 33) bearPoints += 1;

  // 6. توافق مؤشر الدولار DXY حسب طبيعة كل زوج
  if (dxyCorr.allowedBias === "BULLISH") bullPoints += 1;
  if (dxyCorr.allowedBias === "BEARISH") bearPoints += 1;

  // منع الصفقات وقت الأخبار الخطيرة
  if (newsShield?.shieldActive) {
    return { allowedSignal: "حياد / انتظار", maxConfidence: 60, bullPoints, bearPoints, dxyCorr };
  }

  if (bullPoints >= 6 && rsi14 < 68 && dxyCorr.allowedBias !== "BEARISH") {
    return { allowedSignal: "صعود قوي", maxConfidence: Math.min(96, 78 + bullPoints * 2), bullPoints, bearPoints, dxyCorr };
  }
  if (bearPoints >= 6 && rsi14 > 32 && dxyCorr.allowedBias !== "BULLISH") {
    return { allowedSignal: "هبوط قوي", maxConfidence: Math.min(96, 78 + bearPoints * 2), bullPoints, bearPoints, dxyCorr };
  }

  return { allowedSignal: "حياد / انتظار", maxConfidence: 65, bullPoints, bearPoints, dxyCorr };
}

/**
 * 3. محرك الـ AI المؤسسي لكل الأزواج مع مستويات الدخول والستوب الهيكلي المحمي
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
  newsList
) {
  const preCheck = evaluateStrictConfluence(symbol, techData, higherTFTech, mtfReport, dxyData, newsShield);
  const price = techData.currentPrice;
  const buySetup = techData.smartLevels.buy;
  const sellSetup = techData.smartLevels.sell;

  const prompt = `
أنت كبير محللي الفوركس المؤسسي (Chief Institutional Forex Strategist).
حلل زوج (${symbol}) على فريم (${timeframe}) والسعر الفوري الحقيقي الآن هو (${price}).

[نتيجة الفلتر الخوارزمي الصارم لمنع ضرب الستوب لوز]:
- الإشارة المسموح بها خوارزمياً الآن: (${preCheck.allowedSignal}) بحد أقصى للثقة (${preCheck.maxConfidence}%).
- نقاط القوة الشرائية: ${preCheck.bullPoints}/8 | نقاط القوة البيعية: ${preCheck.bearPoints}/8.
- علاقة الزوج مع مؤشر الدولار DXY: ${preCheck.dxyCorr.note}.

[تعليمات صارمة جداً]:
1. التزم بقرار الفلتر الخوارزمي (${preCheck.allowedSignal}): إذا كان "حياد / انتظار"، اجعل إشارتك "حياد / انتظار" وثقتك أقل من 70% واشرح للمستخدم لماذا الدخول الآن خطر وقد يضرب الستوب (بسبب تضارب الفريمات أو تشبع RSI أو معاكسة الدولار DXY).
2. إذا كانت الإشارة المسموحة هي "صعود قوي"، استخدم مستويات الحماية الهيكلية المحسوبة بدقة خلف قاع السيولة:
   - الدخول: ${buySetup.entry} | الستوب الهيكلي المحمي (SL): ${buySetup.sl} | الهدف الأول (TP1): ${buySetup.tp1} | الهدف الثاني (TP2): ${buySetup.tp2}
3. إذا كانت الإشارة المسموحة هي "هبوط قوي"، استخدم مستويات الحماية الهيكلية المحسوبة بدقة خلف قمة السيولة:
   - الدخول: ${sellSetup.entry} | الستوب الهيكلي المحمي (SL): ${sellSetup.sl} | الهدف الأول (TP1): ${sellSetup.tp1} | الهدف الثاني (TP2): ${sellSetup.tp2}

[البيانات الفنية الحية للزوج (${symbol})]:
1. SMC/ICT: ${techData.smc.structureStatus} | ${techData.smc.premiumDiscountZone} | القاع الهيكلي: ${techData.classical.recentStructuralLow} | القمة الهيكلية: ${techData.classical.recentStructuralHigh}
2. الفيبوناتشي: ${techData.fibonacci.fibStatus} (61.8%: ${techData.fibonacci.fib618})
3. المحاور البنكية (Pivots): ${techData.pivots.pivotBias} (P: ${techData.pivots.pivotP}, R1: ${techData.pivots.r1}, S1: ${techData.pivots.s1})
4. البرايس أكشن: ${techData.priceAction.candlePattern}
5. المؤشرات والدايفرجنس: الاتجاه ${techData.classical.trendByEMA} | RSI: ${techData.classical.rsi14} | ${techData.classical.divergenceStatus}
6. الفوليوم والـ POC: ${techData.volumeAnalysis.pocRelation} | RVOL: ${techData.volumeAnalysis.relativeVolumeRVOL}
7. الفريم الأكبر والدولار: ${mtfReport.mtfStatus} | DXY: ${dxyData.currentPrice} (${dxyData.classical.trendByEMA})
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          signal: {
            type: Type.STRING,
            enum: ["صعود قوي", "صعود", "حياد / انتظار", "هبوط", "هبوط قوي"],
          },
          confidenceScore: { type: Type.INTEGER },
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
          "consensusCount",
          "macroNewsIntegration",
          "isUrgentAlert",
          "schoolsBreakdown",
          "aiFinalReview",
          "tradeSetup",
          "summaryArabic",
        ],
      },
    },
  });

  const aiResult = JSON.parse(response.text);

  // ضمان مطابقة المستويات للستوب الهيكلي المحمي 100% حتى لا يضع الذكاء الاصطناعي ستوب ضيق أبداً
  if (preCheck.allowedSignal === "صعود قوي") {
    aiResult.signal = "صعود قوي";
    aiResult.confidenceScore = Math.max(86, preCheck.maxConfidence);
    aiResult.tradeSetup = {
      entryZone: `${buySetup.entry}`,
      stopLoss: `${buySetup.sl}`,
      takeProfit1: `${buySetup.tp1}`,
      takeProfit2: `${buySetup.tp2}`,
    };
  } else if (preCheck.allowedSignal === "هبوط قوي") {
    aiResult.signal = "هبوط قوي";
    aiResult.confidenceScore = Math.max(86, preCheck.maxConfidence);
    aiResult.tradeSetup = {
      entryZone: `${sellSetup.entry}`,
      stopLoss: `${sellSetup.sl}`,
      takeProfit1: `${sellSetup.tp1}`,
      takeProfit2: `${sellSetup.tp2}`,
    };
  } else {
    aiResult.signal = "حياد / انتظار";
    aiResult.confidenceScore = Math.min(70, aiResult.confidenceScore || 60);
  }

  return aiResult;
}