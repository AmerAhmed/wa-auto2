const Redis = require('ioredis');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

const redis = new Redis(process.env.REDIS_URL);
redis.on('error', (err) => console.error('⚠️ خطأ في اتصال Redis:', err));

async function useRedisAuthState(sessionId) {
    const writeData = async (data, key) => await redis.set(`${sessionId}:${key}`, JSON.stringify(data, BufferJSON.replacer));
    const readData = async (key) => {
        const data = await redis.get(`${sessionId}:${key}`);
        return data ? JSON.parse(data, BufferJSON.reviver) : null;
    };
    const removeData = async (key) => await redis.del(`${sessionId}:${key}`);
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
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
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

module.exports = { redis, useRedisAuthState };
