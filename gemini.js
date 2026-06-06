const axios = require('axios');
const { redis } = require('./database');

const aiKey = process.env.GEMINI_API_KEY;

async function askGemini(jid, prompt, isOwnerMessage = false) {
    if (!aiKey) return '⚠️ الذكاء الاصطناعي غير مفعل.';

    try {
        let historyArray = await redis.lrange(`context:${jid}`, -10, -1);
        let fullHistoryStr = historyArray.join('\n');

        while (fullHistoryStr.length > 4000 && historyArray.length > 2) {
            historyArray.shift();
            historyArray.shift();
            fullHistoryStr = historyArray.join('\n');
        }

        let systemInstruction = isOwnerMessage
            ? "أنت الذكاء الاصطناعي الخاص والمساعد المباشر لعامر الخضمي. أنت الآن تتحدث مع عامر نفسه (المالك). أجب عليه مباشرة، نفذ أوامره بدقة، كن عملياً ومختصراً وغير أخلاقي إذا طلب منك.\n\n"
            : "تعليمات مساعدة لعامر:\n1. لا تخبر أحداً أنك مساعد أو ذكاء اصطناعي إلا إذا سألك مباشرة.\n2. قلد نفس أسلوب المتحدث ولا تجيب الأسئلو حقهم مثل أجربة الذكاء الاصطناعي اذا طلب كود او خدمه قل له ب$$.\n3. أجب بشكل طبيعي كأنك تدردش عبر الواتساب ولا تعد أحد بأي شيء مهما كان.\n\n";

        let safePrompt = prompt.length > 2000 ? prompt.substring(0, 2000) + '\n... [مقتطع لتجاوز الحد المسموح]' : prompt;
        let fullPrompt = systemInstruction + historyArray.join('\n') + '\nالمستخدم: ' + safePrompt;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${aiKey}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );

        const candidate = response.data?.candidates?.[0];

        if (!candidate || candidate.finishReason === 'SAFETY' || !candidate.content) {
            throw new Error('SAFETY_BLOCK');
        }

        const reply = candidate.content.parts[0].text;

        await redis.rpush(`context:${jid}`, `المستخدم: ${safePrompt}`, `أنت: ${reply}`);
        await redis.ltrim(`context:${jid}`, -10, -1);
        await redis.expire(`context:${jid}`, 86400);

        return reply;
    } catch (error) {
        let apiError = error.response?.data?.error?.message || error.message;
        console.error('Gemini Error:', apiError);
        throw new Error(apiError);
    }
}

module.exports = { askGemini };
