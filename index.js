const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const Redis = require('ioredis');
const express = require('express');
const axios = require('axios');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 10000;

const redis = new Redis(process.env.REDIS_URL);
redis.on('error', (err) => console.error('⚠️ خطأ في اتصال Redis:', err));

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

async function useRedisAuthState(redisClient, sessionId) {
    const writeData = async (data, key) => await redisClient.set(`${sessionId}:${key}`, JSON.stringify(data, BufferJSON.replacer));
    const readData = async (key) => {
        const data = await redisClient.get(`${sessionId}:${key}`);
        return data ? JSON.parse(data, BufferJSON.reviver) : null;
    };
    const removeData = async (key) => await redisClient.del(`${sessionId}:${key}`);
    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

const aiKey = process.env.GEMINI_API_KEY;
const OWNER_NUMBER = process.env.OWNER_NUMBER || "967782541491";

async function askGemini(jid, prompt, isOwnerMessage = false) {
    if (!aiKey) return '⚠️ الذكاء الاصطناعي غير مفعل.';
    
    if (prompt.length > 3000) {
        throw new Error('TOO_LONG');
    }

    try {
        let historyArray = await redis.lrange(`context:${jid}`, -10, -1);
        let modified = false;
        
        while (historyArray.join('\n').length > 3000 && historyArray.length > 1) {
            historyArray.shift(); 
            historyArray.shift(); 
            modified = true;
        }

        if (modified) {
            await redis.del(`context:${jid}`);
            if (historyArray.length > 0) await redis.rpush(`context:${jid}`, ...historyArray);
        }
        
        let systemInstruction = "";
        
        if (isOwnerMessage) {
            systemInstruction = "أنت الذكاء الاصطناعي الخاص والمساعد المباشر للمبرمج عامر الخضمي. أنت الآن تتحدث مع عامر نفسه (المالك). أجب عليه مباشرة، نفذ أوامره بدقة، كن عملياً ومختصراً، ولا ترحب به بصيغة الغائب أو كأنه شخص غريب.\n\n";
        } else {
            systemInstruction = "تعليمات صارمة جداً لك كمساعد شخصي لعامر الخضمي:\n1. (السرية): لا تخبر أحداً أنك مساعد أو ذكاء اصطناعي إلا إذا سألك الشخص مباشرة 'من أنت؟' أو 'هل أنت عامر؟'. حينها فقط أخبره أنك مساعد عامر.\n2. (انعكاس الأسلوب - Mirroring): يجب أن تقلد نفس أسلوب المتحدث. إذا أرسل لك رسالة قصيرة وباردة، رد عليه برد قصير وبارد وبدون إيموجي. إذا كان مرحاً ومتحمساً، كن مرحاً. لا تبالغ أبداً في الترحيب والكلام الإنشائي.\n3. أجب على رسالته مباشرة وبشكل طبيعي جداً كأنك تدردش عبر الواتساب.\n4. لا تذكر اسم عامر الكامل مطلقاً، اكتفِ بـ 'عامر' فقط عند الحاجة.\n\n";
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
        if (error.message === 'TOO_LONG' || error.message === 'SAFETY_BLOCK') throw error;
        let apiError = error.response?.data?.error?.message || 'API_TIMEOUT';
        if (apiError.includes('Quota exceeded')) throw new Error('RATE_LIMIT');
        throw new Error(apiError);
    }
}

const backupReplyText = `*ೃ⁀➷ 𝑨𝒎𝒆𝒓 𝑨𝒉𝒎𝒆𝒅 𖣘⚡*\n\n*ـ الحساب غير متوفر حالياً 📴*\n*ـ يرجى ترك رسالتك بوضوح وسأرد عليك فور تواجدي 🕕*\n*ـ ممنوع الاتصال منعاً للإحراج 📵*\n\n\`شكراً لوجودك وتفهمك العالي\` ✨`;

const emojis = ['💚', '💙', '💜', '💛', '🧡', '🖤', '❤️‍🔥', '🔥', '✨', '⭐', '🌟', '💫', '⚡', '💥', '💯', '🚀', '👍', '🙌', '👏', '👌', '💪', '👑', '🥳', '🤩', '😎', '🧠', '🦁', '🦅', '🎯', '💎', '🎨', '🎬', '😇', '🙂', '😌', '😉'];
const heartEmojis = ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '🩷', '🩶', '🩵'];

const globalCommands = ['ايقاف', 'تشغيل', 'مسح كل المحظورين', 'مسح كل المكتومين', 'مسح كل ai'];
const targetedCommands = ['كتم', 'فك الكتم', 'حظر', 'فك الحظر', 'حظر ai', 'فك حظر ai'];
const allCommands = [...globalCommands, ...targetedCommands].sort((a, b) => b.length - a.length);

const processedMessages = new Set();
const messageQueue = new Map(); 
const processingUsers = new Set();
let isBotActive = true; 

function cancelAllPendingQueues() {
    for (const [qKey, qData] of messageQueue.entries()) {
        if (!qData.isOwner) {
            clearTimeout(qData.timeout);
            messageQueue.delete(qKey);
            processingUsers.delete(qKey);
        }
    }
}

async function startBot() {
    const { state, saveCreds } = await useRedisAuthState(redis, 'wa_session_v7');
    
    const storedState = await redis.get('bot_active_state');
    isBotActive = storedState !== 'false';

    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60000
    });
    
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('✅ البوت متصل ومستعد للعمل، الجلسة محفوظة بأمان في السحابة!');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('جارِ إعادة الاتصال بعد 5 ثوانٍ...');
                setTimeout(startBot, 5000);
            }
        }
    });

    setTimeout(async () => {
        if (!sock.authState.creds.registered) {
            console.log("⏳ جارِ طلب كود الربط...");
            try {
                let code = await sock.requestPairingCode(OWNER_NUMBER);
                console.log("🔥 الكود الحقيقي والمطابق هو: " + code);
            } catch (e) {
                console.error("⚠️ خطأ في توليد كود الربط:", e.message);
            }
        }
    }, 6000);

    sock.ev.on('messages.update', (updates) => {
        for (const { key, update } of updates) {
            if (update.status === 4 || update.status === 'READ') {
                const qKey = `user_${key.remoteJid}`;
                if (messageQueue.has(qKey)) {
                    clearTimeout(messageQueue.get(qKey).timeout);
                    messageQueue.delete(qKey);
                    processingUsers.delete(qKey);
                }
            }
        }
    });

    sock.ev.on('message-receipt.update', (updates) => {
        for (const receipt of updates) {
            if (receipt.receipt?.receiptTimestamp || receipt.receipt?.type === 3 || receipt.receipt?.type === 'read') {
                const qKey = `user_${receipt.key.remoteJid}`;
                if (messageQueue.has(qKey)) {
                    clearTimeout(messageQueue.get(qKey).timeout);
                    messageQueue.delete(qKey);
                    processingUsers.delete(qKey);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        for (const msg of chatUpdate.messages) {
            if (!msg.message) continue;
            
            if (processedMessages.has(msg.key.id)) continue;
            processedMessages.add(msg.key.id);
            if (processedMessages.size > 1000) { const first = processedMessages.values().next().value; processedMessages.delete(first); }

            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant || msg.participant || remoteJid;
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const senderKey = participantJid.split('@')[0];
            const isOwner = msg.key.fromMe;

            if (isOwner) {
                cancelAllPendingQueues();
            }

            if (remoteJid === 'status@broadcast') {
                if (isOwner) {
                    cancelAllPendingQueues();
                    continue;
                }
                
                if (!isBotActive) continue;
                const [isInBlacklist, isInSilence] = await Promise.all([
                    redis.sismember('blacklist', senderKey),
                    redis.sismember('silenceList', senderKey)
                ]);
                
                try { 
                    await sock.readMessages([msg.key]);
                    if (!isInBlacklist) {
                        let reactEmoji = isInSilence ? heartEmojis[Math.floor(Math.random() * heartEmojis.length)] : emojis[Math.floor(Math.random() * emojis.length)];
                        await sock.sendMessage(participantJid, { react: { text: reactEmoji, key: msg.key } });
                        
                        const ownerJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
                        if (ownerJid) {
                            let senderName = msg.pushName || 'غير معروف';
                            let statusNote = isInSilence ? "(مكتوم)" : "";
                            await sock.sendMessage(ownerJid, { text: `👁️‍🗨️ *تفاعل مع حالة ${statusNote}*\n👤 الاسم: ${senderName}\n📱 الرقم: +${senderKey}\n✨ التفاعل: ${reactEmoji}` });
                        }
                    }
                } catch (e) {}
                continue;
            }

            if (isOwner && textMessage.startsWith('.')) {
                let rawCmd = textMessage.substring(1).trim();
                let cmdMatched = allCommands.find(cmd => rawCmd === cmd || rawCmd.startsWith(cmd + ' '));
                
                if (cmdMatched) {
                    let targetKey = null;

                    if (targetedCommands.includes(cmdMatched)) {
                        let targetNumMatch = rawCmd.match(/\d+/);
                        let targetStr = targetNumMatch ? targetNumMatch[0] : null;
                        targetKey = targetStr ? targetStr : (msg.message.extendedTextMessage?.contextInfo?.participant)?.split('@')[0];
                        
                        if (!targetKey && !remoteJid.includes('@g.us')) {
                            targetKey = remoteJid.split('@')[0];
                        }

                        if (!targetKey || targetKey.includes('@g.us')) {
                            try {
                                await sock.sendMessage(remoteJid, { text: '⚠️ لم يتم تحديد هدف صالح أو لا يمكن تنفيذ الأمر على مجموعة.' });
                            } catch(e) {}
                            continue;
                        }
                    }
                    
                    try {
                        switch(cmdMatched) {
                            case 'ايقاف': 
                                isBotActive = false; 
                                await redis.set('bot_active_state', 'false'); 
                                await sock.sendMessage(remoteJid, { text: 'تم الإيقاف 📴' }); 
                                break;
                            case 'تشغيل': 
                                isBotActive = true; 
                                await redis.set('bot_active_state', 'true'); 
                                await sock.sendMessage(remoteJid, { text: 'تم التشغيل ✅' }); 
                                break;
                            case 'كتم': await redis.sadd('silenceList', targetKey); await sock.sendMessage(remoteJid, { text: `تم كتم الهدف 🔇` }); break;
                            case 'فك الكتم': await redis.srem('silenceList', targetKey); await sock.sendMessage(remoteJid, { text: `تم فك الكتم 🔊` }); break;
                            case 'حظر ai': await redis.sadd('aiBlacklist', targetKey); await sock.sendMessage(remoteJid, { text: `تم منعه من الذكاء الاصطناعي 🤖❌` }); break;
                            case 'فك حظر ai': await redis.srem('aiBlacklist', targetKey); await sock.sendMessage(remoteJid, { text: `تم السماح له بالذكاء الاصطناعي 🤖✅` }); break;
                            case 'حظر': await redis.sadd('blacklist', targetKey); await sock.sendMessage(remoteJid, { text: `تم حظر الهدف 🚫` }); break;
                            case 'فك الحظر': await redis.srem('blacklist', targetKey); await sock.sendMessage(remoteJid, { text: `تم فك الحظر ✅` }); break;
                            case 'مسح كل المحظورين': await redis.del('blacklist'); await sock.sendMessage(remoteJid, { text: 'تم مسح المحظورين 🗑️' }); break;
                            case 'مسح كل المكتومين': await redis.del('silenceList'); await sock.sendMessage(remoteJid, { text: 'تم مسح المكتومين 🗑️' }); break;
                            case 'مسح كل ai': await redis.del('aiBlacklist'); await sock.sendMessage(remoteJid, { text: 'تم مسح قائمة AI 🗑️' }); break;
                        }
                    } catch(e) {}
                    continue; 
                }
            }

            const queueKey = isOwner ? `owner_${remoteJid}` : `user_${remoteJid}`;

            if (isOwner && messageQueue.has(queueKey)) {
                clearTimeout(messageQueue.get(queueKey).timeout);
            }

            let isOwnerAiPrompt = isOwner && textMessage.startsWith('.');
            let isNormalUser = !isOwner && isBotActive && !remoteJid.includes('@g.us');

            if (!isOwnerAiPrompt && !isNormalUser) continue;
            if (isNormalUser && !textMessage.trim()) continue;

            const isAiBlacklisted = await redis.sismember('aiBlacklist', senderKey);

            let quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
            let quotedText = quotedMsg?.conversation || 
                             quotedMsg?.extendedTextMessage?.text || 
                             quotedMsg?.imageMessage?.caption || 
                             quotedMsg?.videoMessage?.caption || "";
                             
            let coreMessage = isOwnerAiPrompt ? textMessage.substring(1).trim() : textMessage;
            let finalMessageToProcess = quotedText ? `النص المقتبس: "${quotedText}"\nالرسالة: ${coreMessage}` : coreMessage;

            if (!messageQueue.has(queueKey)) messageQueue.set(queueKey, { texts: [], isOwner: isOwner, timeout: null });
            const queueData = messageQueue.get(queueKey);
            queueData.texts.push(finalMessageToProcess);
            
            const processQueue = async () => {
                try {
                    if (processingUsers.has(queueKey)) {
                        queueData.timeout = setTimeout(processQueue, 2000);
                        return;
                    }
                    
                    if (!isBotActive && !queueData.isOwner) {
                        messageQueue.delete(queueKey);
                        return;
                    }
                    
                    const fullContext = queueData.texts.join('\n'); 
                    
                    messageQueue.delete(queueKey);
                    
                    if (!queueData.isOwner && (isAiBlacklisted || !aiKey)) {
                        await sock.sendMessage(remoteJid, { text: backupReplyText });
                        return;
                    }

                    processingUsers.add(queueKey);

                    try {
                        const targetContext = queueData.isOwner ? `owner_context_${remoteJid}` : remoteJid;
                        const responseText = await askGemini(targetContext, fullContext, queueData.isOwner); 
                        
                        await sock.sendMessage(remoteJid, { text: responseText }, queueData.isOwner ? { quoted: msg } : undefined); 
                        
                    } catch (e) { 
                        if (e.message === 'TOO_LONG') {
                            await sock.sendMessage(remoteJid, { text: '⚠️ رسالتك طويلة جداً وتتجاوز الحد المسموح. يرجى اختصار النص والمحاولة مجدداً.' });
                        } else if (e.message === 'SAFETY_BLOCK') {
                            await sock.sendMessage(remoteJid, { text: '⚠️ عذراً، تم حظر هذا الطلب من قبل نظام الحماية لأنه يخالف سياسات المحتوى.' });
                        } else if (e.message === 'RATE_LIMIT') {
                            await sock.sendMessage(remoteJid, { text: '⏳ تجاوزت الحد الأقصى للطلبات السريعة للذكاء الاصطناعي. يرجى الانتظار لمدة دقيقة والمحاولة مجدداً.' });
                        } else {
                            let errorMsg = queueData.isOwner ? `⚠️ تفاصيل الخطأ: ${e.message}` : backupReplyText;
                            await sock.sendMessage(remoteJid, { text: errorMsg }); 
                        }
                    } finally {
                        processingUsers.delete(queueKey);
                    }
                } catch (generalError) {
                    console.error('Socket Execution Error:', generalError);
                }
            };

            // تم تغيير مدة الانتظار للناس إلى 15 ثانية (15000)
            let delayTime = queueData.isOwner ? 2000 : 15000;
            if (queueData.timeout) clearTimeout(queueData.timeout);
            queueData.timeout = setTimeout(processQueue, delayTime);
        }
    });
}

app.get('/', (req, res) => res.send('System is running securely with robust Redis architecture.'));
app.listen(PORT, () => console.log("Server Running"));
startBot();
