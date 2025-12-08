import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import { QuizEngine } from './quiz-engine.js';

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Module-level state
let sock = null;
let currentQR = null;
let isConnected = false;

// ---------- Express App ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
    const status = isConnected ? `✅ Connected as ${sock?.user?.pushname || 'Unknown'}` : '⚠️ Not connected';
    res.send(`<h1>WhatsApp Bot Status</h1><p>${status}</p><p><a href="/qr">View QR Code</a> | <a href="/quizsection">Quiz Section</a></p>`);
});

app.get('/health', (_, res) => res.send('OK'));

app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <html>
            <head><title>WhatsApp Bot - Connected</title></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>✅ Already Connected!</h1>
                <p>The bot is already authenticated and connected to WhatsApp.</p>
                <p>Connected as: <strong>${sock?.user?.pushname || 'Unknown'}</strong></p>
                <a href="/">Back to Home</a>
            </body>
            </html>
        `);
    }

    if (!currentQR) {
        return res.send(`
            <html>
            <head><title>WhatsApp Bot - QR Code</title><meta http-equiv="refresh" content="3"></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>⏳ Waiting for QR Code...</h1>
                <p>QR code is being generated. This page will auto-refresh.</p>
                <p>If this takes too long, check the server logs.</p>
            </body>
            </html>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <html>
            <head><title>WhatsApp Bot - Scan QR</title><meta http-equiv="refresh" content="10"></head>
            <body style="font-family: Arial; text-align: center; padding: 20px;">
                <h1>📱 Scan QR Code</h1>
                <p>Open WhatsApp on your phone → Settings → Linked Devices → Link a Device</p>
                <img src="${qrImage}" style="max-width: 400px; margin: 20px auto; display: block;" />
                <p style="color: gray;">Page auto-refreshes every 10 seconds</p>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send(`Error generating QR: ${err.message}`);
    }
});

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

    // Connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            qrcode.generate(qr, { small: true });
            console.log('📱 QR code generated - visit /qr to scan');
        }

        if (connection === 'close') {
            isConnected = false;
            currentQR = null;
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode ?? 0) !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Reconnect?', shouldReconnect);
            if (shouldReconnect) startSock();
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('✅ WhatsApp connected');
        }
    });

    // Helper to extract plain text
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
