import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import qrcode from 'qrcode-terminal';
import { QuizEngine } from './quiz-engine.js';

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const app = express();

// Serve static files from public folder
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

// ---------- Baileys Socket ----------
async function startSock() {
    const { state, saveState } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    // Persist credentials
    sock.ev.on('creds.update', saveState);

    // QR code handling
    sock.ev.on('qr', qr => {
        qrcode.generate(qr, { small: true });
        console.log('📱 Scan QR code to authenticate');
    });

    // Connection updates (reconnect on disconnect)
    sock.ev.on('connection.update', update => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode ?? 0) !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Reconnect?', shouldReconnect);
            if (shouldReconnect) startSock();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected');
        }
    });

    // ---------- Message handling ----------
    const quizEngine = new QuizEngine(process.env.GROQ_API_KEY);

    // Helper to extract plain text from incoming messages
    const extractText = msg => {
        if (msg.message?.conversation) return msg.message.conversation;
        if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
        return '';
    };

    // Incoming messages (including polls)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.key.fromMe) continue; // ignore own messages
            const text = extractText(msg);
            if (!text) continue;
            // Simple echo / placeholder – you can integrate your existing handleMessage logic here
            console.log('📩 Received:', text);
            // Example reply using Baileys format
            await sock.sendMessage(msg.key.remoteJid, { text: `You said: ${text}` });
        }
    });

    // Poll vote updates – forward to quiz engine if needed
    sock.ev.on('messages.update', async ({ messages }) => {
        for (const upd of messages) {
            if (!upd.pollUpdateMessage) continue;
            const pollMsg = await getAggregateVotesInPollMessage(upd);
            if (pollMsg) {
                // Forward to your quiz engine (adjust method name as needed)
                try {
                    await quizEngine.handleVote(pollMsg);
                } catch (e) {
                    console.error('⚠️ Error handling poll vote:', e);
                }
            }
        }
    });
}

// Start the socket
startSock();
