import { proto } from '@whiskeysockets/baileys';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';

export const useMongoDBAuthState = async (collection) => {
    const writeData = async (data, id) => {
        try {
            await collection.updateOne(
                { _id: id },
                { $set: { value: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) } },
                { upsert: true }
            );
        } catch (e) {
            console.error(`MongoDB write error for ${id}:`, e);
        }
    };

    const readData = async (id) => {
        try {
            const result = await collection.findOne({ _id: id });
            if (result && result.value) {
                return JSON.parse(JSON.stringify(result.value), BufferJSON.reviver);
            }
        } catch (e) {
            console.error(`MongoDB read error for ${id}:`, e);
        }
        return null;
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (e) {
            console.error(`MongoDB delete error for ${id}:`, e);
        }
    };

    let creds = await readData('creds');
    if (creds) {
        console.log("✅ [Auth] Loaded existing session credentials.");
    } else {
        console.log("ℹ️ [Auth] No existing session found. Creating new credentials...");
        creds = await initAuthCreds();
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
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
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        }
    };
};
