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

export async function fetchForexCandles(symbol = "XAUUSD", interval = "15m") {
  const ticker = FOREX_SYMBOLS_MAP[symbol] || "GC=F";
  const range = interval === "1d" ? "6mo" : interval === "1h" ? "1mo" : "5d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=${interval}&range=${range}`;

  const response = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const result = response.data.chart.result[0];
  const timestamps = result.timestamp || [];
  const quote = result.indicators.quote[0];

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quote.close[i] !== null && quote.open[i] !== null) {
      candles.push({
        time: new Date(timestamps[i] * 1000).toISOString(),
        open: Number(quote.open[i].toFixed(4)),
        high: Number(quote.high[i].toFixed(4)),
        low: Number(quote.low[i].toFixed(4)),
        close: Number(quote.close[i].toFixed(4)),
        volume: quote.volume[i] || 1,
      });
    }
  }
  return candles;
}

/**
 * 1. فحص عطلة نهاية الأسبوع وإيقاف التحليل تماماً وقت الإغلاق
 */
export function getMarketSessionAndKillzone() {
  const now = new Date();
  const utcDay = now.getUTCDay(); // 0 = الأحد, 5 = الجمعة, 6 = السبت
  const utcHour = now.getUTCHours();

  // سوق الفوركس يغلق من الجمعة 21:00 UTC حتى الأحد 21:00 UTC
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
  for (let idx = period; idx < closes.length; idx++) {
    let gains = 0,
      losses = 0;
    for (let i = idx - period + 1; i <= idx; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    rsiArr[idx] = Number((100 - 100 / (1 + rs)).toFixed(2));
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

function calculateVolumeProfilePOC(candles) {
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
  return Number((minP + (maxVolIdx + 0.5) * step).toFixed(4));
}

export function calculateAllIndicatorsAndSMC(candles) {
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
    return Number(ema.toFixed(4));
  };

  const calcATR = (cList, period = 14) => {
    let trSum = 0;
    for (let i = cList.length - period; i < cList.length; i++) {
      const tr = Math.max(
        cList[i].high - cList[i].low,
        Math.abs(cList[i].high - cList[i - 1].close),
        Math.abs(cList[i].low - cList[i - 1].close)
      );
      trSum += tr;
    }
    return Number((trSum / period).toFixed(4));
  };

  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsiSeries = calcRSISeries(closes, 14);
  const rsi14 = rsiSeries[rsiSeries.length - 1];
  const divergenceStatus = detectAlgorithmicDivergence(candles, rsiSeries);
  const atr14 = calcATR(candles, 14);
  const pocPrice = calculateVolumeProfilePOC(candles);

  const lookback = candles.slice(-35, -1);
  const swingHigh = Math.max(...lookback.map((c) => c.high));
  const swingLow = Math.min(...lookback.map((c) => c.low));
  const range = swingHigh - swingLow || 0.0001;

  const fib50 = Number((swingHigh - range * 0.5).toFixed(4));
  const fib618 = Number((swingHigh - range * 0.618).toFixed(4));
  const fib786 = Number((swingHigh - range * 0.786).toFixed(4));
  const pricePositionPercent = Number((((current.close - swingLow) / range) * 100).toFixed(1));
  const zoneStatus =
    pricePositionPercent > 50
      ? `منطقة Premium (${pricePositionPercent}%)`
      : `منطقة Discount (${pricePositionPercent}%)`;

  let fibStatus = `توازن عند ${fib50}`;
  if (current.close <= fib618 && current.close >= fib786) {
    fibStatus = `🔥 داخل منطقة الفيبوناتشي الذهبية (OTE: ${fib786} - ${fib618})`;
  }

  const prevCandlesBlock = candles.slice(-24, -1);
  const pHigh = Math.max(...prevCandlesBlock.map((c) => c.high));
  const pLow = Math.min(...prevCandlesBlock.map((c) => c.low));
  const pClose = prev1.close;
  const pivotP = Number(((pHigh + pLow + pClose) / 3).toFixed(4));
  const r1 = Number((2 * pivotP - pLow).toFixed(4));
  const s1 = Number((2 * pivotP - pHigh).toFixed(4));

  const bodySize = Math.abs(current.close - current.open);
  const upperWick = current.high - Math.max(current.close, current.open);
  const lowerWick = Math.min(current.close, current.open) - current.low;

  let candlePattern = "شمعة عادية";
  if (current.close > current.open && current.close > prev1.high)
    candlePattern = "🟢 شمعة ابتلاعية شرائية قوية";
  else if (current.close < current.open && current.close < prev1.low)
    candlePattern = "🔴 شمعة ابتلاعية بيعية قوية";
  else if (lowerWick > bodySize * 2) candlePattern = "🟢 شمعة بن بار شرائية (Rejection)";
  else if (upperWick > bodySize * 2) candlePattern = "🔴 شمعة بن بار بيعية (Rejection)";

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

  return {
    currentPrice: current.close,
    classical: {
      ema50,
      ema200,
      trendByEMA:
        current.close > ema50 && ema50 > ema200
          ? "صاعد"
          : current.close < ema50 && ema50 < ema200
          ? "هابط"
          : "متذبذب",
      rsi14,
      divergenceStatus,
      atr14,
      classicSupport: swingLow,
      classicResistance: swingHigh,
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
  if (curTrend === "صاعد" && highTrend === "صاعد")
    return {
      isAligned: true,
      directionBias: "BULLISH",
      mtfStatus: `✅ توافق صاعد قوي مع الفريم الأكبر (${higherTFName})`,
    };
  if (curTrend === "هابط" && highTrend === "هابط")
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
 * 2. محرك الـ Backtest الصارم:
 * لا يرسم على الشموع إلا الصفقات المؤكدة ("صعود قوي" أو "هبوط قوي") فقط، ويتجاهل الصفقات العادية
 */
export function runHistoricalBacktest(candles) {
  if (!candles || candles.length < 70) {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, markers: [], tradesList: [] };
  }

  const closes = candles.map((c) => c.close);
  const rsiArr = calcRSISeries(closes, 14);
  const markers = [];
  const tradesList = [];
  let wins = 0;
  let losses = 0;

  // حساب EMA50 و EMA200 لتحديد الاتجاه المؤسسي المؤكد لكل شمعة
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

  const ema50Arr = calcEMASeries(50);
  const ema200Arr = calcEMASeries(200);

  let cooldown = 0;
  for (let i = 35; i < candles.length - 15; i++) {
    if (cooldown > 0) {
      cooldown--;
      continue;
    }

    const c = candles[i];
    const prev = candles[i - 1];
    const prev2 = candles[i - 2];
    const lookback = candles.slice(i - 20, i);
    const swingHigh = Math.max(...lookback.map((x) => x.high));
    const swingLow = Math.min(...lookback.map((x) => x.low));
    const atr = Math.abs(swingHigh - swingLow) / 4 || c.close * 0.002;

    // حساب POC المحلي لآخر 30 شمعة
    const localPoc = calculateVolumeProfilePOC(candles.slice(Math.max(0, i - 30), i + 1));

    // شروط "صعود قوي" المؤكدة فقط (5 شروط مجتمعة):
    // 1. اتجاه صاعد (فوق EMA50 و EMA200)
    // 2. فوق الـ POC المؤسسي
    // 3. كسر قمة (BOS) أو سحب سيولة قاع (Sweep) أو شمعة ابتلاعية صاعدة
    // 4. زخم RSI قوي بين 52 و 72
    const isConfirmedStrongBull =
      c.close > ema50Arr[i] &&
      ema50Arr[i] >= ema200Arr[i] * 0.998 &&
      c.close > localPoc &&
      c.close > c.open &&
      c.close > prev.high &&
      (c.close > prev2.high || c.low <= swingLow * 1.001) &&
      rsiArr[i] >= 52 &&
      rsiArr[i] <= 72;

    // شروط "هبوط قوي" المؤكدة فقط (5 شروط مجتمعة):
    const isConfirmedStrongBear =
      c.close < ema50Arr[i] &&
      ema50Arr[i] <= ema200Arr[i] * 1.002 &&
      c.close < localPoc &&
      c.close < c.open &&
      c.close < prev.low &&
      (c.close < prev2.low || c.high >= swingHigh * 0.999) &&
      rsiArr[i] <= 48 &&
      rsiArr[i] >= 28;

    if (isConfirmedStrongBull || isConfirmedStrongBear) {
      const isBuy = isConfirmedStrongBull;
      const entry = c.close;
      const sl = isBuy ? entry - atr * 1.2 : entry + atr * 1.2;
      const tp = isBuy ? entry + atr * 2.0 : entry - atr * 2.0; // عائد للمخاطرة 1:1.67

      let outcome = "OPEN";
      for (let j = i + 1; j < Math.min(candles.length, i + 18); j++) {
        const future = candles[j];
        if (isBuy) {
          if (future.high >= tp) {
            outcome = "WIN";
            break;
          }
          if (future.low <= sl) {
            outcome = "LOSS";
            break;
          }
        } else {
          if (future.low <= tp) {
            outcome = "WIN";
            break;
          }
          if (future.high >= sl) {
            outcome = "LOSS";
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
          text: `${isBuy ? "🔥 صعود قوي" : "🔥 هبوط قوي"} (${outcome === "WIN" ? "✅ هدف" : "❌ ستوب"})`,
        });

        tradesList.push({
          time: c.time,
          type: isBuy ? "صعود قوي مؤكد" : "هبوط قوي مؤكد",
          entry: entry.toFixed(4),
          tp: tp.toFixed(4),
          sl: sl.toFixed(4),
          result: outcome === "WIN" ? "✅ رابحة" : "❌ خاسرة",
        });

        cooldown = 10; // انتظار 10 شموع لمنع تكرار نفس الموجة
      }
    }
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const profitFactor = losses > 0 ? Number(((wins * 1.67) / losses).toFixed(2)) : wins > 0 ? 4.0 : 0;

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
 * 3. محرك الـ AI الموجه لإصدار تقارير الصفقات القوية المؤكدة فقط
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
  const prompt = `
أنت كبير محللي الفوركس المؤسسي (Chief Institutional Forex Strategist).
حلل زوج (${symbol}) على فريم (${timeframe}) عبر الـ 7 مدارس العالمية والأخبار الحية.

[قاعدة صارمة جداً مطلوبة من المستخدم]:
- المستخدم لا يتداول أبداً على الصفقات العادية أو الضعيفة ("صعود" أو "هبوط" عادي).
- لا تُصدر إشارة "صعود قوي" أو "هبوط قوي" ولا تُعطِ درجة ثقة >= 80% إلا إذا كان هناك توافق ساحق بين المدارس الفنية السبع + توافق الفريمات (${mtfReport.mtfStatus}) + عدم وجود تعارض مع مؤشر الدولار DXY والأخبار.
- إذا كانت الفرصة متوسطة أو ضعيفة، اجعل القرار "حياد / انتظار" أو "صعود" / "هبوط" عادي مع درجة ثقة أقل من 75% واذكر في المراجعة أنه لا ينصح بالدخول لعدم اكتمال شروط الصفقة المؤكدة.

[البيانات الحية]:
1. SMC/ICT: ${techData.smc.structureStatus} | ${techData.smc.premiumDiscountZone} | ${techData.smc.fvgStatus}
2. الفيبوناتشي: ${techData.fibonacci.fibStatus} (61.8%: ${techData.fibonacci.fib618})
3. المحاور البنكية (Pivots): ${techData.pivots.pivotBias} (P: ${techData.pivots.pivotP}, R1: ${techData.pivots.r1}, S1: ${techData.pivots.s1})
4. البرايس أكشن: ${techData.priceAction.candlePattern}
5. المؤشرات والدايفرجنس: الاتجاه ${techData.classical.trendByEMA} | RSI: ${techData.classical.rsi14} | ${techData.classical.divergenceStatus}
6. الفوليوم والـ POC: ${techData.volumeAnalysis.pocRelation} | RVOL: ${techData.volumeAnalysis.relativeVolumeRVOL}
7. الفريم الأكبر والأخبار: ${mtfReport.mtfStatus} | DXY: ${dxyData.currentPrice} (${dxyData.classical.trendByEMA}) | الأخبار: ${JSON.stringify(newsList.slice(0, 4))}
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

  return JSON.parse(response.text);
}