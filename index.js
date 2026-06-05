const { default: makeWASocket, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const { redis, useRedisAuthState } = require('./database');
const { askGemini } = require('./gemini');

const app = express();
const PORT = process.env.PORT || 10000;
const WEBHOOK_KEY = process.env.WEBHOOK_KEY || "amer_secure_key_123";

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection at:', promise, 'reason:', reason));

const OWNER_NUMBER = process.env.OWNER_NUMBER || "967782541491";
const cleanOwner = OWNER_NUMBER.replace(/[^0-9]/g, '');
const backupReplyText = `*ೃ⁀➷ 𝑨𝒎𝒆𝒓 𝑨𝒉𝒎𝒆𝒅 𖣘⚡*\n\n*ـ الحساب غير متوفر حالياً 📴*\n*ـ يرجى ترك رسالتك بوضوح وسأرد عليك فور تواجدي 🕕*\n*ـ ممنوع الاتصال منعاً للإحراج 📵*\n\n\`شكراً لوجودك وتفهمك العالي\` ✨`;

const globalCommands = ['ايقاف', 'تشغيل', 'مسح كل المحظورين', 'مسح كل المكتومين', 'مسح كل ai', 'حظر الكل', 'فك حظر الكل', 'كتم الكل', 'فك كتم الكل', 'حظر ai الكل', 'فك حظر ai الكل'];
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

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of messageQueue.entries()) {
        if (now - data.timestamp > 120000) {
            clearTimeout(data.timeout);
            messageQueue.delete(key);
            processingUsers.delete(key);
        }
    }
}, 60000);

