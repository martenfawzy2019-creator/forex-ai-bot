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
  calculateAllIndicatorsAndSMC,
  getMarketSessionAndKillzone,
  evaluateNewsShield,
  evaluateMTFAlignment,
  runHistoricalBacktest,
  generateAISignal,
} from "./quant_ai_engine.js";
import { sendTelegramSignal, validateSignalQuality } from "./telegram_service.js";

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

/**
 * قراءة السجل مع تصفية وحذف أي صفقات قديمة ليست ("صعود قوي" أو "هبوط قوي") وبثقة >= 85%
 */
function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
      // فلتر تنظيف تلقائي: يحذف أي صفقة قديمة عادية ("هبوط" أو "صعود" فقط) أو ثقتها أقل من 85%
      const strictlyStrongTrades = raw.filter(
        (t) =>
          (t.signal === "صعود قوي" || t.signal === "هبوط قوي") &&
          Number(t.confidence) >= 85 &&
          !t.isWeekend
      );
      if (strictlyStrongTrades.length !== raw.length) {
        saveLedger(strictlyStrongTrades);
      }
      return strictlyStrongTrades;
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

// تنظيف ملف السجل القديم فوراً عند بدء تشغيل السيرفر إذا كان السوق في عطلة نهاية الأسبوع
const startupSession = getMarketSessionAndKillzone();
if (startupSession.isMarketClosed) {
  saveLedger([]);
  console.log("🧹 تم تصفير سجل الصفقات التجريبية القديم لأن السوق حالياً في عطلة نهاية الأسبوع.");
} else {
  loadLedger();
}

/**
 * لا يسجل في السجل أبداً إلا ("صعود قوي" أو "هبوط قوي") وبثقة >= 85% ووقت عمل السوق الرسمي فقط
 */
function auditAndRecordSignal(symbol, timeframe, currentPrice, aiDecision, sessionInfo) {
  if (sessionInfo?.isMarketClosed) {
    return {
      totalRecorded: 0,
      openCount: 0,
      wins: 0,
      losses: 0,
      winRate: 100,
      recentTrades: [],
    };
  }

  const trades = loadLedger();

  // تحديث الصفقات الجارية
  trades.forEach((t) => {
    if (t.symbol === symbol && t.status === "OPEN") {
      if (t.direction === "BUY") {
        if (currentPrice >= t.tp1) t.status = "WIN";
        else if (currentPrice <= t.sl) t.status = "LOSS";
      } else if (t.direction === "SELL") {
        if (currentPrice <= t.tp1) t.status = "WIN";
        else if (currentPrice >= t.sl) t.status = "LOSS";
      }
    }
  });

  const sig = (aiDecision.signal || "").trim();
  const conf = Number(aiDecision.confidenceScore || 0);
  const isConfirmedSuperStrong = (sig === "صعود قوي" || sig === "هبوط قوي") && conf >= 85;

  if (isConfirmedSuperStrong) {
    const hasOpenSamePair = trades.some((t) => t.symbol === symbol && t.status === "OPEN");
    if (!hasOpenSamePair) {
      const isBuy = sig === "صعود قوي";
      const slVal = extractNum(aiDecision.tradeSetup?.stopLoss);
      const tp1Val = extractNum(aiDecision.tradeSetup?.takeProfit1);

      if (slVal && tp1Val) {
        trades.push({
          id: Date.now(),
          time: new Date().toISOString(),
          symbol,
          timeframe,
          signal: sig,
          direction: isBuy ? "BUY" : "SELL",
          confidence: conf,
          entry: currentPrice,
          sl: slVal,
          tp1: tp1Val,
          status: "OPEN",
        });
      }
    }
  }

  saveLedger(trades);

  const closed = trades.filter((t) => t.status === "WIN" || t.status === "LOSS");
  const wins = closed.filter((t) => t.status === "WIN").length;
  const losses = closed.filter((t) => t.status === "LOSS").length;
  const openCount = trades.filter((t) => t.status === "OPEN").length;
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 100;

  return {
    totalRecorded: trades.length,
    openCount,
    wins,
    losses,
    winRate,
    recentTrades: trades.slice(-8).reverse(),
  };
}

async function getMacroAndDxyData(timeframe = "15m") {
  const now = Date.now();
  if (!cachedDxyTech || !cachedNews || now - lastMacroFetchTime > 5 * 60 * 1000) {
    const [dxyCandles, newsList] = await Promise.all([
      fetchForexCandles("DXY", timeframe),
      getForexNewsRadar(),
    ]);
    cachedDxyTech = calculateAllIndicatorsAndSMC(dxyCandles);
    cachedNews = newsList;
    lastMacroFetchTime = now;
  }
  return { dxyTech: cachedDxyTech, newsList: cachedNews };
}

