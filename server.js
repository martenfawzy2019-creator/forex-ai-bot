// backend/server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";
import fs from "fs";
import dotenv from "dotenv";
import { getForexNewsRadar } from "./news_service.js";
import {
  fetchForexCandles,
  fetchLiveTradingViewTicks,
  calculateAllIndicatorsAndSMC,
  getMarketSessionAndKillzone,
  evaluateNewsShield,
  evaluateMTFAlignment,
  evaluateStrictConfluence,
  runHistoricalBacktest,
  generateAISignal,
} from "./quant_ai_engine.js";
import { sendTelegramSignal } from "./telegram_service.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const LEDGER_FILE = "./trades_ledger.json";
const analysisCache = new Map();
let cachedDxyTech = null;
let cachedNews = null;
let lastMacroFetchTime = 0;
let latestLiveTicks = {};

// تنسيق الوقت بتوقيت القاهرة/مصر ليظهر بوضوح في الجدول والتليجرام
function formatEgyptTime(dateObj = new Date()) {
  return dateObj.toLocaleTimeString("ar-EG", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
      return raw.filter(
        (t) =>
          (t.signal === "صعود قوي" || t.signal === "هبوط قوي") &&
          Number(t.confidence) >= 85 &&
          !t.isWeekend
      );
    }
  } catch (e) {}
  return [];
}

function saveLedger(trades) {
  try {
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(trades.slice(-50), null, 2));
  } catch (e) {}
}