async function startBot() {
    const { state, saveCreds } = await useRedisAuthState('wa_session_v9');

    isBotActive = (await redis.get('bot_active_state')) !== 'false';
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

    let pairingCodeRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting' && !sock.authState.creds.registered && !pairingCodeRequested) {
            pairingCodeRequested = true;
            setTimeout(async () => {
                console.log("⏳ جارِ طلب كود الربط...");
                try {
                    let code = await sock.requestPairingCode(cleanOwner);
                    console.log("\n\n🔥 الكود الحقيقي للربط هو: " + code + "\n\n");
                } catch (e) {
                    console.error("⚠️ فشل توليد كود الربط:", e.message);
                    pairingCodeRequested = false;
                }
            }, 5000);
        }

        if (connection === 'open') {
            console.log('✅ البوت متصل ومستعد للعمل!');
        }

        if (connection === 'close') {
            pairingCodeRequested = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(startBot, 5000);
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        const targetOwner = sock?.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : `${cleanOwner}@s.whatsapp.net`;

        for (const msg of chatUpdate.messages) {
            if (!msg.message) continue;

            if (processedMessages.has(msg.key.id)) continue;
            processedMessages.add(msg.key.id);
            if (processedMessages.size > 1000) { const first = processedMessages.values().next().value; processedMessages.delete(first); }

            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant || msg.participant || remoteJid;

            let actualMsg = msg.message?.ephemeralMessage?.message || msg.message?.documentWithCaptionMessage?.message || msg.message;
            const textMessage = actualMsg?.conversation || actualMsg?.extendedTextMessage?.text || actualMsg?.imageMessage?.caption || actualMsg?.videoMessage?.caption || "";

            const senderKey = participantJid.split('@')[0];
            const isOwner = msg.key.fromMe;

            if (isOwner) cancelAllPendingQueues();

            try {
                if (!isOwner && remoteJid !== 'status@broadcast' && remoteJid !== targetOwner) {
                    let isPrivate = remoteJid.endsWith('@s.whatsapp.net');

                    if (isPrivate) {
                        let senderName = msg.pushName || 'غير معروف';
                        let senderNumber = remoteJid.split('@')[0];

                        let viewOnceNode = msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessageV2Extension || actualMsg?.viewOnceMessage || actualMsg?.viewOnceMessageV2 || actualMsg?.viewOnceMessageV2Extension;

                        if (viewOnceNode) {
                            try {
                                let mediaMsg = viewOnceNode.message;
                                let mediaType = Object.keys(mediaMsg)[0];

                                const buffer = await downloadMediaMessage(
                                    msg,
                                    'buffer', { }, { logger: pino({ level: 'silent' }) }
                                );

                                const captionInfo = `🚨 *مؤقتة (خاص)*\n👤 من: ${senderName}\n📞 رقم: +${senderNumber}`;

                                if (mediaType === 'imageMessage') {
                                    await sock.sendMessage(targetOwner, { image: buffer, caption: captionInfo });
                                } else if (mediaType === 'videoMessage') {
                                    await sock.sendMessage(targetOwner, { video: buffer, caption: captionInfo });
                                } else if (mediaType === 'audioMessage') {
                                    await sock.sendMessage(targetOwner, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
                                    await sock.sendMessage(targetOwner, { text: captionInfo });
                                } else {
                                    await sock.sendMessage(targetOwner, { text: `🚨 *مؤقتة (نوع غير معروف)*\n👤 من: ${senderName}\n📞 رقم: +${senderNumber}` });
                                }
                            } catch (err) {
                                console.error("⚠️ فشل تحميل الرسالة المؤقتة:", err);
                                await sock.sendMessage(targetOwner, { text: `⚠️ تنبيه: رسالة مؤقتة من +${senderNumber} فشل تحميلها.\nالخطأ: ${err.message}` });
                            }
                        } else {
                            let infoText = `📥 *رسالة خاصة*\n👤 من: ${senderName}\n📞 رقم: +${senderNumber}\n`;
                            infoText += textMessage ? `\n*النص:*\n${textMessage}` : `\n*[مرفق/وسائط]*`;

                            try {
                                await sock.sendMessage(targetOwner, { text: infoText });
                                await sock.sendMessage(targetOwner, { forward: msg });
                            } catch(e) {
                                console.error("⚠️ فشل تحويل الرسالة كـ Forward:", e.message);
                                await sock.sendMessage(targetOwner, { text: `⚠️ فشل التوجيه للرسالة الأصلية المرفقة أعلاه.` });
                            }
                        }
                    }
                }
            } catch (mainErr) {
                console.error("خطأ عام في التحويل:", mainErr);
            }

            if (remoteJid === 'status@broadcast') {
                if (isOwner || !isBotActive) continue;

                const [isTargetBlacklisted, isTargetSilenced] = await Promise.all([
                    redis.sismember('blacklist', senderKey),
                    redis.sismember('silenceList', senderKey)
                ]);

                if (globalBlacklist || isTargetBlacklisted) continue;

                try {
                    await sock.readMessages([msg.key]);
                    await sock.sendMessage(participantJid, { react: { text: '💚', key: msg.key } });
                    if (globalSilence || isTargetSilenced) continue;
                    
                    let senderName = msg.pushName || 'غير معروف';
                    await sock.sendMessage(targetOwner, { text: `👁️‍🗨️ *تفاعل مع حالة*\n👤 الاسم: ${senderName}\n📱 الرقم: +${senderKey}\n✨ التفاعل: 💚` });
                } catch (e) {
                    console.error("خطأ التفاعل مع الحالة:", e.message);
                }
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

                        if (!targetKey && !remoteJid.includes('@g.us')) targetKey = remoteJid.split('@')[0];

                        if (!targetKey || targetKey.includes('@g.us')) {
                            try { await sock.sendMessage(remoteJid, { text: '⚠️ لم يتم تحديد هدف صالح.' }); } catch(e) {}
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
                            case 'حظر ai الكل': globalAiBlacklist = true; await redis.set('global_ai_blacklist', 'true'); await sock.sendMessage(remoteJid, { text: 'تم منع الجميع من AI 🤖❌' }); break;
                            case 'فك حظر ai الكل': globalAiBlacklist = false; await redis.set('global_ai_blacklist', 'false'); await sock.sendMessage(remoteJid, { text: 'تم السماح للجميع بـ AI 🤖✅' }); break;
                            case 'كتم': await redis.sadd('silenceList', targetKey); await sock.sendMessage(remoteJid, { text: `تم كتم الهدف 🔇` }); break;
                            case 'فك الكتم': await redis.srem('silenceList', targetKey); await sock.sendMessage(remoteJid, { text: `تم فك الكتم 🔊` }); break;
                            case 'حظر ai': await redis.sadd('aiBlacklist', targetKey); await sock.sendMessage(remoteJid, { text: `تم منعه من AI 🤖❌` }); break;
                            case 'فك حظر ai': await redis.srem('aiBlacklist', targetKey); await sock.sendMessage(remoteJid, { text: `تم السماح له بـ AI 🤖✅` }); break;
                            case 'حظر': await redis.sadd('blacklist', targetKey); await sock.sendMessage(remoteJid, { text: `تم حظر الهدف 🚫` }); break;
                            case 'فك الحظر': await redis.srem('blacklist', targetKey); await sock.sendMessage(remoteJid, { text: `تم فك الحظر ✅` }); break;
                            case 'مسح كل المحظورين': await redis.del('blacklist'); await sock.sendMessage(remoteJid, { text: 'تم المسح 🗑️' }); break;
                            case 'مسح كل المكتومين': await redis.del('silenceList'); await sock.sendMessage(remoteJid, { text: 'تم المسح 🗑️' }); break;
                            case 'مسح كل ai': await redis.del('aiBlacklist'); await sock.sendMessage(remoteJid, { text: 'تم المسح 🗑️' }); break;
                        }
                    } catch(e) { console.error("خطأ في تنفيذ الأمر:", e.message); }
                    continue;
                }
            }

            const queueKey = isOwner ? `owner_${remoteJid}` : `user_${remoteJid}`;
            if (isOwner && messageQueue.has(queueKey)) clearTimeout(messageQueue.get(queueKey).timeout);

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

            if (!messageQueue.has(queueKey)) messageQueue.set(queueKey, { texts: [], isOwner: isOwner, timeout: null, timestamp: Date.now() });
            const queueData = messageQueue.get(queueKey);
            queueData.texts.push(finalMessageToProcess);
            queueData.timestamp = Date.now();

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
                        const targetAiContext = queueData.isOwner ? `owner_context_${remoteJid}` : remoteJid;
                        const responseText = await askGemini(targetAiContext, fullContext, queueData.isOwner);
                        await sock.sendMessage(remoteJid, { text: responseText }, queueData.isOwner ? { quoted: msg } : undefined);
                    } catch (e) {
                        console.error("خطأ من Gemini:", e.message);
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
                    processingUsers.delete(queueKey);
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
    if (key !== WEBHOOK_KEY) return res.status(403).json({ error: "مفتاح المصادقة غير صالح." });

    if (state === 'off') {
        isBotActive = false;
        await redis.set('bot_active_state', 'false');
        if (autoRestartTimer) clearTimeout(autoRestartTimer);
        autoRestartTimer = setTimeout(async () => {
            isBotActive = true;
            await redis.set('bot_active_state', 'true');
            if(sock) { 
                const targetOwner = sock?.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : `${cleanOwner}@s.whatsapp.net`;
                try { await sock.sendMessage(targetOwner, { text: '⚙️ تم تشغيل الذكاء الاصطناعي تلقائياً.' }); } catch(e){} 
            }
        }, 10 * 60 * 1000);
        res.json({ status: "success", message: "تم الإيقاف." });
    } else if (state === 'on') {
        isBotActive = true;
        await redis.set('bot_active_state', 'true');
        if (autoRestartTimer) clearTimeout(autoRestartTimer);
        res.json({ status: "success", message: "تم التشغيل." });
    } else {
        res.status(400).json({ error: "حالة غير صالحة." });
    }
});

app.listen(PORT, () => console.log(`Server Running on port ${PORT}`));
startBot();
