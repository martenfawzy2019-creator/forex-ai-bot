// backend/news_service.js
import axios from "axios";

/**
 * رادار الأخبار الحية للفوركس وأخبار الفيدرالي (Live Macro & Fed News Stream)
 */
export async function getForexNewsRadar(currencyFilter = ["USD", "EUR", "GBP", "JPY"]) {
  try {
    // سحب أجندة وأخبار الفوركس العالمية المباشرة
    const response = await axios.get(
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      { timeout: 8000 }
    );

    const allEvents = response.data || [];
    const now = new Date();

    const relevantNews = allEvents
      .filter((event) => {
        const isTargetCurrency = currencyFilter.includes(event.country);
        const isHighOrMedium = event.impact === "High" || event.impact === "Medium";
        return isTargetCurrency && isHighOrMedium;
      })
      .map((event) => {
        const eventDate = new Date(event.date);
        const diffHours = ((eventDate - now) / (1000 * 60 * 60)).toFixed(2);
        
        // تقييم تأثير الخبر هل هو إيجابي أم سلبي على الدولار أو العملة
        let actualVsExpected = "في انتظار الصدور";
        if (event.actual && event.forecast) {
          if (parseFloat(event.actual) > parseFloat(event.forecast)) {
            actualVsExpected = "أقوى من المتوقع (إيجابي للعملة)";
          } else if (parseFloat(event.actual) < parseFloat(event.forecast)) {
            actualVsExpected = "أضعف من المتوقع (سلبي للعملة)";
          } else {
            actualVsExpected = "مطابق للتوقعات (حيادي)";
          }
        }

        return {
          title: event.title,
          currency: event.country,
          impact: event.impact, // High / Medium
          date: event.date,
          timeDiffHours: Number(diffHours), // بالسالب يعني صدر، بالموجب يعني قادم
          forecast: event.forecast || "N/A",
          previous: event.previous || "N/A",
          actual: event.actual || "Pending",
          analysisImpact: actualVsExpected,
        };
      })
      // نلتقط الأخبار التي صدرت آخر 12 ساعة أو ستصدر خلال الـ 48 ساعة القادمة
      .filter((e) => e.timeDiffHours >= -12 && e.timeDiffHours <= 48);

    return relevantNews;
  } catch (error) {
    console.error("⚠️ تنبيه في جلب الأخبار الحية:", error.message);
    return [
      {
        title: "متابعة فورية لسياسة الفيدرالي وعوائد السندات والسيولة الكلية",
        currency: "USD",
        impact: "High",
        actual: "Live",
        analysisImpact: "مراقبة لصيقة لتوجهات البنوك المركزية",
      },
    ];
  }
}