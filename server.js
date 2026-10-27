// backend/server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
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

// حفظ السجل في المجلد الرئيسي الدائم خارج Git حتى لا يُمسح أبداً عند عمل git pull
const PERMANENT_LEDGER_PATH = path.join(os.homedir(), "forex_permanent_ledger.json");
const BACKUP_LEDGER_PATH = path.join(os.homedir(), "forex_permanent_ledger.bak.json");
const OLD_LOCAL_LEDGER = "./trades_ledger.json";

const analysisCache = new Map();
let cachedDxyTech = null;
let cachedNews = null;
let lastMacroFetchTime = 0;
let latestLiveTicks = {};

// دالة الحصول على تاريخ اليوم بتوقيت مصر (YYYY-MM-DD)
function getEgyptDateString(dateObj = new Date()) {
  return dateObj.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

// دالة تنسيق الوقت بتوقيت مصر
function formatEgyptTime(dateObj = new Date()) {
  return dateObj.toLocaleTimeString("ar-EG", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/**
 * حساب عدد النقاط (Pips) القياسي لكل زوج عملات أو ذهب بدقة
 * - في EURUSD و GBPUSD: الـ 1 Pip = 0.0001
 * - في USDJPY: الـ 1 Pip = 0.01
 * - في XAUUSD (الذهب): كل 0.10 دولار = 1 Pip (أي تحرك 1 دولار = 10 Pips)
 */
function calculatePips(symbol, entryPrice, targetOrCurrentPrice, direction) {
  const entry = Number(entryPrice);
  const current = Number(targetOrCurrentPrice);
  if (!entry || !current || isNaN(entry) || isNaN(current)) return 0;

  const rawDiff = direction === "BUY" ? current - entry : entry - current;
  let multiplier = 10000;
  if (symbol === "XAUUSD") multiplier = 10;
  else if (symbol === "USDJPY") multiplier = 100;

  return Number((rawDiff * multiplier).toFixed(1));
}

/**
 * إرسال رسائل تليجرام فورية (للتأمين، الإغلاق بالـ Pips، والتقرير اليومي)
 */
async function sendCustomTelegramMessage(htmlText) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: htmlText,
      parse_mode: "HTML",
    });
    return true;
  } catch (err) {
    console.error("Telegram Custom Message Error:", err.message);
    return false;
  }
}

/**
 * قراءة السجل الدائم مع الحماية ضد التلف واسترجاع أي بيانات قديمة تلقائياً
 */
function loadLedger() {
  try {
    // ترحيل السجل المحلي القديم لمرة واحدة إن وجد
    if (!fs.existsSync(PERMANENT_LEDGER_PATH) && fs.existsSync(OLD_LOCAL_LEDGER)) {
      const oldData = fs.readFileSync(OLD_LOCAL_LEDGER, "utf8");
      fs.writeFileSync(PERMANENT_LEDGER_PATH, oldData);
    }

    if (fs.existsSync(PERMANENT_LEDGER_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PERMANENT_LEDGER_PATH, "utf8"));
      if (Array.isArray(raw)) return raw;
    }
  } catch (e) {
    // في حال حدوث خطأ قراءة، نسترجع النسخة الاحتياطية فوراً
    try {
      if (fs.existsSync(BACKUP_LEDGER_PATH)) {
        const bak = JSON.parse(fs.readFileSync(BACKUP_LEDGER_PATH, "utf8"));
        if (Array.isArray(bak)) return bak;
      }
    } catch (err) {}
  }
  return [];
}

function saveLedger(trades) {
  try {
    if (!Array.isArray(trades)) return;
    const cleaned = trades.slice(-300); // الاحتفاظ بآخر 300 صفقة في الأرشيف الدائم
    const jsonStr = JSON.stringify(cleaned, null, 2);
    fs.writeFileSync(PERMANENT_LEDGER_PATH, jsonStr);
    fs.writeFileSync(BACKUP_LEDGER_PATH, jsonStr);
  } catch (e) {}
}

