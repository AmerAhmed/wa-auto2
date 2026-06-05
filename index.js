const { default: makeWASocket, initAuthCreds, BufferJSON, proto, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3000;
const PHONE_NUMBER = process.env.PHONE_NUMBER; 
const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL || !PHONE_NUMBER) {
    console.error("⚠️ يرجى التأكد من إضافة REDIS_URL و PHONE_NUMBER في متغيرات البيئة.");
    process.exit(1);
}

const redis = new Redis(REDIS_URL);
redis.on('error', (err) => console.error('⚠️ خطأ في اتصال Redis:', err));

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

app.get('/', (req, res) => res.send('Status Bot is Active and Connected to Redis 🟢'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

async function startBot() {
    const { state, saveCreds } = await useRedisAuthState('status_bot_session');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);

    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting' && !sock.authState.creds.registered && !pairingRequested) {
            pairingRequested = true;
            setTimeout(async () => {
                try {
                    let cleanNumber = PHONE_NUMBER.replace(/[^0-9]/g, '');
                    let code = await sock.requestPairingCode(cleanNumber);
                    console.log(`\n🔥 كود الربط الخاص بك: ${code}\n`);
                } catch (e) {
                    console.error("⚠️ فشل طلب الكود:", e.message);
                    pairingRequested = false;
                }
            }, 4000);
        }

        if (connection === 'open') {
            console.log('✅ البوت متصل ومستعد لمشاهدة الحالات!');
        }

        if (connection === 'close') {
            pairingRequested = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(startBot, 5000);
            } else {
                console.log('❌ تم تسجيل الخروج. يجب تفريغ قاعدة بيانات Redis للحصول على كود ربط جديد.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        
        if (!msg.message || msg.key.remoteJid !== 'status@broadcast' || msg.key.fromMe) return;

        const participantJid = msg.key.participant || msg.participant;

        try {
            await sock.readMessages([msg.key]);
            await sock.sendMessage(participantJid, { react: { text: '💚', key: msg.key } });
            console.log(`✅ تفاعل مع حالة: ${participantJid.split('@')[0]}`);
        } catch (error) {
            // تجاهل الأخطاء لمنع إغراق السجلات
        }
    });
}

startBot();
