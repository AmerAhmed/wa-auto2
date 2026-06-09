const { default: makeWASocket, initAuthCreds, BufferJSON, proto, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 10000;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL || !PHONE_NUMBER) {
    console.error("⚠️ يرجى التأكد من إضافة REDIS_URL و PHONE_NUMBER في متغيرات البيئة.");
    process.exit(1);
}

const redis = new Redis(REDIS_URL);
redis.on('error', (err) => console.error('⚠️ خطأ في اتصال Redis:', err));

let statusQueue = [];
let isProcessingStatus = false;
let reactionDelay = 60000; 

async function useRedisAuthState(sessionId) {
    const writeData = async (data, key) => await redis.set(`${sessionId}:${key}`, JSON.stringify(data, BufferJSON.replacer));
    const readData = async (key) => {
        const data = await redis.get(`${sessionId}:${key}`);
        return data ? JSON.parse(data, BufferJSON.reviver) : null;
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const pipeline = redis.pipeline();
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${sessionId}:${category}-${id}`;
                            value ? pipeline.set(key, JSON.stringify(value, BufferJSON.replacer)) : pipeline.del(key);
                        }
                    }
                    await pipeline.exec();
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function processStatusQueue(sock) {
    if (isProcessingStatus || statusQueue.length === 0) return;
    isProcessingStatus = true;

    const msg = statusQueue.shift();
    const participantJid = msg.key.participant || msg.participant;
    const senderNumber = participantJid.split('@')[0];

    const minDelay = 30000; 
    const maxDelay = reactionDelay > minDelay ? reactionDelay : 60000;
    const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    console.log(`⏳ جاري الانتظار (${randomDelay / 1000} ثانية عشوائياً) قبل التفاعل مع حالة: ${senderNumber}`);
    await new Promise(resolve => setTimeout(resolve, randomDelay));

    try {
        await sock.readMessages([msg.key]);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await sock.sendMessage(participantJid, { react: { text: '💚', key: msg.key } });
        console.log(`✅ تم التفاعل بنجاح مع حالة: ${senderNumber}`);
    } catch (error) {
        console.error(`❌ فشل التفاعل مع ${senderNumber} | السبب:`, error?.message || error);
    }

    isProcessingStatus = false;
    processStatusQueue(sock);
}

app.get('/', (req, res) => res.send('Status Bot is Active, Secure, and Connected to Redis ✅'));
app.listen(PORT, () => console.log(`🚀 السيرفر يعمل الآن على المنفذ ${PORT}`));

async function startBot() {
    const savedDelay = await redis.get('reaction_delay');
    if (savedDelay) reactionDelay = parseInt(savedDelay);

    const { state, saveCreds } = await useRedisAuthState('status_bot_session_v4');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                console.log("⏳ جارِ استقرار الاتصال لطلب الكود...");
                let cleanNumber = PHONE_NUMBER.replace(/[^0-9]/g, '');
                let code = await sock.requestPairingCode(cleanNumber);
                console.log(`\n\n🔥 كود الربط الخاص بك: ${code}\n\n`);
            } catch (e) {
                console.error("⚠️ فشل توليد كود الربط:", e.message);
            }
        }, 4000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('✅ الاتصال مستقر: البوت متصل بمزود واتساب!');
            console.log(`⚙️ الحد الأقصى للتأخير الحالي: ${reactionDelay / 1000} ثانية.`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.error(`⚠️ انقطاع في الاتصال! | كود الخطأ: ${statusCode} | السبب: ${lastDisconnect?.error?.message || 'غير معروف'}`);
            
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ الجلسة خربت أو تم طرد الرقم. جاري مسح الجلسة التالفة بنظام SCAN...');
                
                try {
                    let cursor = '0';
                    do {
                        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'status_bot_session_v4:*', 'COUNT', 100);
                        cursor = nextCursor;
                        if (keys.length > 0) {
                            await redis.del(...keys);
                        }
                    } while (cursor !== '0');
                    
                    console.log('✅ تم تنظيف Upstash. 🛑 البوت الآن في وضع السبات ولن يطلب كوداً جديداً.');
                    console.log('🔄 للحصول على كود جديد، اذهب إلى لوحة Render واضغط على Manual Deploy -> Clear build cache & deploy');
                } catch (scanError) {
                    console.error('⚠️ فشل مسح الجلسة أثناء عملية SCAN:', scanError);
                }

            } 
            else if (statusCode === 408 || statusCode === DisconnectReason.connectionClosed) {
                console.log('🛑 توقف البوت عن محاولة الاتصال لتجنب التكرار المزعج.');
                console.log('🔄 للحصول على كود جديد، اذهب إلى لوحة Render واضغط Restart Service.');
            } 
            else {
                console.log('🔄 انقطاع شبكة مؤقت، جاري محاولة إعادة الاتصال...');
                setTimeout(startBot, 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages?.[0];
        if (!msg || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isOwner = msg.key.fromMe;

        let actualMsg = msg.message?.ephemeralMessage?.message || msg.message;
        const textMessage = actualMsg?.conversation || actualMsg?.extendedTextMessage?.text || "";

        if (isOwner && textMessage.startsWith('.')) {
            if (textMessage.startsWith('.تاخير ')) {
                const secMatch = textMessage.match(/\d+/);
                if (secMatch) {
                    const secs = parseInt(secMatch[0]);
                    if (secs > 0) {
                        reactionDelay = secs * 1000;
                        await redis.set('reaction_delay', reactionDelay.toString());
                        try {
                            await sock.sendMessage(remoteJid, { text: `✅ تم تحديث أقصى مدة للانتظار التلقائي ليصبح ${secs} ثانية.` });
                            console.log(`⚙️ المالك قام بتغيير التأخير الأقصى إلى ${secs} ثانية.`);
                        } catch (e) {}
                    }
                }
                return;
            }
        }

        if (remoteJid === 'status@broadcast' && !isOwner) {
            const senderNumber = msg.key.participant?.split('@')[0] || 'غير معروف';
            console.log(`📥 حالة جديدة من: ${senderNumber} | تم إضافتها للطابور.`);
            statusQueue.push(msg);
            processStatusQueue(sock);
        }
    });
}

startBot();