function extractNum(str) {
  if (!str) return null;
  const m = String(str).match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

loadLedger();

/**
 * متابعة الصفقات المفتوحة بالسعر اللحظي وإرسال إشعارات التأمين والربح/الخسارة بالـ Pips لتليجرام
 */
async function evaluateOpenTradesWithLivePrice(symbol, livePriceNum) {
  if (!livePriceNum || isNaN(livePriceNum)) return false;
  const trades = loadLedger();
  let updated = false;
  const nowMs = Date.now();

  for (const t of trades) {
    if (t.status === "OPEN" && t.symbol === symbol) {
      t.currentLivePrice = livePriceNum;
      t.livePips = calculatePips(t.symbol, t.entry, livePriceNum, t.direction);

      // عدم إغلاق الصفقة في أول 15 ثانية من فتحها
      if (nowMs - (t.openedAtMs || 0) < 15000) continue;

      const entry = Number(t.entry);
      const tp1 = Number(t.tp1);
      const sl = Number(t.sl);
      const targetDist = Math.abs(tp1 - entry);

      if (t.direction === "BUY") {
        // 1. تفعيل التأمين عند الوصول إلى 75% من الهدف وإرسال رسالة تليجرام فورية
        if (!t.breakEvenSecured && livePriceNum >= entry + targetDist * 0.75) {
          t.breakEvenSecured = true;
          t.sl = entry;
          updated = true;

          await sendCustomTelegramMessage(
            `🛡️ <b>تأمين صفقة تلقائي (Break-Even)</b>\n` +
              `━━━━━━━━━━━━━━\n` +
              `🔖 كود الصفقة: <b>${t.tradeCode}</b>\n` +
              `💱 الزوج: <b>${t.symbol}</b> (${t.timeframe})\n` +
              `📈 الاتجاه: <b>${t.signal}</b>\n` +
              `🎯 سعر الدخول: <code>${t.entry}</code>\n` +
              `⚡ السعر الحالي: <code>${livePriceNum}</code> (<b>+${t.livePips} Pips</b>)\n` +
              `🔒 <b>تم نقل الستوب لوز إلى نقطة الدخول لتأمين الصفقة من أي خسارة!</b>`
          );
        }

        // 2. التحقق من ضرب الهدف الكامل
        if (livePriceNum >= tp1) {
          const wonPips = calculatePips(t.symbol, entry, tp1, "BUY");
          t.status = "WIN";
          t.pipsResult = Math.abs(wonPips);
          t.closeReason = `✅ هدف كامل (+${t.pipsResult} Pips)`;
          t.closePrice = livePriceNum;
          t.closedTimeFormatted = formatEgyptTime();
          t.closedDate = getEgyptDateString();
          updated = true;

          await sendCustomTelegramMessage(
            `✅ <b>صفقة رابحة ضربت الهدف (Take Profit)!</b>\n` +
              `━━━━━━━━━━━━━━\n` +
              `🔖 كود الصفقة: <b>${t.tradeCode}</b>\n` +
              `💱 الزوج: <b>${t.symbol}</b> (${t.timeframe})\n` +
              `🎯 الدخول: <code>${t.entry}</code> ⬅️ الإغلاق: <code>${livePriceNum}</code>\n` +
              `💰 الربح المحقق: <b>+${t.pipsResult} Pips 🟢</b>\n` +
              `⏰ وقت الإغلاق: ${t.closedTimeFormatted}`
          );
        } else if (livePriceNum <= Number(t.sl)) {
          if (t.breakEvenSecured) {
            t.status = "BE";
            t.pipsResult = 0;
            t.closeReason = "🛡️ أُغلقت على الدخول (0 Pips)";
            t.closePrice = entry;
            t.closedTimeFormatted = formatEgyptTime();
            t.closedDate = getEgyptDateString();
            updated = true;

            await sendCustomTelegramMessage(
              `🛡️ <b>إغلاق صفقة على نقطة الدخول (مؤمّنة بدون خسارة)</b>\n` +
                `━━━━━━━━━━━━━━\n` +
                `🔖 كود الصفقة: <b>${t.tradeCode}</b> | الزوج: <b>${t.symbol}</b>\n` +
                `🎯 سعر الدخول والإغلاق: <code>${t.entry}</code>\n` +
                `⚖️ النتيجة: <b>0.0 Pips (حماية رأس المال)</b>`
            );
          } else {
            const lostPips = Math.abs(calculatePips(t.symbol, entry, sl, "BUY"));
            t.status = "LOSS";
            t.pipsResult = -lostPips;
            t.closeReason = `❌ ضربت ستوب (-${lostPips} Pips)`;
            t.closePrice = livePriceNum;
            t.closedTimeFormatted = formatEgyptTime();
            t.closedDate = getEgyptDateString();
            updated = true;

            await sendCustomTelegramMessage(
              `❌ <b>إغلاق صفقة على وقف الخسارة (Stop Loss)</b>\n` +
                `━━━━━━━━━━━━━━\n` +
                `🔖 كود الصفقة: <b>${t.tradeCode}</b> | الزوج: <b>${t.symbol}</b>\n` +
                `🎯 الدخول: <code>${t.entry}</code> ⬅️ الإغلاق: <code>${livePriceNum}</code>\n` +
                `📉 الخسارة: <b>-${lostPips} Pips 🔴</b>\n` +
                `⏰ وقت الإغلاق: ${t.closedTimeFormatted}`
            );
          }
        }
      } else if (t.direction === "SELL") {
        // حالة البيع (SELL)
        if (!t.breakEvenSecured && livePriceNum <= entry - targetDist * 0.75) {
          t.breakEvenSecured = true;
          t.sl = entry;
          updated = true;

          await sendCustomTelegramMessage(
            `🛡️ <b>تأمين صفقة تلقائي (Break-Even)</b>\n` +
              `━━━━━━━━━━━━━━\n` +
              `🔖 كود الصفقة: <b>${t.tradeCode}</b>\n` +
              `💱 الزوج: <b>${t.symbol}</b> (${t.timeframe})\n` +
              `📉 الاتجاه: <b>${t.signal}</b>\n` +
              `🎯 سعر الدخول: <code>${t.entry}</code>\n` +
              `⚡ السعر الحالي: <code>${livePriceNum}</code> (<b>+${t.livePips} Pips</b>)\n` +
              `🔒 <b>تم نقل الستوب لوز إلى نقطة الدخول لتأمين الصفقة من أي خسارة!</b>`
          );
        }

        if (livePriceNum <= tp1) {
          const wonPips = Math.abs(calculatePips(t.symbol, entry, tp1, "SELL"));
          t.status = "WIN";
          t.pipsResult = wonPips;
          t.closeReason = `✅ هدف كامل (+${wonPips} Pips)`;
          t.closePrice = livePriceNum;
          t.closedTimeFormatted = formatEgyptTime();
          t.closedDate = getEgyptDateString();
          updated = true;

          await sendCustomTelegramMessage(
            `✅ <b>صفقة رابحة ضربت الهدف (Take Profit)!</b>\n` +
              `━━━━━━━━━━━━━━\n` +
              `🔖 كود الصفقة: <b>${t.tradeCode}</b>\n` +
              `💱 الزوج: <b>${t.symbol}</b> (${t.timeframe})\n` +
              `🎯 الدخول: <code>${t.entry}</code> ⬅️ الإغلاق: <code>${livePriceNum}</code>\n` +
              `💰 الربح المحقق: <b>+${wonPips} Pips 🟢</b>\n` +
              `⏰ وقت الإغلاق: ${t.closedTimeFormatted}`
          );
        } else if (livePriceNum >= Number(t.sl)) {
          if (t.breakEvenSecured) {
            t.status = "BE";
            t.pipsResult = 0;
            t.closeReason = "🛡️ أُغلقت على الدخول (0 Pips)";
            t.closePrice = entry;
            t.closedTimeFormatted = formatEgyptTime();
            t.closedDate = getEgyptDateString();
            updated = true;

            await sendCustomTelegramMessage(
              `🛡️ <b>إغلاق صفقة على نقطة الدخول (مؤمّنة بدون خسارة)</b>\n` +
                `━━━━━━━━━━━━━━\n` +
                `🔖 كود الصفقة: <b>${t.tradeCode}</b> | الزوج: <b>${t.symbol}</b>\n` +
                `🎯 سعر الدخول والإغلاق: <code>${t.entry}</code>\n` +
                `⚖️ النتيجة: <b>0.0 Pips (حماية رأس المال)</b>`
            );
          } else {
            const lostPips = Math.abs(calculatePips(t.symbol, entry, sl, "SELL"));
            t.status = "LOSS";
            t.pipsResult = -lostPips;
            t.closeReason = `❌ ضربت ستوب (-${lostPips} Pips)`;
            t.closePrice = livePriceNum;
            t.closedTimeFormatted = formatEgyptTime();
            t.closedDate = getEgyptDateString();
            updated = true;

            await sendCustomTelegramMessage(
              `❌ <b>إغلاق صفقة على وقف الخسارة (Stop Loss)</b>\n` +
                `━━━━━━━━━━━━━━\n` +
                `🔖 كود الصفقة: <b>${t.tradeCode}</b> | الزوج: <b>${t.symbol}</b>\n` +
                `🎯 الدخول: <code>${t.entry}</code> ⬅️ الإغلاق: <code>${livePriceNum}</code>\n` +
                `📉 الخسارة: <b>-${lostPips} Pips 🔴</b>\n` +
                `⏰ وقت الإغلاق: ${t.closedTimeFormatted}`
            );
          }
        }
      }
    }
  }

  if (updated) saveLedger(trades);
  return updated;
}

/**
 * حساب إحصائيات السجل وحصاد النقاط (Pips) اليومي والكلي
 */
function getLedgerStatsSummary() {
  const trades = loadLedger();
  const todayStr = getEgyptDateString();

  // تحديث السعر الحي والـ Pips الجارية لأي صفقة مفتوحة
  trades.forEach((t) => {
    if (t.status === "OPEN" && latestLiveTicks[t.symbol]) {
      t.currentLivePrice = latestLiveTicks[t.symbol].price;
      t.livePips = calculatePips(t.symbol, t.entry, t.currentLivePrice, t.direction);
    }
  });

  const wins = trades.filter((t) => t.status === "WIN").length;
  const losses = trades.filter((t) => t.status === "LOSS").length;
  const breakEvens = trades.filter((t) => t.status === "BE").length;
  const openCount = trades.filter((t) => t.status === "OPEN").length;
  const decided = wins + losses;
  const winRate = decided > 0 ? Math.round((wins / decided) * 100) : 100;

  // حساب حصاد نقاط اليوم (Today's Pips Summary)
  const todayTrades = trades.filter((t) => (t.openedDate || todayStr) === todayStr);
  let todayWonPips = 0;
  let todayLostPips = 0;

  todayTrades.forEach((t) => {
    const p = Number(t.pipsResult || 0);
    if (t.status === "WIN" && p > 0) todayWonPips += p;
    if (t.status === "LOSS" && p < 0) todayLostPips += Math.abs(p);
  });

  todayWonPips = Number(todayWonPips.toFixed(1));
  todayLostPips = Number(todayLostPips.toFixed(1));
  const todayNetPips = Number((todayWonPips - todayLostPips).toFixed(1));

  return {
    todayDate: todayStr,
    totalRecorded: trades.length,
    openCount,
    wins,
    losses,
    breakEvens,
    winRate,
    todayStats: {
      totalToday: todayTrades.length,
      winsToday: todayTrades.filter((t) => t.status === "WIN").length,
      lossesToday: todayTrades.filter((t) => t.status === "LOSS").length,
      beToday: todayTrades.filter((t) => t.status === "BE").length,
      openToday: todayTrades.filter((t) => t.status === "OPEN").length,
      wonPips: todayWonPips,
      lostPips: todayLostPips,
      netPips: todayNetPips,
    },
    recentTrades: trades.slice(-40).reverse(),
  };
}

/**
 * إرسال التقرير اليومي المفصل بالنقاط (Pips) إلى تليجرام
 */
async function sendDailyTelegramReport() {
  const summary = getLedgerStatsSummary();
  const td = summary.todayStats;
  const netSign = td.netPips >= 0 ? "+" : "";
  const netEmoji = td.netPips >= 0 ? "🟢 ربح صافي" : "🔴 خسارة صافية";

  const msg =
    `📊 <b>تقرير الحصاد اليومي لرادار الفوركس المؤسسي</b>\n` +
    `📅 التاريخ: <b>${summary.todayDate}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🔢 إجمالي صفقات اليوم: <b>${td.totalToday}</b>\n` +
    `✅ الصفقات الرابحة: <b>${td.winsToday}</b>\n` +
    `🛡️ صفقات مؤمّنة (Break-Even): <b>${td.beToday}</b>\n` +
    `❌ الصفقات الخاسرة: <b>${td.lossesToday}</b>\n` +
    `⏳ صفقات جارية الآن: <b>${td.openToday}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📈 إجمالي نقاط المكسب: <b>+${td.wonPips} Pips 🟢</b>\n` +
    `📉 إجمالي نقاط الخسارة: <b>-${td.lostPips} Pips 🔴</b>\n` +
    `🏆 <b>الصافي النهائي لليوم: ${netSign}${td.netPips} Pips (${netEmoji})</b>\n` +
    `🎯 نسبة الدقة العامة: <b>${summary.winRate}%</b>`;

  return await sendCustomTelegramMessage(msg);
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
        const changed = await evaluateOpenTradesWithLivePrice(sym, ticks[sym].price);
        if (changed) anyTradeChanged = true;
      }

      if (anyTradeChanged) {
        io.emit("ledger_updated", getLedgerStatsSummary());
      }
    }
  } catch (e) {}
}, 2000);

