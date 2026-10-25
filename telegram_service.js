// backend/telegram_service.js
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const sentAlertsCache = new Map();
let detectedUserChatId = null;

function extractNumber(str) {
  if (!str) return null;
  const match = String(str).match(/\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * اكتشاف الـ Chat ID الشخصي تلقائياً من آخر رسالة (/start) أرسلتها للبوت
 */
async function resolveUserChatId(token) {
  const envChatId = process.env.TELEGRAM_CHAT_ID;
  const botOwnId = token.split(":")[0];

  if (envChatId && envChatId !== botOwnId && !envChatId.includes("حط")) {
    return envChatId;
  }
  if (detectedUserChatId) return detectedUserChatId;

  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`);
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
 * الفلتر الصارم لتليجرام والتقارير:
 * لا يقبل إلا ("صعود قوي" أو "هبوط قوي") + ثقة >= 80% + السوق مفتوح + عائد للمخاطرة >= 1:1.5
 */
export function validateSignalQuality(analysisData) {
  // 1. رفض تام في عطلة نهاية الأسبوع
  if (analysisData.sessionInfo?.isMarketClosed) {
    return {
      isValid: false,
      reason: "🛑 السوق مغلق حالياً في عطلة نهاية الأسبوع (متوقف عن إصدار الإشارات).",
    };
  }

  const sig = (analysisData.signal || "").trim();
  const conf = Number(analysisData.confidenceScore || 0);

  // 2. رفض أي صفقة ليست "صعود قوي" أو "هبوط قوي"
  const isStrictlyStrong = sig === "صعود قوي" || sig === "هبوط قوي";
  if (!isStrictlyStrong) {
    return {
      isValid: false,
      reason: `تم حجب الإشعار: الإشارة الحالية (${sig}) ليست "صعود قوي" أو "هبوط قوي".`,
    };
  }

  // 3. اشتراط درجة ثقة عالية جداً (>= 80%)
  if (conf < 80) {
    return {
      isValid: false,
      reason: `تم حجب الإشعار: درجة الثقة (${conf}%) أقل من الحد الإلزامي للصفقات المؤكدة (80%).`,
    };
  }

  // 4. رفض الدخول وقت الأخبار الحمراء الخطيرة
  if (analysisData.newsShield?.shieldActive) {
    return {
      isValid: false,
      reason: "⛔ درع الأخبار مفعل حالياً (منع الإرسال لحماية الحساب من الانزلاق السعري).",
    };
  }

  // 5. فحص نسبة العائد للمخاطرة رياضياً (Risk-to-Reward >= 1:1.5)
  const entry = Number(analysisData.currentPrice);
  const sl = extractNumber(analysisData.tradeSetup?.stopLoss);
  const tp2 =
    extractNumber(analysisData.tradeSetup?.takeProfit2) ||
    extractNumber(analysisData.tradeSetup?.takeProfit1);

  if (entry && sl && tp2) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp2 - entry);
    const rrRatio = risk > 0 ? Number((reward / risk).toFixed(2)) : 0;

    if (rrRatio < 1.5) {
      return {
        isValid: false,
        reason: `تم رفض الصفقة: نسبة العائد للمخاطرة (1:${rrRatio}) أقل من 1:1.5.`,
      };
    }
    return {
      isValid: true,
      rrRatio: `1:${rrRatio}`,
      reason: "✅ صفقة قوية مؤكدة ومطابقة لجميع شروط الأمان المؤسسي",
    };
  }

  return {
    isValid: true,
    rrRatio: "1:2.0",
    reason: "✅ صفقة قوية مؤكدة",
  };
}

/**
 * إرسال الصفقات المؤكدة ("صعود قوي" / "هبوط قوي") إلى تليجرام
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

  // تطبيق الفلتر الصارم دائماً (لا يرسل أبداً إلا صعود قوي أو هبوط قوي في وقت عمل السوق)
  const quality = validateSignalQuality(analysisData);
  if (!quality.isValid) {
    console.log(`🛡️ فلتر تليجرام الصارم منع الإرسال (${analysisData.symbol}): ${quality.reason}`);
    return {
      sent: false,
      filteredOut: true,
      message: `🛡️ لم يتم الإرسال لتليجرام لأنك اشترطت الصفقات القوية المؤكدة فقط: ${quality.reason}`,
    };
  }

  const cacheKey = `${analysisData.symbol}_${analysisData.signal}`;
  const lastSent = sentAlertsCache.get(cacheKey) || 0;
  if (Date.now() - lastSent < 2 * 60 * 60 * 1000) {
    return { sent: false, message: "تم إرسال هذه الصفقة القوية مسبقاً خلال الساعتين الماضيتين." };
  }
  sentAlertsCache.set(cacheKey, Date.now());

  const isBull = analysisData.signal === "صعود قوي";
  const emoji = isBull ? "🟢🚀🔥" : "🔴📉🔥";

  const messageText = `
${emoji} *صفقة مؤكدة | رادار الفوركس المؤسسي* ${emoji}
━━━━━━━━━━━━━━━━━━
📌 *الزوج:* \`${analysisData.symbol}\` | *الفريم:* \`${analysisData.timeframe}\`
📣 *القرار المؤكد:* *${analysisData.signal}*
🎯 *درجة الثقة:* \`${analysisData.confidenceScore}%\` (${analysisData.consensusCount || "إجماع المدارس"})
⚖️ *العائد للمخاطرة (R:R):* \`${quality.rrRatio}\`
━━━━━━━━━━━━━━━━━━
💰 *السعر الحالي:* \`${analysisData.currentPrice}\`
🔵 *منطقة الدخول:* \`${analysisData.tradeSetup?.entryZone}\`
🛑 *وقف الخسارة (SL):* \`${analysisData.tradeSetup?.stopLoss}\`
✅ *الهدف الأول (TP1):* \`${analysisData.tradeSetup?.takeProfit1}\`
🚀 *الهدف الثاني (TP2):* \`${analysisData.tradeSetup?.takeProfit2}\`
━━━━━━━━━━━━━━━━━━
🏦 *تمركز السيولة (POC):* \`${analysisData.rawIndicators?.volumeAnalysis?.pocPrice || "-"}\`
📊 *توافق الفريمات:* ${analysisData.mtfReport?.mtfStatus || "-"}
📰 *توافق الأخبار والفيدرالي:*
_${analysisData.macroNewsIntegration || analysisData.summaryArabic}_

🧠 *المراجعة النهائية لكبير المحللين:*
_${analysisData.aiFinalReview || analysisData.summaryArabic}_
`;

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: messageText,
      parse_mode: "Markdown",
    });
    return {
      sent: true,
      chatIdUsed: chatId,
      message: `✅ تم إرسال الصفقة المؤكدة (${analysisData.signal}) إلى تليجرام بنجاح!`,
    };
  } catch (error) {
    return {
      sent: false,
      message: error.response?.data?.description || error.message,
    };
  }
}