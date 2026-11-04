// backend/telegram_service.js
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

let detectedUserChatId = null;

function extractNumber(str) {
  if (!str) return null;
  const match = String(str).match(/\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function calcPipsForTelegram(symbol, entryPrice, targetPrice, isBuy) {
  const entry = Number(entryPrice);
  const target = Number(targetPrice);
  if (!entry || !target || isNaN(entry) || isNaN(target)) return 0;
  const diff = isBuy ? target - entry : entry - target;
  let mult = 10000;
  if (symbol === "XAUUSD") mult = 10;
  else if (symbol === "USDJPY") mult = 100;
  return Math.abs(Number((diff * mult).toFixed(1)));
}

/**
 * اكتشاف الـ Chat ID الشخصي تلقائياً من ملف .env أو من آخر رسالة (/start) أرسلتها للبوت
 */
export async function resolveUserChatId(token) {
  const envChatId = process.env.TELEGRAM_CHAT_ID;
  const botOwnId = token.split(":")[0];

  if (envChatId && envChatId !== botOwnId && !envChatId.includes("حط")) {
    return envChatId;
  }
  if (detectedUserChatId) return detectedUserChatId;

  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
      timeout: 6000,
    });
    const updates = res.data?.result || [];
    for (let i = updates.length - 1; i >= 0; i--) {
      const chat = updates[i].message?.chat;
      if (chat && String(chat.id) !== botOwnId) {
        detectedUserChatId = String(chat.id);
        console.log(`✅ تم ربط حسابك الشخصي في تليجرام تلقائياً (ID: ${detectedUserChatId})`);
        return detectedUserChatId;
      }
    }
  } catch (err) {
    console.error("⚠️ تعذر جلب التحديثات تلقائياً:", err.message);
  }
  return null;
}

/**
 * الفلتر الأساسي لتليجرام (متطابق تماماً مع شروط جدول الصفقات في server.js بدون تعارض)
 */
export function validateSignalQuality(analysisData) {
  if (analysisData.sessionInfo?.isMarketClosed) {
    return {
      isValid: false,
      reason: "🛑 السوق مغلق حالياً في عطلة نهاية الأسبوع.",
    };
  }

  const sig = (analysisData.signal || "").trim();
  const conf = Number(analysisData.confidenceScore || 0);

  const isStrictlyStrong = sig === "صعود قوي" || sig === "هبوط قوي";
  if (!isStrictlyStrong) {
    return {
      isValid: false,
      reason: `الإشارة الحالية (${sig}) ليست صعود قوي أو هبوط قوي.`,
    };
  }

  if (conf < 80) {
    return {
      isValid: false,
      reason: `درجة الثقة (${conf}%) أقل من الحد الإلزامي.`,
    };
  }

  const entry = Number(analysisData.currentPrice);
  const sl = extractNumber(analysisData.tradeSetup?.stopLoss);
  const tp1 = extractNumber(analysisData.tradeSetup?.takeProfit1);

  if (entry && sl && tp1) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp1 - entry);
    const rrRatio = risk > 0 ? Number((reward / risk).toFixed(2)) : 1.25;
    return {
      isValid: true,
      rrRatio: `1:${rrRatio}`,
      reason: "✅ صفقة قوية مؤكدة",
    };
  }

  return {
    isValid: true,
    rrRatio: "1:1.5",
    reason: "✅ صفقة قوية مؤكدة",
  };
}

/**
 * إرسال فوري ومضمون 100% لكل صفقة تُسجل في الموقع إلى تليجرام (مع حساب الـ Pips وبدون Cooldown ساعتين يحجب الصفقات!)
 */