async function auditAndRecordSignal(symbol, timeframe, currentPrice, aiDecision, sessionInfo, fullResultForTelegram) {
  if (sessionInfo?.isMarketClosed) {
    return getLedgerStatsSummary();
  }

  const numPrice = Number(currentPrice);
  await evaluateOpenTradesWithLivePrice(symbol, numPrice);

  const trades = loadLedger();
  const sig = (aiDecision.signal || "").trim();
  const conf = Number(aiDecision.confidenceScore || 0);
  const isConfirmedSuperStrong = (sig === "صعود قوي" || sig === "هبوط قوي") && conf >= 85;

  if (isConfirmedSuperStrong) {
    const isBuy = sig === "صعود قوي";
    const direction = isBuy ? "BUY" : "SELL";
    const nowMs = Date.now();

    const hasOpenSamePair = trades.some((t) => t.symbol === symbol && t.status === "OPEN");
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
        const expectedPips = Math.abs(calculatePips(symbol, numPrice, tp1Val, direction));
        const newTrade = {
          id: nowMs,
          tradeCode: `#${String(nowMs).slice(-4)}`,
          time: new Date().toISOString(),
          openedAtMs: nowMs,
          openedDate: getEgyptDateString(),
          openedTimeFormatted: formatEgyptTime(),
          closedTimeFormatted: null,
          closedDate: null,
          symbol,
          timeframe,
          signal: sig,
          direction,
          confidence: conf,
          entry: numPrice,
          currentLivePrice: numPrice,
          livePips: 0,
          expectedTpPips: expectedPips,
          pipsResult: 0,
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

// مسار لإرسال تقرير اليوم على تليجرام يدوياً في أي لحظة
app.post("/api/send-daily-report", async (req, res) => {
  const sent = await sendDailyTelegramReport();
  res.json({ sent, message: sent ? "✅ تم إرسال تقرير نقاط اليوم إلى تليجرام بنجاح!" : "⚠️ تعذر الإرسال لتليجرام." });
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

// فحص دوري كل 5 دقائق لجميع الأزواج
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

// إرسال تقرير الحصاد اليومي للـ Pips تلقائياً كل يوم الساعة 23:55 بتوقيت مصر
cron.schedule(
  "55 23 * * 1-5",
  async () => {
    try {
      await sendDailyTelegramReport();
    } catch (e) {}
  },
  { timezone: "Africa/Cairo" }
);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 منصة الفوركس الحية (سجل دائم + حساب Pips + تليجرام تفاعلي) تعمل على البورت: ${PORT}`);
});