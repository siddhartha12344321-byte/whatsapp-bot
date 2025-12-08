import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { fileURLToPath } from 'url';
import { QuizEngine } from './quiz-engine.js';

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Module-level socket reference
let sock = null;

// ---------- Express App ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
    const status = sock && sock.user ? `✅ Connected as ${sock.user?.pushname || 'Unknown'}` : '⚠️ Not connected';
    res.send(`<h1>WhatsApp Bot Status</h1><p>${status}</p>`);
});
app.get('/health', (_, res) => res.send('OK'));
app.get('/quizsection', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'quizsection.html'));
});
app.listen(PORT, () => console.log(`🚀 Express server listening on ${PORT}`));

// ---------- Quiz Engine ----------
const quizEngine = new QuizEngine(process.env.GROQ_API_KEY);

// ---------- Baileys Socket ----------
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    // Persist credentials
    sock.ev.on('creds.update', saveCreds);

    // QR code handling
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('📱 Scan QR code to authenticate');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode ?? 0) !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Reconnect?', shouldReconnect);
            if (shouldReconnect) startSock();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected');
        }
    });

    // Helper to extract plain text from incoming messages
    const extractText = msg => {
        if (msg.message?.conversation) return msg.message.conversation;
        if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
        return '';
    };

    // Incoming messages
    sock.ev.on('messages.upsert', async (upsert) => {
        const messages = upsert.messages || [];
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const text = extractText(msg);
            if (!text) continue;
            console.log('📩 Received:', text);
            await sock.sendMessage(msg.key.remoteJid, { text: `You said: ${text}` });
        }
    });

    // Poll vote updates
    sock.ev.on('messages.update', async (updates) => {
        for (const upd of updates) {
            if (!upd.update?.pollUpdates) continue;
            try {
                const pollMsg = await getAggregateVotesInPollMessage({
                    message: upd.update,
                    key: upd.key
                });
                if (pollMsg) {
                    await quizEngine.handleVote(pollMsg);
                }
            } catch (e) {
                console.error('⚠️ Error handling poll vote:', e);
            }
        }
    });
}

// Start the socket
startSock();
