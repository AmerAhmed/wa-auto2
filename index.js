const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const Redis = require('ioredis');
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // استخدمنا axios للاتصال المباشر
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 10000;

const redis = new Redis(process.env.REDIS_URL);

async function useRedisAuthState(redisClient, sessionId) {
    const writeData = async (data, key) => {
        await redisClient.set(`${sessionId}:${key}`, JSON.stringify(data, BufferJSON.replacer));
    };
    const readData = async (key) => {
        const data = await redisClient.get(`${sessionId}:${key}`);
        return data ? JSON.parse(data, BufferJSON.reviver) : null;
    };
    const removeData = async (key) => {
        await redisClient.del(`${sessionId}:${key}`);
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
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

// دالة الاتصال المباشر بـ Gemini
async function askGemini(prompt) {
    if (!aiKey) return '⚠️ الذكاء الاصطناعي غير مفعل.';
    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${aiKey}`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { 'Content-Type': 'application/json' } }
        );
        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        throw new Error(error.response?.data?.error?.message || error.message);
    }
}

const emojis = ['💚', '💙', '💜', '💛', '🧡', '🖤', '❤️‍🔥', '🔥', '✨', '⭐', '🌟', '💫', '⚡', '💥', '💯', '🚀', '👍', '🙌', '👏', '👌', '💪', '👑', '🥳', '🤩', '😎', '🧠', '🦁', '🦅', '🎯', '💎', '🎨', '🎬', '😇', '🙂', '😌', '😉'];
const heartEmojis = ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '🩷', '🩶', '🩵'];

let blacklist = new Set();
let silenceList = new Set();
let aiBlacklist = new Set();
let aiUsage = new Map(); 

const processedMessages = new Set();
const messageQueue = new Map(); 
let isBotActive = true; 

const systemCommandsList = ['ايقاف', 'تشغيل', 'كتم', 'فك الكتم', 'حظر', 'فك الحظر', 'حظر ai', 'فك حظر ai', 'قائمة المحظورين', 'قائمة المكتومين', 'قائمة ai', 'مسح كل المحظورين', 'مسح كل المكتومين', 'مسح كل ai'];

function loadList(fileName, targetSet) {
    const filePath = path.join(__dirname, fileName);
    if (fs.existsSync(filePath)) {
        try { const data = JSON.parse(fs.readFileSync(filePath, 'utf8')); data.forEach(item => targetSet.add(item)); } catch (e) {}
    }
}
function saveList(fileName, targetSet) {
    try { fs.writeFileSync(path.join(__dirname, fileName), JSON.stringify([...targetSet]), 'utf8'); } catch(e){}
}
function loadMap(fileName, targetMap) {
    const filePath = path.join(__dirname, fileName);
    if (fs.existsSync(filePath)) {
        try { const data = JSON.parse(fs.readFileSync(filePath, 'utf8')); for (const [k, v] of Object.entries(data)) targetMap.set(k, v); } catch (e) {}
    }
}
function saveMap(fileName, targetMap) {
    try { fs.writeFileSync(path.join(__dirname, fileName), JSON.stringify(Object.fromEntries(targetMap)), 'utf8'); } catch(e){}
}

loadList('blacklist.json', blacklist);
loadList('silence_list.json', silenceList);
loadList('ai_blacklist.json', aiBlacklist);
loadMap('ai_usage.json', aiUsage);

const backupReplyText = `*ೃ⁀➷ 𝑨𝒎𝒆𝒓 𝑨𝒉𝒎𝒆𝒅 𖣘⚡*\n\n*ـ الحساب غير متوفر حالياً 📴*\n*ـ يرجى ترك رسالتك بوضوح وسأرد عليك فور تواجدي 🕕*\n*ـ ممنوع الاتصال منعاً للإحراج 📵*\n\n\`شكراً لوجودك وتفهمك العالي\` ✨`;

function clearAllQueues() {
    for (const [remoteJid, queue] of messageQueue.entries()) {
        if (queue.timeout) clearTimeout(queue.timeout);
    }
    messageQueue.clear();
}

async function startBot() {
    const { state, saveCreds } = await useRedisAuthState(redis, 'wa_session_3');
    
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000
    });
    
    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode("967782541491");
                console.log("🔥 كود الربط الجديد هو: " + code);
            } catch (e) {}
        }, 5000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log('✅ البوت متصل ومستعد للعمل، الجلسة محفوظة بأمان في السحابة!');
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
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
            const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            
            if (msg.key.fromMe) {
                if (messageQueue.has(remoteJid)) {
                    clearTimeout(messageQueue.get(remoteJid).timeout);
                    messageQueue.delete(remoteJid);
                }
            }

            if (remoteJid === 'status@broadcast') {
                if (msg.key.fromMe || !isBotActive) continue;
                try { 
                    await sock.readMessages([msg.key]);
                    let senderJid = participantJid;
                    let senderNum = senderJid.split('@')[0];
                    let senderName = msg.pushName || 'غير معروف';

                    let isInBlacklist = [...blacklist].some(b => senderJid.includes(b.split('@')[0]));
                    let isInSilence = [...silenceList].some(s => senderJid.includes(s.split('@')[0]));

                    if (!isInBlacklist) {
                        let reactEmoji = isInSilence ? heartEmojis[Math.floor(Math.random() * heartEmojis.length)] : emojis[Math.floor(Math.random() * emojis.length)];
                        await sock.sendMessage(remoteJid, { react: { text: reactEmoji, key: msg.key } }, { statusJidList: [senderJid] });
                        
                        if (!isInSilence) {
                            await sock.sendMessage(ownerJid, { text: `👁️‍🗨️ *تفاعل مع حالة*\n👤 الاسم: ${senderName}\n📱 الرقم: +${senderNum}\n✨ التفاعل: ${reactEmoji}` });
                        } else {
                            await sock.sendMessage(ownerJid, { text: `👁️‍🗨️ *تفاعل مع حالة (مكتوم)*\n👤 الاسم: ${senderName}\n📱 الرقم: +${senderNum}\n✨ التفاعل: ${reactEmoji}` });
                        }
                    }
                } catch (e) {}
                continue;
            }

            if (msg.key.fromMe && textMessage.startsWith('.')) {
                let rawCmd = textMessage.substring(1).trim();
                let firstWord = rawCmd.split(' ')[0].replace(/_/g, ' ').toLowerCase();
                if (rawCmd.startsWith('فك الكتم')) firstWord = 'فك الكتم';
                if (rawCmd.startsWith('فك الحظر')) firstWord = 'فك الحظر';
                if (rawCmd.startsWith('حظر ai')) firstWord = 'حظر ai';
                if (rawCmd.startsWith('فك حظر ai')) firstWord = 'فك حظر ai';
                if (rawCmd.startsWith('قائمة المحظورين')) firstWord = 'قائمة المحظورين';
                if (rawCmd.startsWith('قائمة المكتومين')) firstWord = 'قائمة المكتومين';
                if (rawCmd.startsWith('قائمة ai')) firstWord = 'قائمة ai';
                if (rawCmd.startsWith('مسح كل المحظورين')) firstWord = 'مسح كل المحظورين';
                if (rawCmd.startsWith('مسح كل المكتومين')) firstWord = 'مسح كل المكتومين';
                if (rawCmd.startsWith('مسح كل ai')) firstWord = 'مسح كل ai';

                let isSystemCommand = systemCommandsList.includes(firstWord);
                if (isSystemCommand) {
                    let targetNumMatch = rawCmd.match(/\d+/);
                    let targetStr = targetNumMatch ? targetNumMatch[0] : null;
                    let targetJid = targetStr ? `${targetStr}@s.whatsapp.net` : (msg.message.extendedTextMessage?.contextInfo?.participant || remoteJid);
                    try {
                        switch(firstWord) {
                            case 'ايقاف': isBotActive = false; clearAllQueues(); await sock.sendMessage(remoteJid, { text: 'تم الإيقاف 📴' }); break;
                            case 'تشغيل': isBotActive = true; await sock.sendMessage(remoteJid, { text: 'تم التشغيل ✅' }); break;
                            case 'كتم': silenceList.add(targetJid); saveList('silence_list.json', silenceList); await sock.sendMessage(remoteJid, { text: `تم كتم الهدف 🔇` }); break;
                            case 'فك الكتم': silenceList.delete(targetJid); saveList('silence_list.json', silenceList); await sock.sendMessage(remoteJid, { text: `تم فك الكتم 🔊` }); break;
                            case 'حظر': blacklist.add(targetJid); saveList('blacklist.json', blacklist); await sock.sendMessage(remoteJid, { text: `تم حظر الهدف 🚫` }); break;
                            case 'فك الحظر': blacklist.delete(targetJid); saveList('blacklist.json', blacklist); await sock.sendMessage(remoteJid, { text: `تم فك الحظر ✅` }); break;
                            case 'حظر ai': aiBlacklist.add(targetJid); saveList('ai_blacklist.json', aiBlacklist); await sock.sendMessage(remoteJid, { text: `تم منعه من الذكاء الاصطناعي 🤖❌` }); break;
                            case 'فك حظر ai': aiBlacklist.delete(targetJid); saveList('ai_blacklist.json', aiBlacklist); await sock.sendMessage(remoteJid, { text: `تم السماح له بالذكاء الاصطناعي 🤖✅` }); break;
                            case 'قائمة المحظورين': await sock.sendMessage(remoteJid, { text: `قائمة المحظورين:\n${[...blacklist].join('\n') || 'فارغة'}` }); break;
                            case 'قائمة المكتومين': await sock.sendMessage(remoteJid, { text: `قائمة المكتومين:\n${[...silenceList].join('\n') || 'فارغة'}` }); break;
                            case 'قائمة ai': await sock.sendMessage(remoteJid, { text: `الممنوعين من AI:\n${[...aiBlacklist].join('\n') || 'فارغة'}` }); break;
                            case 'مسح كل المحظورين': blacklist.clear(); saveList('blacklist.json', blacklist); await sock.sendMessage(remoteJid, { text: 'تم مسح المحظورين 🗑️' }); break;
                            case 'مسح كل المكتومين': silenceList.clear(); saveList('silence_list.json', silenceList); await sock.sendMessage(remoteJid, { text: 'تم مسح المكتومين 🗑️' }); break;
                            case 'مسح كل ai': aiBlacklist.clear(); saveList('ai_blacklist.json', aiBlacklist); await sock.sendMessage(remoteJid, { text: 'تم مسح قائمة AI 🗑️' }); break;
                        }
                    } catch(e) {}
                } else {
                    if (!aiKey) await sock.sendMessage(remoteJid, { text: '⚠️ الذكاء الاصطناعي غير مفعل.' });
                    else try { const responseText = await askGemini(rawCmd); await sock.sendMessage(remoteJid, { text: responseText }, { quoted: msg }); } catch (e) { await sock.sendMessage(remoteJid, { text: '⚠️ تفاصيل الخطأ: ' + e.message }); }
                }
                continue;
            }

            if (msg.key.fromMe || !isBotActive || remoteJid.includes('@g.us') || silenceList.has(remoteJid) || !textMessage.trim()) continue;

            if (!messageQueue.has(remoteJid)) messageQueue.set(remoteJid, { texts: [], timeout: null });
            const queueData = messageQueue.get(remoteJid);
            queueData.texts.push(textMessage);
            if (queueData.timeout) clearTimeout(queueData.timeout);
            queueData.timeout = setTimeout(async () => {
                if (!isBotActive) return messageQueue.delete(remoteJid);
                const fullContext = queueData.texts.join('\n'); messageQueue.delete(remoteJid);
                let usageCount = aiUsage.get(remoteJid) || 0;
                if (usageCount >= 20 || aiBlacklist.has(remoteJid) || !aiKey) await sock.sendMessage(remoteJid, { text: backupReplyText });
                else try { const responseText = await askGemini(fullContext); await sock.sendMessage(remoteJid, { text: responseText }); aiUsage.set(remoteJid, usageCount + 1); saveMap('ai_usage.json', aiUsage); } catch (e) { await sock.sendMessage(remoteJid, { text: backupReplyText }); }
            }, 2000);
        }
    });
}
app.get('/', (req, res) => res.send('System is running with direct Gemini API connection.'));
app.listen(PORT, () => console.log("Server Running"));
startBot();
