const axios = require('axios');
const { redis } = require('./database');

const aiKey = process.env.GEMINI_API_KEY;

async function askGemini(jid, prompt, isOwnerMessage = false) {
    if (!aiKey) return '⚠️ الذكاء الاصطناعي غير مفعل.';
    
    if (prompt.length > 3000) {
        throw new Error('TOO_LONG');
    }

    try {
        let historyArray = await redis.lrange(`context:${jid}`, -10, -1);
        let modified = false;
        
        let fullHistoryStr = historyArray.join('\n');
        while (fullHistoryStr.length > 3000 && historyArray.length > 1) {
            historyArray.shift(); 
            historyArray.shift(); 
            fullHistoryStr = historyArray.join('\n');
            modified = true;
        }

        if (historyArray.length === 1 && historyArray[0].length > 3000) {
            historyArray[0] = historyArray[0].substring(historyArray[0].length - 3000);
            modified = true;
        }

        if (modified) {
            await redis.del(`context:${jid}`);
            if (historyArray.length > 0) await redis.rpush(`context:${jid}`, ...historyArray);
        }
        
        let systemInstruction = "";
        
        if (isOwnerMessage) {
            systemInstruction = "أنت الذكاء الاصطناعي الخاص والمساعد المباشر للمبرمج عامر. أنت الآن تتحدث مع عامر نفسه (المالك). أجب عليه مباشرة، نفذ أوامره بدقة، كن عملياً ومختصراً.\n\n";
        } else {
            systemInstruction = "تعليمات مساعدة لعامر:\n1. لا تخبر أحداً أنك مساعد أو ذكاء اصطناعي إلا إذا سألك مباشرة. حينها أخبره أنك مساعد عامر.\n2. قلد نفس أسلوب المتحدث في الطول والبرود أو المرح.\n3. أجب بشكل طبيعي كأنك تدردش عبر الواتساب.\n\n";
        }
        
        let fullPrompt = systemInstruction + historyArray.join('\n') + '\nالمستخدم: ' + prompt;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${aiKey}`,
            { contents: [{ parts: [{ text: fullPrompt }] }] },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );

        const candidate = response.data.candidates[0];
        
        if (candidate.finishReason === 'SAFETY' || !candidate.content) {
            throw new Error('SAFETY_BLOCK');
        }

        const reply = candidate.content.parts[0].text;

        await redis.rpush(`context:${jid}`, `المستخدم: ${prompt}`, `أنت: ${reply}`);
        await redis.ltrim(`context:${jid}`, -10, -1); 
        await redis.expire(`context:${jid}`, 86400);

        return reply;
    } catch (error) {
        let apiError = error.response?.data?.error?.message || error.message;
        throw new Error(apiError);
    }
}

module.exports = { askGemini };
