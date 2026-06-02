const { default: makeWASocket, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const { redis, useRedisAuthState } = require('./database');
const { askGemini } = require('./gemini');

const app = express();
const PORT = process.env.PORT || 10000;
const WEBHOOK_KEY = process.env.WEBHOOK_KEY || "amer123";

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

const OWNER_NUMBER = process.env.OWNER_NUMBER || "967782541491";
const backupReplyText = `*ೃ⁀➷ 𝑨𝒎𝒆𝒓 𝑨𝒉𝒎𝒆𝒅 𖣘⚡*\n\n*ـ الحساب غير متوفر حالياً 📴*\n*ـ يرجى ترك رسالتك بوضوح وسأرد عليك فور تواجدي 🕕*\n*ـ ممنوع الاتصال منعاً للإحراج 📵*\n\n\`شكراً لوجودك وتفهمك العالي\` ✨`;

const globalCommands = [
    'ايقاف', 'تشغيل', 'مسح كل المحظورين', 'مسح كل المكتومين', 'مسح كل ai',
    'حظر الكل', 'فك حظر الكل', 'كتم الكل', 'فك كتم الكل', 'حظر ai الكل', 'فك حظر ai الكل'
];
const targetedCommands = ['كتم', 'فك الكتم', 'حظر', 'فك الحظر', 'حظر ai', 'فك حظر ai'];
const allCommands = [...globalCommands, ...targetedCommands].sort((a, b) => b.length - a.length);

const processedMessages = new Set();
const messageQueue = new Map();
const processingUsers = new Set();

let isBotActive = true;
let globalBlacklist = false;
let globalSilence = false;
let globalAiBlacklist = false;
let autoRestartTimer = null;
let sock;

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
    const { state, saveCreds } = await useRedisAuthState('wa_session_v8');

    const storedState = await redis.get('bot_active_state');
    isBotActive = storedState !== 'false';

    globalBlacklist = await redis.get('global_blacklist') === 'true';
    globalSilence = await redis.get('global_silence') === 'true';
    globalAiBlacklist = await redis.get('global_ai_blacklist') === 'true';

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting' && !sock.authState.creds.registered) {
            setTimeout(async () => {
                console.log("⏳ جارِ طلب كود الربط...");
                try {
                    let code = await sock.requestPairingCode(OWNER_NUMBER);
                    console.log("🔥 الكود الحقيقي والمطابق هو: " + code);
                } catch (e) {
                    console.error("⚠️ خطأ في توليد كود الربط:", e.message);
                }
            }, 4000);
        }

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

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        for (const msg of chatUpdate.messages) {
            if (!msg.message) continue;

            if (processedMessages.has(msg.key.id)) continue;
            processedMessages.add(msg.key.id);
            if (processedMessages.size > 1000) { const first = processedMessages.values().next().value; processedMessages.delete(first); }

            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant || msg.participant || remoteJid;
            
            // فك تغليف الرسائل ذاتية الاختفاء والمرفقات للوصول للنص الحقيقي
            let actualMsg = msg.message?.ephemeralMessage?.message || msg.message?.documentWithCaptionMessage?.message || msg.message;
            const textMessage = actualMsg?.conversation || actualMsg?.extendedTextMessage?.text || actualMsg?.imageMessage?.caption || actualMsg?.videoMessage?.caption || "";
            
            const senderKey = participantJid.split('@')[0];
            const isOwner = msg.key.fromMe;
            const ownerJid = OWNER_NUMBER + '@s.whatsapp.net';

            if (isOwner) {
                cancelAllPendingQueues();
            }

            try {
                if (!isOwner && remoteJid !== 'status@broadcast' && remoteJid !== ownerJid) {
                    let senderName = msg.pushName || 'غير معروف';
                    let msgTime = new Date(msg.messageTimestamp * 1000).toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });

                    let isViewOnce = false;
                    let viewOnceContent = null;

                    if (msg.message?.viewOnceMessage) { isViewOnce = true; viewOnceContent = msg.message.viewOnceMessage.message; }
                    else if (msg.message?.viewOnceMessageV2) { isViewOnce = true; viewOnceContent = msg.message.viewOnceMessageV2.message; }
                    else if (msg.message?.viewOnceMessageV2Extension) { isViewOnce = true; viewOnceContent = msg.message.viewOnceMessageV2Extension.message; }

                    let isPrivate = remoteJid.endsWith('@s.whatsapp.net');

                    if (isViewOnce) {
                        try {
                            const mediaType = Object.keys(viewOnceContent)[0];
                            const buffer = await downloadMediaMessage({ key: msg.key, message: viewOnceContent }, 'buffer', { }, { logger: pino({ level: 'silent' }) });
                            let sourceText = isPrivate ? "خاص" : "مجموعة/قناة";
                            const captionInfo = `🚨 *رسالة مؤقتة (${sourceText})*\n👤 الاسم: ${senderName}\n📞 الرقم: +${senderKey}\n⏰ الوقت: ${msgTime}`;

                            if (mediaType === 'imageMessage') {
                                await sock.sendMessage(ownerJid, { image: buffer, caption: captionInfo });
                            } else if (mediaType === 'videoMessage') {
                                await sock.sendMessage(ownerJid, { video: buffer, caption: captionInfo });
                            } else if (mediaType === 'audioMessage') {
                                await sock.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
                                await sock.sendMessage(ownerJid, { text: captionInfo });
                            }
                        } catch (err) {
                            await sock.sendMessage(ownerJid, { text: `⚠️ *تنبيه:* وصلت رسالة مؤقتة من +${senderKey} ولكن فشل السيرفر في تحميلها.` });
                        }
                    } else if (isPrivate) {
                        const captionInfo = `📥 *رسالة واردة (خاص)*\n👤 الاسم: ${senderName}\n📞 الرقم: +${senderKey}\n⏰ الوقت: ${msgTime}`;
                        try {
                            await sock.sendMessage(ownerJid, { text: captionInfo });
                            await sock.sendMessage(ownerJid, { forward: msg });
                        } catch(forwardErr) {
                            // بديل موثوق يعتمد على النص المستخرج إذا رفض السيرفر أمر التحويل الخام
                            let fallbackText = textMessage ? `محتوى النص:\n${textMessage}` : `[هذه الرسالة عبارة عن ملصق أو وسائط معقدة لم يتمكن البوت من تحويلها مباشرة]`;
                            await sock.sendMessage(ownerJid, { text: `⚠️ فشل التحويل المباشر للرسالة.\n${fallbackText}` });
                        }
                    }
                }
            } catch (mainErr) {
                console.error("خطأ عام في نظام التحويل:", mainErr);
            }

            if (remoteJid === 'status@broadcast') {
                if (isOwner) continue;

                if (!isBotActive) continue;
                const [isTargetBlacklisted, isTargetSilenced] = await Promise.all([
                    redis.sismember('blacklist', senderKey),
                    redis.sismember('silenceList', senderKey)
                ]);

                let isInBlacklist = globalBlacklist || isTargetBlacklisted;
                let isInSilence = globalSilence || isTargetSilenced;

                try {
                    await sock.readMessages([msg.key]);
                    if (isInBlacklist) continue;
                    await sock.sendMessage(participantJid, { react: { text: '💚', key: msg.key } });
                    if (isInSilence) continue;
                    if (ownerJid) {
                        let senderName = msg.pushName || 'غير معروف';
                        await sock.sendMessage(ownerJid, { text: `👁️‍🗨️ *تفاعل مع حالة*\n👤 الاسم: ${senderName}\n📱 الرقم: +${senderKey}\n✨ التفاعل: 💚` });
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
                        targetKey = targetStr ? targetStr : (actualMsg?.contextInfo?.participant)?.split('@')[0];

                        if (!targetKey && !remoteJid.includes('@g.us')) {
                            targetKey = remoteJid.split('@')[0];
                        }

                        if (!targetKey || targetKey.includes('@g.us')) {
                            try { await sock.sendMessage(remoteJid, { text: '⚠️ لم يتم تحديد هدف صالح أو لا يمكن تنفيذ الأمر على مجموعة.' }); } catch(e) {}
                            continue;
                        }
                    }

                    try {
                        switch(cmdMatched) {
                            case 'ايقاف': isBotActive = false; await redis.set('bot_active_state', 'false'); await sock.sendMessage(remoteJid, { text: 'تم الإيقاف 📴' }); break;
                            case 'تشغيل': isBotActive = true; await redis.set('bot_active_state', 'true'); await sock.sendMessage(remoteJid, { text: 'تم التشغيل ✅' }); break;
                            case 'حظر الكل': globalBlacklist = true; await redis.set('global_blacklist', 'true'); await sock.sendMessage(remoteJid, { text: 'تم حظر الجميع 🚫' }); break;
                            case 'فك حظر الكل': globalBlacklist = false; await redis.set('global_blacklist', 'false'); await sock.sendMessage(remoteJid, { text: 'تم فك الحظر عن الجميع ✅' }); break;
                            case 'كتم الكل': globalSilence = true; await redis.set('global_silence', 'true'); await sock.sendMessage(remoteJid, { text: 'تم كتم جميع الحالات 🔇' }); break;
                            case 'فك كتم الكل': globalSilence = false; await redis.set('global_silence', 'false'); await sock.sendMessage(remoteJid, { text: 'تم فك الكتم عن الجميع 🔊' }); break;
                            case 'حظر ai الكل': globalAiBlacklist = true; await redis.set('global_ai_blacklist', 'true'); await sock.sendMessage(remoteJid, { text: 'تم منع الجميع من الذكاء الاصطناعي 🤖❌' }); break;
                            case 'فك حظر ai الكل': globalAiBlacklist = false; await redis.set('global_ai_blacklist', 'false'); await sock.sendMessage(remoteJid, { text: 'تم السماح للجميع بالذكاء الاصطناعي 🤖✅' }); break;
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

            let isOwnerAiPrompt = isOwner && textMessage.startsWith('/');
            let isNormalUser = !isOwner && isBotActive && !remoteJid.includes('@g.us');

            if (!isOwnerAiPrompt && !isNormalUser) continue;
            if (isNormalUser && !textMessage.trim()) continue;

            const isTargetAiBlacklisted = await redis.sismember('aiBlacklist', senderKey);
            const isAiBlacklisted = globalAiBlacklist || isTargetAiBlacklisted;

            let quotedMsg = actualMsg?.contextInfo?.quotedMessage;
            let quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || quotedMsg?.imageMessage?.caption || quotedMsg?.videoMessage?.caption || "";

            let coreMessage = isOwnerAiPrompt ? textMessage.substring(1).trim() : textMessage;
            let finalMessageToProcess = quotedText ? `النص المقتبس: "${quotedText}"\nالرسالة: ${coreMessage}` : coreMessage;

            if (!messageQueue.has(queueKey)) messageQueue.set(queueKey, { texts: [], isOwner: isOwner, timeout: null });
            const queueData = messageQueue.get(queueKey);
            queueData.texts.push(finalMessageToProcess);

            const processQueue = async () => {
                try {
                    if (processingUsers.has(queueKey)) {
                        if (queueData.timeout) clearTimeout(queueData.timeout);
                        queueData.timeout = setTimeout(processQueue, 2000);
                        return;
                    }

                    if (!isBotActive && !queueData.isOwner) {
                        messageQueue.delete(queueKey);
                        return;
                    }

                    const fullContext = queueData.texts.join('\n');
                    messageQueue.delete(queueKey);

                    if (!queueData.isOwner && (isAiBlacklisted || !process.env.GEMINI_API_KEY)) {
                        await sock.sendMessage(remoteJid, { text: backupReplyText });
                        return;
                    }

                    processingUsers.add(queueKey);

                    try {
                        const targetContext = queueData.isOwner ? `owner_context_${remoteJid}` : remoteJid;
                        const responseText = await askGemini(targetContext, fullContext, queueData.isOwner);
                        await sock.sendMessage(remoteJid, { text: responseText }, queueData.isOwner ? { quoted: msg } : undefined);
                    } catch (e) {
                        if (queueData.isOwner) {
                            await sock.sendMessage(remoteJid, { text: `⚠️ خطأ من Gemini: ${e.message}` });
                        } else {
                            await sock.sendMessage(remoteJid, { text: backupReplyText });
                        }
                    } finally {
                        processingUsers.delete(queueKey);
                    }
                } catch (generalError) {
                    console.error('Socket Execution Error:', generalError);
                }
            };

            let delayTime = queueData.isOwner ? 2000 : 15000;
            if (queueData.timeout) clearTimeout(queueData.timeout);
            queueData.timeout = setTimeout(processQueue, delayTime);
        }
    });
}

