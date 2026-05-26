const axios = require('axios');
const { redis } = require('./database');

const aiKey = process.env.GEMINI_API_KEY;

async function askGemini(jid, prompt, isOwnerMessage = false) {
    if (!aiKey) return '⚠️ الذكاء الاصطناعي غير مفعل.';
    
    // تم زيادة الحد قليلاً لكتابة أوامر أو استفسارات متوسطة
    if (prompt.length > 1500) {
        throw new Error('TOO_LONG');
    }

    try {
        // العودة لحفظ آخر 10 رسائل (5 من المستخدم و 5 من البوت) لتقوية الذاكرة
        let historyArray = await redis.lrange(`context:${jid}`, -10, -1);
        let modified = false;
        
        let fullHistoryStr = historyArray.join('\n');
        // تم زيادة مساحة السياق الكلية لـ 2000 حرف لتستوعب الرسائل العشر
        while (fullHistoryStr.length > 2000 && historyArray.length > 1) {
            historyArray.shift(); 
            historyArray.shift(); 
            fullHistoryStr = historyArray.join('\n');
            modified = true;
        }

        if (historyArray.length === 1 && historyArray[0].length > 2000) {
            historyArray[0] = historyArray[0].substring(historyArray[0].length - 2000);
            modified = true;
        }

        if (modified) {
            await redis.del(`context:${jid}`);
            if (historyArray.length > 0) await redis.rpush(`context:${jid}`, ...historyArray);
        }
        
        let systemInstruction = isOwnerMessage 
            ? "أنت مساعد المبرمج عامر. أجب مباشرة، نفذ الأوامر بدقة، وكن مختصراً.\n\n" 
            : "1. أنت مساعد عامر.\n2. قلد أسلوب المستخدم.\n3. أجب كأنك تدردش عبر واتساب.\n\n";
        
        let fullPrompt = systemInstruction + historyArray.join('\n') + '\nالمستخدم: ' + prompt;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${aiKey}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );

        const candidate = response.data.candidates[0];
        
        if (candidate.finishReason === 'SAFETY' || !candidate.content) {
            throw new Error('SAFETY_BLOCK');
        }

        const reply = candidate.content.parts[0].text;

        await redis.rpush(`context:${jid}`, `المستخدم: ${prompt}`, `أنت: ${reply}`);
        await redis.ltrim(`context:${jid}`, -10, -1); // ضمان بقاء 10 رسائل في Redis
        await redis.expire(`context:${jid}`, 86400);

        return reply;
    } catch (error) {
        let apiError = error.response?.data?.error?.message || error.message;
        throw new Error(apiError);
    }
}

module.exports = { askGemini };