function extractNum(str) {
  if (!str) return null;
  const m = String(str).match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const startupSession = getMarketSessionAndKillzone();
if (startupSession.isMarketClosed) {
  saveLedger([]);
} else {
  loadLedger();
}

/**
 * تحديث حالة الصفقات المفتوحة بناءً على السعر اللحظي الحقيقي فقط (بدون ذيول الشموع القديمة)
 */
function evaluateOpenTradesWithLivePrice(symbol, livePriceNum) {
  if (!livePriceNum || isNaN(livePriceNum)) return false;
  const trades = loadLedger();
  let updated = false;
  const nowMs = Date.now();

  trades.forEach((t) => {
    if (t.status === "OPEN" && t.symbol === symbol) {
      // لا نقيم إغلاق الصفقة في أول 15 ثانية من فتحها لمنع التذبذب اللحظي عند الفتح
      if (nowMs - (t.openedAtMs || 0) < 15000) return;

      t.currentLivePrice = livePriceNum;
      const entry = Number(t.entry);
      const tp1 = Number(t.tp1);
      const sl = Number(t.sl);
      const targetDist = Math.abs(tp1 - entry);

      if (t.direction === "BUY") {
        // تفعيل تأمين الدخول (Break-Even) فقط إذا قطع السعر 75% من المسافة نحو الهدف
        if (!t.breakEvenSecured && livePriceNum >= entry + targetDist * 0.75) {
          t.breakEvenSecured = true;
          t.sl = entry; // نقل الستوب فعلياً لنقطة الدخول
          updated = true;
        }
        // التحقق من ضرب الهدف الفعلي أو الستوب الفعلي
        if (livePriceNum >= tp1) {
          t.status = "WIN";
          t.closeReason = "✅ حققت الهدف الكامل (TP1)";
          t.closePrice = livePriceNum;
          t.closedTimeFormatted = formatEgyptTime();
          updated = true;
        } else if (livePriceNum <= Number(t.sl)) {
          if (t.breakEvenSecured) {
            t.status = "BE";
            t.closeReason = "🛡️ أُغلقت على الدخول (مؤمّنة)";
          } else {
            t.status = "LOSS";
            t.closeReason = "❌ ضربت الستوب (SL)";
          }
          t.closePrice = livePriceNum;
          t.closedTimeFormatted = formatEgyptTime();
          updated = true;
        }
      } else if (t.direction === "SELL") {
        if (!t.breakEvenSecured && livePriceNum <= entry - targetDist * 0.75) {
          t.breakEvenSecured = true;
          t.sl = entry;
          updated = true;
        }
        if (livePriceNum <= tp1) {
          t.status = "WIN";
          t.closeReason = "✅ حققت الهدف الكامل (TP1)";
          t.closePrice = livePriceNum;
          t.closedTimeFormatted = formatEgyptTime();
          updated = true;
        } else if (livePriceNum >= Number(t.sl)) {
          if (t.breakEvenSecured) {
            t.status = "BE";
            t.closeReason = "🛡️ أُغلقت على الدخول (مؤمّنة)";
          } else {
            t.status = "LOSS";
            t.closeReason = "❌ ضربت الستوب (SL)";
          }
          t.closePrice = livePriceNum;
          t.closedTimeFormatted = formatEgyptTime();
          updated = true;
        }
      }
    }
  });

  if (updated) saveLedger(trades);
  return updated;
}

/**
 * رادار البث الحي للأسعار كل ثانيتين من TradingView
 */
setInterval(async () => {
  try {
    const session = getMarketSessionAndKillzone();
    if (session.isMarketClosed) return;

    const ticks = await fetchLiveTradingViewTicks();
    if (Object.keys(ticks).length > 0) {
      latestLiveTicks = ticks;
      io.emit("live_ticks", ticks);

      let anyTradeChanged = false;
      for (const sym of Object.keys(ticks)) {
        const changed = evaluateOpenTradesWithLivePrice(sym, ticks[sym].price);
        if (changed) anyTradeChanged = true;
      }

      if (anyTradeChanged) {
        io.emit("ledger_updated", getLedgerStatsSummary());
      }
    }
  } catch (e) {}
}, 2000);

function getLedgerStatsSummary() {
  const trades = loadLedger();
  const wins = trades.filter((t) => t.status === "WIN").length;
  const losses = trades.filter((t) => t.status === "LOSS").length;
  const breakEvens = trades.filter((t) => t.status === "BE").length;
  const openCount = trades.filter((t) => t.status === "OPEN").length;
  const decided = wins + losses;
  const winRate = decided > 0 ? Math.round((wins / decided) * 100) : 100;

  return {
    totalRecorded: trades.length,
    openCount,
    wins,
    losses,
    breakEvens,
    winRate,
    recentTrades: trades.slice(-10).reverse(),
  };
}

/**
 * تسجيل الصفقات الجديدة (مع منع التكرار نهائياً + إرسال فوري لتليجرام عند فتح أي صفقة جديدة)
 */
async function auditAndRecordSignal(symbol, timeframe, currentPrice, aiDecision, sessionInfo, fullResultForTelegram) {
  if (sessionInfo?.isMarketClosed) {
    return getLedgerStatsSummary();
  }

  const numPrice = Number(currentPrice);
  evaluateOpenTradesWithLivePrice(symbol, numPrice);

  const trades = loadLedger();
  const sig = (aiDecision.signal || "").trim();
  const conf = Number(aiDecision.confidenceScore || 0);
  const isConfirmedSuperStrong = (sig === "صعود قوي" || sig === "هبوط قوي") && conf >= 85;

  if (isConfirmedSuperStrong) {
    const isBuy = sig === "صعود قوي";
    const direction = isBuy ? "BUY" : "SELL";
    const nowMs = Date.now();

    // 1. منع فتح صفقة إذا كانت هناك صفقة مفتوحة حالياً على نفس الزوج
    const hasOpenSamePair = trades.some((t) => t.symbol === symbol && t.status === "OPEN");

    // 2. منع تكرار نفس الصفقة (Cooldown لمدة 30 دقيقة على نفس الزوج ونفس الاتجاه حتى لو أغلقت)
    const recentSameDirection = trades.find(
      (t) =>
        t.symbol === symbol &&
        t.direction === direction &&
        nowMs - (t.openedAtMs || 0) < 30 * 60 * 1000
    );

    if (!hasOpenSamePair && !recentSameDirection) {
      const slVal = extractNum(aiDecision.tradeSetup?.stopLoss);
      const tp1Val = extractNum(aiDecision.tradeSetup?.takeProfit1);
      const tp2Val = extractNum(aiDecision.tradeSetup?.takeProfit2);

      if (slVal && tp1Val) {
        const newTrade = {
          id: nowMs,
          tradeCode: `#${String(nowMs).slice(-4)}`,
          time: new Date().toISOString(),
          openedAtMs: nowMs,
          openedTimeFormatted: formatEgyptTime(),
          closedTimeFormatted: null,
          symbol,
          timeframe,
          signal: sig,
          direction,
          confidence: conf,
          entry: numPrice,
          currentLivePrice: numPrice,
          closePrice: null,
          sl: slVal,
          initialSl: slVal,
          tp1: tp1Val,
          tp2: tp2Val || tp1Val,
          breakEvenSecured: false,
          status: "OPEN",
          closeReason: "⏳ جارية الآن بالسوق",
          telegramSent: false,
        };

        // إرسال الصفقة فوراً إلى بوت تليجرام في نفس اللحظة التي تُسجل فيها بالموقع!
        try {
          const tgPayload = {
            ...fullResultForTelegram,
            symbol,
            timeframe,
            currentPrice: numPrice,
            ...aiDecision,
          };
          const tgRes = await sendTelegramSignal(tgPayload);
          if (tgRes && tgRes.sent) {
            newTrade.telegramSent = true;
          }
        } catch (tgErr) {
          console.error("Telegram Send Error:", tgErr.message);
        }

        trades.push(newTrade);
        saveLedger(trades);
      }
    }
  }

  return getLedgerStatsSummary();
}

async function getMacroAndDxyData(timeframe = "15m") {
  const now = Date.now();
  if (!cachedDxyTech || !cachedNews || now - lastMacroFetchTime > 3 * 60 * 1000) {
    const [dxyCandles, newsList] = await Promise.all([
      fetchForexCandles("DXY", timeframe),
      getForexNewsRadar(),
    ]);
    cachedDxyTech = calculateAllIndicatorsAndSMC(dxyCandles, "DXY");
    cachedNews = newsList;
    lastMacroFetchTime = now;
  }
  return { dxyTech: cachedDxyTech, newsList: cachedNews };
}

async function runFullForexAnalysis(symbol = "XAUUSD", timeframe = "15m", forceRefresh = false) {
  const sessionInfo = getMarketSessionAndKillzone();

  if (sessionInfo.isMarketClosed) {
    return {
      symbol,
      timeframe,
      higherTFName: "1h",
      currentPrice: "مغلق",
      dxyPrice: "مغلق",
      timestamp: new Date().toISOString(),
      signal: "حياد / انتظار",
      confidenceScore: 0,
      consensusCount: "عطلة نهاية الأسبوع",
      macroNewsIntegration:
        "🛑 سوق الفوركس العالمي مغلق حالياً في عطلة نهاية الأسبوع. البوت متوقف تماماً عن إصدار أي تحليلات أو تسجيل صفقات حتى افتتاح السوق يوم الأحد الساعة 21:00 بتوقيت UTC.",
      aiFinalReview: "تم إيقاف محرك الذكاء الاصطناعي وسجل الصفقات لحمايتك من الأسعار الثابتة وقت العطلة الأسبوعية.",
      summaryArabic: "🛑 السوق مغلق لعطلة نهاية الأسبوع.",
      mtfReport: { isAligned: false, mtfStatus: "🛑 السوق مغلق (عطلة أسبوعية)" },
      sessionInfo,
      newsShield: { shieldActive: true, warningText: "🛑 السوق مغلق في عطلة نهاية الأسبوع" },
      backtestReport: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, markers: [], tradesList: [] },
      ledgerStats: getLedgerStatsSummary(),
      tradeSetup: {
        entryZone: "مغلق (عطلة)",
        stopLoss: "مغلق (عطلة)",
        takeProfit1: "مغلق (عطلة)",
        takeProfit2: "مغلق (عطلة)",
      },
      rawIndicators: {},
      schoolsBreakdown: {
        smcAndICT: "متوقف (عطلة نهاية الأسبوع)",
        fibonacciAndOTE: "متوقف (عطلة نهاية الأسبوع)",
        pivotPointsBank: "متوقف (عطلة نهاية الأسبوع)",
        priceActionSupplyDemand: "متوقف (عطلة نهاية الأسبوع)",
        classicalTA: "متوقف (عطلة نهاية الأسبوع)",
        volumeAndVWAP: "متوقف (عطلة نهاية الأسبوع)",
        macroAndFedNews: "متوقف (عطلة نهاية الأسبوع)",
      },
      candles: [],
    };
  }

  const cacheKey = `${symbol}_${timeframe}`;
  const now = Date.now();

  if (!forceRefresh && analysisCache.has(cacheKey)) {
    const cachedItem = analysisCache.get(cacheKey);
    if (now - cachedItem.time < 60 * 1000) {
      if (latestLiveTicks[symbol]) {
        cachedItem.data.currentPrice = latestLiveTicks[symbol].priceStr;
        cachedItem.data.changePercent = latestLiveTicks[symbol].changePercent;
        cachedItem.data.changeAbs = latestLiveTicks[symbol].changeAbs;
      }
      cachedItem.data.ledgerStats = getLedgerStatsSummary();
      return cachedItem.data;
    }
  }

const higherTFMap = { "5m": "15m", "15m": "1h", "1h": "1d", "1d": "1W" };
  const higherTFName = higherTFMap[timeframe] || "1h";

  const [pairCandles, higherCandles, macroData] = await Promise.all([
    fetchForexCandles(symbol, timeframe),
    timeframe === higherTFName
      ? fetchForexCandles(symbol, timeframe)
      : fetchForexCandles(symbol, higherTFName),
    getMacroAndDxyData(timeframe),
  ]);

  const pairTech = calculateAllIndicatorsAndSMC(pairCandles, symbol);
  const higherTFTech = calculateAllIndicatorsAndSMC(higherCandles, symbol);
  const { dxyTech, newsList } = macroData;

  const mtfReport = evaluateMTFAlignment(pairTech, higherTFTech, higherTFName);
  const newsShield = evaluateNewsShield(newsList);
  const backtestReport = runHistoricalBacktest(pairCandles, symbol);
  const preConfluence = evaluateStrictConfluence(symbol, pairTech, higherTFTech, mtfReport, dxyTech, newsShield);

  let aiDecision;
  try {
    aiDecision = await generateAISignal(
      symbol,
      timeframe,
      pairTech,
      higherTFTech,
      higherTFName,
      mtfReport,
      sessionInfo,
      newsShield,
      dxyTech,
      newsList
    );
  } catch (aiError) {
    const isBuy = preConfluence.allowedSignal === "صعود قوي";
    const setup = isBuy ? pairTech.smartLevels.buy : pairTech.smartLevels.sell;

    aiDecision = {
      signal: preConfluence.allowedSignal,
      confidenceScore: preConfluence.maxConfidence,
      consensusCount: `توافق ${Math.max(preConfluence.bullPoints, preConfluence.bearPoints)} من 8 معايير مؤسسية`,
      macroNewsIntegration: `${preConfluence.dxyCorr.note} | مؤشر الدولار DXY عند ${dxyTech.currentPrice} بينما السعر ${pairTech.volumeAnalysis.pocRelation}.`,
      isUrgentAlert: preConfluence.allowedSignal !== "حياد / انتظار",
      schoolsBreakdown: {
        smcAndICT: `${pairTech.smc.structureStatus} | قاع هيكلي: ${pairTech.classical.recentStructuralLow} | قمة: ${pairTech.classical.recentStructuralHigh}`,
        fibonacciAndOTE: `${pairTech.fibonacci.fibStatus}`,
        pivotPointsBank: `${pairTech.pivots.pivotBias}`,
        priceActionSupplyDemand: `${pairTech.priceAction.candlePattern}`,
        classicalTA: `الاتجاه ${pairTech.classical.trendByEMA} | RSI: ${pairTech.classical.rsi14} | ${pairTech.classical.divergenceStatus}`,
        volumeAndVWAP: `${pairTech.volumeAnalysis.pocRelation}`,
        macroAndFedNews: `${mtfReport.mtfStatus} | ${preConfluence.dxyCorr.note}`,
      },
      aiFinalReview:
        preConfluence.allowedSignal === "حياد / انتظار"
          ? "لا توجد صفقة مؤكدة حالياً (تم تفعيل درع الحماية لمنع ضرب الستوب لوز بسبب عدم اكتمال التوافق المؤسسي)."
          : `إشارة مؤسسية مؤكدة (${preConfluence.allowedSignal}) محسوبة مباشرة على سعر ومؤشرات TradingView الحية.`,
      tradeSetup: {
        entryZone: `${setup.entry}`,
        stopLoss: `${setup.sl}`,
        takeProfit1: `${setup.tp1}`,
        takeProfit2: `${setup.tp2}`,
      },
      summaryArabic: `${mtfReport.mtfStatus}`,
    };
  }

  const isConfirmedStrong =
    (aiDecision.signal === "صعود قوي" || aiDecision.signal === "هبوط قوي") &&
    aiDecision.confidenceScore >= 85;

  if (!isConfirmedStrong) {
    aiDecision.tradeSetup = {
      entryZone: "🔒 صفقات قوية فقط (+85%)",
      stopLoss: "🔒 صفقات قوية فقط (+85%)",
      takeProfit1: "🔒 صفقات قوية فقط (+85%)",
      takeProfit2: "🔒 صفقات قوية فقط (+85%)",
    };
    aiDecision.aiFinalReview = `🛡️ [حماية رأس المال من ضرب الستوب]: تم حجب الدخول على (${symbol}) لأن شروط التوافق الصارم على TradingView لم تكتمل (شراء: ${preConfluence.bullPoints}/8 | بيع: ${preConfluence.bearPoints}/8 | ${preConfluence.dxyCorr.note}).`;
  }

  const baseInfoForTelegram = {
    symbol,
    timeframe,
    higherTFName,
    currentPrice: pairTech.currentPrice,
    dxyPrice: dxyTech.currentPrice,
    mtfReport,
    sessionInfo,
    newsShield,
  };

  const ledgerStats = await auditAndRecordSignal(
    symbol,
    timeframe,
    pairTech.currentPrice,
    aiDecision,
    sessionInfo,
    baseInfoForTelegram
  );

  const finalResult = {
    symbol,
    timeframe,
    higherTFName,
    currentPrice: pairTech.currentPrice,
    changePercent: pairTech.changePercent,
    changeAbs: pairTech.changeAbs,
    dxyPrice: dxyTech.currentPrice,
    timestamp: new Date().toISOString(),
    mtfReport,
    sessionInfo,
    newsShield,
    backtestReport,
    ledgerStats,
    ...aiDecision,
    rawIndicators: pairTech,
    upcomingNews: newsList.slice(0, 5),
  };

  analysisCache.set(cacheKey, { time: now, data: finalResult });
  return finalResult;
}