export async function sendTelegramSignal(analysisData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.includes("حط_التوكن")) {
    return { sent: false, message: "⚠️ لم يتم وضع TELEGRAM_BOT_TOKEN داخل ملف .env" };
  }

  const chatId = await resolveUserChatId(token);
  if (!chatId) {
    return {
      sent: false,
      message: "⚠️ افتح بوتك في تليجرام وابعتله رسالة /start أولاً ليتعرف على حسابك تلقائياً.",
    };
  }

  const quality = validateSignalQuality(analysisData);
  if (!quality.isValid) {
    return {
      sent: false,
      filteredOut: true,
      message: quality.reason,
    };
  }

  const isBull = analysisData.signal === "صعود قوي";
  const emoji = isBull ? "🟢🚀🔥" : "🔴📉🔥";
  const entry = analysisData.tradeSetup?.entryZone || analysisData.currentPrice;
  const sl = analysisData.tradeSetup?.stopLoss;
  const tp1 = analysisData.tradeSetup?.takeProfit1;
  const tp2 = analysisData.tradeSetup?.takeProfit2;

  const tp1Pips = calcPipsForTelegram(analysisData.symbol, entry, tp1, isBull);
  const slPips = calcPipsForTelegram(analysisData.symbol, entry, sl, isBull);
  const tradeCodeText = analysisData.tradeCode ? ` | <b>الكود:</b> <code>${analysisData.tradeCode}</code>` : "";

  const htmlMessage =
    `${emoji} <b>صفقة مؤكدة | رادار الفوركس المؤسسي</b> ${emoji}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>الزوج:</b> <code>${escapeHtml(analysisData.symbol)}</code> | <b>الفريم:</b> <code>${escapeHtml(analysisData.timeframe)}</code>${tradeCodeText}\n` +
    `📣 <b>القرار المؤكد:</b> <b>${escapeHtml(analysisData.signal)}</b>\n` +
    `🎯 <b>درجة الثقة:</b> <code>${analysisData.confidenceScore}%</code> (${escapeHtml(analysisData.consensusCount || "إجماع المدارس")})\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🔵 <b>سعر الدخول:</b> <code>${escapeHtml(entry)}</code>\n` +
    `✅ <b>الهدف الأول (TP1):</b> <code>${escapeHtml(tp1)}</code> (<b>+${tp1Pips} Pips 🟢</b>)\n` +
    `🚀 <b>الهدف الثاني (TP2):</b> <code>${escapeHtml(tp2)}</code>\n` +
    `🛑 <b>وقف الخسارة (SL):</b> <code>${escapeHtml(sl)}</code> (<b>-${slPips} Pips 🔴</b>)\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏦 <b>تمركز السيولة (POC):</b> <code>${escapeHtml(analysisData.rawIndicators?.volumeAnalysis?.pocPrice || "-")}</code>\n` +
    `📊 <b>توافق الفريمات:</b> ${escapeHtml(analysisData.mtfReport?.mtfStatus || "-")}\n` +
    `📰 <b>توافق الأخبار والفيدرالي:</b>\n${escapeHtml(analysisData.macroNewsIntegration || analysisData.summaryArabic || "-")}\n\n` +
    `🧠 <b>المراجعة النهائية لكبير المحللين:</b>\n${escapeHtml(analysisData.aiFinalReview || analysisData.summaryArabic || "-")}`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await axios.post(
      url,
      {
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: "HTML",
      },
      { timeout: 8000 }
    );
    return {
      sent: true,
      chatIdUsed: chatId,
      message: `✅ تم إرسال الصفقة المؤكدة (${analysisData.signal}) إلى تليجرام بنجاح!`,
    };
  } catch (error) {
    // محاولة ثانية فورية بدون تنسيق في حال وجود أي حرف غير مدعوم
    try {
      const plainText = htmlMessage.replace(/<[^>]*>?/gm, "");
      await axios.post(
        url,
        {
          chat_id: chatId,
          text: plainText,
        },
        { timeout: 8000 }
      );
      return {
        sent: true,
        chatIdUsed: chatId,
        message: `✅ تم إرسال الصفقة المؤكدة (${analysisData.signal}) إلى تليجرام بنجاح!`,
      };
    } catch (fallbackErr) {
      console.error("❌ فشل إرسال رسالة تليجرام:", fallbackErr.message);
      return {
        sent: false,
        message: fallbackErr.response?.data?.description || fallbackErr.message,
      };
    }
  }
}

/**
 * إرسال إشعارات المتابعة الحية (تأمين الدخول / ضرب الهدف بالـ Pips / ضرب الستوب) إلى نفس الشات
 */
export async function sendTelegramCustomUpdate(htmlText) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.includes("حط_التوكن")) return false;

  const chatId = await resolveUserChatId(token);
  if (!chatId) return false;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await axios.post(
      url,
      {
        chat_id: chatId,
        text: htmlText,
        parse_mode: "HTML",
      },
      { timeout: 8000 }
    );
    return true;
  } catch (e) {
    try {
      await axios.post(
        url,
        {
          chat_id: chatId,
          text: String(htmlText).replace(/<[^>]*>?/gm, ""),
        },
        { timeout: 8000 }
      );
      return true;
    } catch (err2) {
      return false;
    }
  }
}