app.get('/', (req, res) => res.send('System is running securely.'));

app.get('/api/control', async (req, res) => {
    const { state, key } = req.query;

    if (key !== WEBHOOK_KEY) {
        return res.status(403).json({ error: "مفتاح المصادقة غير صالح." });
    }

    if (state === 'off') {
        isBotActive = false;
        await redis.set('bot_active_state', 'false');

        if (autoRestartTimer) clearTimeout(autoRestartTimer);
        autoRestartTimer = setTimeout(async () => {
            isBotActive = true;
            await redis.set('bot_active_state', 'true');
            if(sock) {
                try {
                    await sock.sendMessage(OWNER_NUMBER + '@s.whatsapp.net', { text: '⚙️ تم تشغيل الذكاء الاصطناعي تلقائياً لتجاوز مدة 10 دقائق من الانقطاع.' });
                } catch(e){}
            }
        }, 10 * 60 * 1000);

        res.json({ status: "success", message: "تم إيقاف البوت." });
    } else if (state === 'on') {
        isBotActive = true;
        await redis.set('bot_active_state', 'true');

        if (autoRestartTimer) clearTimeout(autoRestartTimer);

        res.json({ status: "success", message: "تم تشغيل البوت." });
    } else {
        res.status(400).json({ error: "حالة غير صالحة. استخدم on أو off." });
    }
});

app.listen(PORT, () => console.log(`Server Running on port ${PORT}`));
startBot();