app.get("/api/analyze", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "XAUUSD").toUpperCase();
    const timeframe = req.query.timeframe || "15m";
    const force = req.query.force === "true";

    const result = await runFullForexAnalysis(symbol, timeframe, force);
    io.emit("market_update", result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/live-ticks", async (req, res) => {
  if (Object.keys(latestLiveTicks).length === 0) {
    latestLiveTicks = await fetchLiveTradingViewTicks();
  }
  res.json(latestLiveTicks);
});

app.post("/api/clear-ledger", (req, res) => {
  saveLedger([]);
  analysisCache.clear();
  res.json({ cleared: true, message: "✅ تم مسح جميع الصفقات القديمة وتصفير السجل بنجاح." });
});

app.get("/api/currency-strength", async (req, res) => {
  try {
    const session = getMarketSessionAndKillzone();
    if (session.isMarketClosed) {
      return res.json({
        strongest: { currency: "السوق مغلق (عطلة)", score: 0 },
        weakest: { currency: "السوق مغلق (عطلة)", score: 0 },
        strengths: [],
      });
    }

    const ticks = Object.keys(latestLiveTicks).length > 0 ? latestLiveTicks : await fetchLiveTradingViewTicks();
    const calcScore = (sym, invert = false) => {
      const item = ticks[sym];
      if (!item) return 50;
      let s = item.rsi15m || 50;
      s += (item.tvRating || 0) * 20;
      if (invert) s = 100 - s;
      return Math.max(8, Math.min(96, Math.round(s)));
    };

    const strengths = [
      { currency: "XAU (الذهب)", score: calcScore("XAUUSD", false) },
      { currency: "USD (الدولار)", score: calcScore("DXY", false) },
      { currency: "EUR (اليورو)", score: calcScore("EURUSD", false) },
      { currency: "GBP (الباوند)", score: calcScore("GBPUSD", false) },
      { currency: "JPY (الين)", score: calcScore("USDJPY", true) },
    ].sort((a, b) => b.score - a.score);

    res.json({
      strongest: strengths[0],
      weakest: strengths[strengths.length - 1],
      strengths,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/scan-all", async (req, res) => {
  try {
    const session = getMarketSessionAndKillzone();
    if (session.isMarketClosed) {
      return res.json({ allPairs: [] });
    }

    const timeframe = req.query.timeframe || "15m";
    const pairs = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"];
    const higherTFName = timeframe === "1h" || timeframe === "1d" ? "1d" : "1h";
    const { dxyTech, newsList } = await getMacroAndDxyData(timeframe);
    const newsShield = evaluateNewsShield(newsList);

    const scanResults = await Promise.all(
      pairs.map(async (sym) => {
        const [candles, highCandles] = await Promise.all([
          fetchForexCandles(sym, timeframe),
          fetchForexCandles(sym, higherTFName),
        ]);
        const tech = calculateAllIndicatorsAndSMC(candles, sym);
        const highTech = calculateAllIndicatorsAndSMC(highCandles, sym);
        const mtf = evaluateMTFAlignment(tech, highTech, higherTFName);
        const conf = evaluateStrictConfluence(sym, tech, highTech, mtf, dxyTech, newsShield);

        return {
          symbol: sym,
          currentPrice: tech.currentPrice,
          signal: conf.allowedSignal,
          confidenceScore: conf.maxConfidence,
          mtfText: mtf.mtfStatus,
        };
      })
    );

    scanResults.sort((a, b) => b.confidenceScore - a.confidenceScore);
    res.json({ allPairs: scanResults });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// فحص دوري كل 5 دقائق لجميع الأزواج لتسجيل الصفقات المؤكدة وإرسالها لتليجرام تلقائياً
cron.schedule("*/5 * * * *", async () => {
  try {
    const session = getMarketSessionAndKillzone();
    if (session.isMarketClosed) return;

    const pairs = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"];
    for (const sym of pairs) {
      const result = await runFullForexAnalysis(sym, "15m", true);
      io.emit("market_update", result);
    }
  } catch (err) {}
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 منصة الفوركس الحية (مربوطة لحظياً بـ TradingView Live Stream) تعمل على البورت: ${PORT}`);
});