import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import { QuizEngine } from './quiz-engine.js';
import sanitizeHtml from 'sanitize-html';

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Module-level state
let sock = null;
let currentQR = null;
let isConnected = false;

// In-memory chat history
const chatHistory = new Map();

// ---------- Express App ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
    const status = isConnected ? `✅ Connected as ${sock?.user?.pushname || 'Unknown'}` : '⚠️ Not connected';
    res.send(`<h1>WhatsApp Bot - UPSC Tutor</h1><p>${status}</p><p><a href="/qr">View QR Code</a> | <a href="/quizsection">Quiz Section</a></p>`);
});

app.get('/health', (_, res) => res.send('OK'));

app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <html><head><title>WhatsApp Bot - Connected</title></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>✅ Already Connected!</h1>
                <p>Connected as: <strong>${sock?.user?.pushname || 'Unknown'}</strong></p>
                <a href="/">Back to Home</a>
            </body></html>
        `);
    }
    if (!currentQR) {
        return res.send(`
            <html><head><title>QR Code</title><meta http-equiv="refresh" content="3"></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>⏳ Waiting for QR Code...</h1><p>Auto-refreshing...</p>
            </body></html>
        `);
    }
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <html><head><title>Scan QR</title><meta http-equiv="refresh" content="10"></head>
            <body style="font-family: Arial; text-align: center; padding: 20px;">
                <h1>📱 Scan QR Code</h1>
                <img src="${qrImage}" style="max-width: 400px;" />
            </body></html>
        `);
    } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
    }
});

app.get('/quizsection', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'quizsection.html'));
});

app.listen(PORT, () => console.log(`🚀 Express server listening on ${PORT}`));

// ---------- Quiz Engine ----------
const quizEngine = new QuizEngine(process.env.GROQ_API_KEY);
console.log("✅ Quiz engine initialized with UPSC tutor AI");

// ---------- Helper Functions ----------
function updateHistory(chatId, role, content) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ role: role === 'model' ? 'assistant' : role, content });
    if (history.length > 20) history.shift();
}

function normalizeMessagesForGroq(messages) {
    return messages.map(msg => ({
        role: msg.role === 'model' ? 'assistant' : msg.role,
        content: msg.content || ''
    })).filter(m => m.content && m.content.trim().length > 0);
}

// ---------- Message Handler ----------
async function handleMessage(msg, remoteJid) {
    try {
        const messageContent = msg.message;
        if (!messageContent) return;

        // Extract text from message
        let prompt = messageContent.conversation ||
            messageContent.extendedTextMessage?.text ||
            '';

        if (!prompt || prompt.trim().length === 0) return;

        prompt = sanitizeHtml(prompt.replace(/@\S+/g, "").trim());
        console.log(`📩 Received: ${prompt}`);

        // Check if it's a quiz command
        if (prompt.match(/\b(create|generate|make|start)\s+(?:a\s+)?(?:mock\s+)?(?:test|quiz|poll)/i)) {
            await sock.sendMessage(remoteJid, { text: "🧠 Generating quiz... Please use the /quizsection web panel for full quiz features." });
            return;
        }

        // Check for quiz cancel
        if (prompt.toLowerCase().includes("cancel quiz") || prompt.toLowerCase().includes("stop quiz")) {
            if (quizEngine.stopQuiz(remoteJid)) {
                await sock.sendMessage(remoteJid, { text: "✅ Quiz stopped." });
            } else {
                await sock.sendMessage(remoteJid, { text: "ℹ️ No active quiz." });
            }
            return;
        }

        // Detect if MCQ/poll explanation
        const isMCQ = prompt.match(/\?/) && (
            prompt.match(/^[A-D][).]\s*.+/) ||
            prompt.match(/option [A-D]/i) ||
            prompt.match(/choose|select|which.*correct|explain/i)
        );

        // Build system prompt based on question type
        const systemPrompt = isMCQ
            ? `You are an expert exam tutor for UPSC/SSC/government exams. For MCQs, provide structured explanation in MAX 100 words:

Format:
✅ Answer: [Option + 1 sentence]
💡 Explanation: [2-3 short sentences]
🔑 Key Point: [1 concept]

Be concise, clear, and exam-focused.`
            : `You are an expert UPSC/government exam tutor and helpful AI assistant. 
            
Guidelines:
- For exam questions: Be structured and educational
- For general questions: Be friendly and helpful  
- Keep responses concise but comprehensive
- Be engaging and encouraging
- Remember you are helping students prepare for competitive exams

Personality: Knowledgeable, supportive, patient exam mentor.`;

        // Build messages array
        const messagesArray = [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
            ...normalizeMessagesForGroq(chatHistory.get(remoteJid) || [])
        ];

        console.log("🤖 Generating AI response...");

        // Get AI response using quizEngine
        const chatSession = await quizEngine.chat(messagesArray);
        let responseText = chatSession.response.text();

        if (!responseText || responseText.trim().length === 0) {
            responseText = "I couldn't generate a response. Please try again!";
        }

        // Update history
        updateHistory(remoteJid, 'user', prompt);
        updateHistory(remoteJid, 'assistant', responseText);

        // Send response
        await sock.sendMessage(remoteJid, { text: responseText });
        console.log(`✅ Sent AI response`);

    } catch (err) {
        console.error("❌ Message handling error:", err.message);
        try {
            await sock.sendMessage(remoteJid, { text: "⚠️ Sorry, I encountered an error. Please try again!" });
        } catch (e) {
            console.error("Failed to send error message:", e.message);
        }
    }
}

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

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            qrcodeTerminal.generate(qr, { small: true });
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
            console.log('✅ WhatsApp connected - UPSC Tutor Bot is ready!');
        }
    });

    // Incoming messages
    sock.ev.on('messages.upsert', async (upsert) => {
        const messages = upsert.messages || [];
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            const remoteJid = msg.key.remoteJid;
            if (!remoteJid) continue;
            await handleMessage(msg, remoteJid);
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
                console.error('⚠️ Poll vote error:', e.message);
            }
        }
    });
}

// Start
startSock();