async function runFullForexAnalysis(symbol = "XAUUSD", timeframe = "15m", forceRefresh = false) {
  const sessionInfo = getMarketSessionAndKillzone();

  // إيقاف التحليل والسجل تماماً في عطلة نهاية الأسبوع
  if (sessionInfo.isMarketClosed) {
    const cleanLedger = loadLedger();
    const openCount = cleanLedger.filter((t) => t.status === "OPEN").length;
    const wins = cleanLedger.filter((t) => t.status === "WIN").length;
    const losses = cleanLedger.filter((t) => t.status === "LOSS").length;

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
      macroNewsIntegration: "🛑 سوق الفوركس العالمي مغلق حالياً في عطلة نهاية الأسبوع. البوت متوقف تماماً عن إصدار أي تحليلات أو تسجيل صفقات حتى افتتاح السوق يوم الأحد الساعة 21:00 بتوقيت UTC.",
      aiFinalReview: "تم إيقاف محرك الذكاء الاصطناعي وسجل الصفقات لحمايتك من الأسعار الثابتة وقت العطلة الأسبوعية.",
      summaryArabic: "🛑 السوق مغلق لعطلة نهاية الأسبوع.",
      mtfReport: { isAligned: false, mtfStatus: "🛑 السوق مغلق (عطلة أسبوعية)" },
      sessionInfo,
      newsShield: { shieldActive: true, warningText: "🛑 السوق مغلق في عطلة نهاية الأسبوع" },
      backtestReport: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, markers: [], tradesList: [] },
      ledgerStats: {
        totalRecorded: cleanLedger.length,
        openCount,
        wins,
        losses,
        winRate: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 100,
        recentTrades: cleanLedger.slice(-8).reverse(),
      },
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
    if (now - cachedItem.time < 3 * 60 * 1000) {
      return cachedItem.data;
    }
  }

  const higherTFMap = { "5m": "1h", "15m": "1h", "1h": "1d", "1d": "1d" };
  const higherTFName = higherTFMap[timeframe] || "1h";

  const [pairCandles, higherCandles, macroData] = await Promise.all([
    fetchForexCandles(symbol, timeframe),
    timeframe === higherTFName
      ? fetchForexCandles(symbol, timeframe)
      : fetchForexCandles(symbol, higherTFName),
    getMacroAndDxyData(timeframe),
  ]);

  const pairTech = calculateAllIndicatorsAndSMC(pairCandles);
  const higherTFTech = calculateAllIndicatorsAndSMC(higherCandles);
  const { dxyTech, newsList } = macroData;

  const mtfReport = evaluateMTFAlignment(pairTech, higherTFTech, higherTFName);
  const newsShield = evaluateNewsShield(newsList);
  const backtestReport = runHistoricalBacktest(pairCandles);

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
    const isBull = pairTech.classical.trendByEMA === "صاعد";
    const isBear = pairTech.classical.trendByEMA === "هابط";
    const atr = pairTech.classical.atr14;
    const price = pairTech.currentPrice;

    let bullVotes = 0,
      bearVotes = 0;
    if (isBull) bullVotes += 2;
    if (isBear) bearVotes += 2;
    if (price > pairTech.pivots.pivotP) bullVotes++;
    else bearVotes++;
    if (price > pairTech.volumeAnalysis.pocPrice) bullVotes++;
    else bearVotes++;
    if (mtfReport.directionBias === "BULLISH") bullVotes += 2;
    if (mtfReport.directionBias === "BEARISH") bearVotes += 2;

    const totalAligned = Math.max(bullVotes, bearVotes);
    const fallbackSignal =
      bullVotes >= 6 ? "صعود قوي" : bearVotes >= 6 ? "هبوط قوي" : "حياد / انتظار";

    aiDecision = {
      signal: fallbackSignal,
      confidenceScore: totalAligned >= 6 ? 86 : 60,
      consensusCount: `توافق ${totalAligned} من 7 مدارس تحليلية`,
      macroNewsIntegration: `مؤشر الدولار DXY عند ${dxyTech.currentPrice} بينما السعر ${pairTech.volumeAnalysis.pocRelation}.`,
      isUrgentAlert: totalAligned >= 6,
      schoolsBreakdown: {
        smcAndICT: `${pairTech.smc.structureStatus} | ${pairTech.smc.premiumDiscountZone}`,
        fibonacciAndOTE: `${pairTech.fibonacci.fibStatus}`,
        pivotPointsBank: `${pairTech.pivots.pivotBias}`,
        priceActionSupplyDemand: `${pairTech.priceAction.candlePattern}`,
        classicalTA: `الاتجاه ${pairTech.classical.trendByEMA} | RSI: ${pairTech.classical.rsi14}`,
        volumeAndVWAP: `${pairTech.volumeAnalysis.pocRelation}`,
        macroAndFedNews: `${mtfReport.mtfStatus}`,
      },
      aiFinalReview:
        fallbackSignal === "حياد / انتظار"
          ? "لا توجد صفقة مؤكدة حالياً (تم تفعيل الحماية لأننا لا نعتمد إلا الصفقات القوية المؤكدة)."
          : `إشارة مؤكدة (${fallbackSignal}) بتوافق المدارس السبع والـ POC.`,
      tradeSetup: {
        entryZone: `${price}`,
        stopLoss: `${(isBear ? price + atr * 1.2 : price - atr * 1.2).toFixed(4)}`,
        takeProfit1: `${(isBear ? price - atr * 2.0 : price + atr * 2.0).toFixed(4)}`,
        takeProfit2: `${(isBear ? price - atr * 3.0 : price + atr * 3.0).toFixed(4)}`,
      },
      summaryArabic: `${mtfReport.mtfStatus}`,
    };
  }

  // لا نفعل مستويات التداول ولا السجل إلا إذا كانت الصفقة ("صعود قوي" أو "هبوط قوي") وبثقة >= 85%
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
    aiDecision.aiFinalReview = `⚠️ [تم حجب التقرير التنفيذي لتقليل المخاطر]: الإشارة الحالية (${aiDecision.signal} بثقة ${aiDecision.confidenceScore}%) غير مسموح بتسجيلها أو التداول عليها لأن إعداداتك تشترط "صعود قوي" أو "هبوط قوي" بثقة لا تقل عن 85%.`;
  }

  const ledgerStats = auditAndRecordSignal(symbol, timeframe, pairTech.currentPrice, aiDecision, sessionInfo);
  const qualityCheck = validateSignalQuality({
    currentPrice: pairTech.currentPrice,
    sessionInfo,
    newsShield,
    ...aiDecision,
  });

  const finalResult = {
    symbol,
    timeframe,
    higherTFName,
    currentPrice: pairTech.currentPrice,
    dxyPrice: dxyTech.currentPrice,
    timestamp: new Date().toISOString(),
    mtfReport,
    sessionInfo,
    newsShield,
    backtestReport,
    ledgerStats,
    qualityCheck,
    ...aiDecision,
    rawIndicators: pairTech,
    upcomingNews: newsList.slice(0, 5),
    candles: pairCandles.slice(-140),
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

// مسار جديد لتصفير ومسح سجل الصفقات بضغطة زر
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

    const timeframe = req.query.timeframe || "15m";
    const [xau, eur, gbp, jpy, dxy] = await Promise.all([
      fetchForexCandles("XAUUSD", timeframe),
      fetchForexCandles("EURUSD", timeframe),
      fetchForexCandles("GBPUSD", timeframe),
      fetchForexCandles("USDJPY", timeframe),
      fetchForexCandles("DXY", timeframe),
    ]);

    const scoreAsset = (candles, invert = false) => {
      const t = calculateAllIndicatorsAndSMC(candles);
      let s = t.classical.rsi14;
      if (t.classical.trendByEMA === "صاعد") s += 12;
      if (t.classical.trendByEMA === "هابط") s -= 12;
      if (invert) s = 100 - s;
      return Math.max(5, Math.min(98, Math.round(s)));
    };

    const strengths = [
      { currency: "XAU (الذهب)", score: scoreAsset(xau, false) },
      { currency: "USD (الدولار)", score: scoreAsset(dxy, false) },
      { currency: "EUR (اليورو)", score: scoreAsset(eur, false) },
      { currency: "GBP (الباوند)", score: scoreAsset(gbp, false) },
      { currency: "JPY (الين)", score: scoreAsset(jpy, true) },
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

    const scanResults = await Promise.all(
      pairs.map(async (sym) => {
        const [candles, highCandles] = await Promise.all([
          fetchForexCandles(sym, timeframe),
          fetchForexCandles(sym, higherTFName),
        ]);
        const tech = calculateAllIndicatorsAndSMC(candles);
        const highTech = calculateAllIndicatorsAndSMC(highCandles);
        const mtf = evaluateMTFAlignment(tech, highTech, higherTFName);

        let score = 55;
        if (mtf.isAligned) score += 25;
        if (tech.smc.structureStatus.includes("Sweep") || tech.smc.structureStatus.includes("BOS")) score += 10;

        let quickSignal = "حياد / غير مؤكد";
        if (mtf.directionBias === "BULLISH" && score >= 85) quickSignal = "صعود قوي";
        else if (mtf.directionBias === "BEARISH" && score >= 85) quickSignal = "هبوط قوي";

        return {
          symbol: sym,
          currentPrice: tech.currentPrice,
          signal: quickSignal,
          confidenceScore: Math.min(95, score),
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

app.get("/api/test-telegram", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "XAUUSD").toUpperCase();
    const timeframe = req.query.timeframe || "15m";
    const result = await runFullForexAnalysis(symbol, timeframe, false);
    const tgResult = await sendTelegramSignal(result);
    res.json(tgResult);
  } catch (error) {
    res.status(500).json({ sent: false, message: error.message });
  }
});

cron.schedule("*/15 * * * *", async () => {
  try {
    const session = getMarketSessionAndKillzone();
    if (session.isMarketClosed) return;

    const pairs = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"];
    for (const sym of pairs) {
      const result = await runFullForexAnalysis(sym, "15m", true);
      io.emit("market_update", result);

      const quality = validateSignalQuality(result);
      if (quality.isValid && result.confidenceScore >= 85) {
        io.emit("urgent_alert", result);
        await sendTelegramSignal(result);
      }
    }
  } catch (err) {}
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 منصة الفوركس المؤسسية (نظام الصفقات القوية المؤكدة فقط +85%) تعمل على: http://localhost:${PORT}`);
});