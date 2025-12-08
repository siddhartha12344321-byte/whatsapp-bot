import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import { QuizEngine } from './quiz-engine.js';
import sanitizeHtml from 'sanitize-html';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Module-level state
let sock = null;
let currentQR = null;
let isConnected = false;

// In-memory chat history
const chatHistory = new Map();

// Gemini fallback client
let genAI = null;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log("✅ Gemini AI initialized as fallback");
}

// ---------- Express App ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
    const status = isConnected ? `✅ Connected as ${sock?.user?.pushname || 'Unknown'}` : '⚠️ Not connected';
    res.send(`<h1>WhatsApp UPSC Tutor Bot</h1><p>${status}</p><p><a href="/qr">QR Code</a> | <a href="/quizsection">Quiz Section</a> | <a href="/health">Health</a></p>`);
});

app.get('/health', (_, res) => res.send('OK'));

app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`<html><body style="font-family:Arial;text-align:center;padding:50px;"><h1>✅ Connected as ${sock?.user?.pushname || 'Unknown'}</h1><a href="/">Home</a></body></html>`);
    }
    if (!currentQR) {
        return res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:Arial;text-align:center;padding:50px;"><h1>⏳ Waiting for QR...</h1></body></html>`);
    }
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`<html><head><meta http-equiv="refresh" content="10"></head><body style="font-family:Arial;text-align:center;padding:20px;"><h1>📱 Scan QR Code</h1><img src="${qrImage}" style="max-width:400px;"/></body></html>`);
    } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
    }
});

app.get('/quizsection', (req, res) => res.sendFile(path.join(__dirname, 'public', 'quizsection.html')));

app.listen(PORT, () => console.log(`🚀 Express listening on ${PORT}`));

// ---------- Quiz Engine (Groq Primary) ----------
const quizEngine = new QuizEngine(process.env.GROQ_API_KEY);
console.log("✅ QuizEngine initialized (Groq primary)");

// ---------- Helper Functions ----------
function updateHistory(chatId, role, content) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const h = chatHistory.get(chatId);
    h.push({ role: role === 'model' ? 'assistant' : role, content });
    if (h.length > 20) h.shift();
}

function normalizeMessages(messages) {
    return messages.map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content || '' })).filter(m => m.content.trim());
}

// Image analysis with DeepSeek
async function analyzeImageWithDeepSeek(base64Data, mimeType) {
    if (!DEEPSEEK_API_KEY) throw new Error("DeepSeek API key not configured");
    console.log("📸 Analyzing image with DeepSeek-VL...");
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
            model: 'deepseek-vl2',
            messages: [{
                role: 'user', content: [
                    { type: 'text', text: 'Analyze this image. If it contains exam questions/MCQs, identify the correct answer and explain. Otherwise describe the content.' },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }
                ]
            }],
            max_tokens: 1000
        })
    });
    if (!response.ok) throw new Error(`DeepSeek error: ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'Could not analyze image';
}

// Gemini fallback for chat
async function chatWithGemini(prompt, systemPrompt) {
    if (!genAI) throw new Error("Gemini not configured");
    const model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
    });
    const result = await model.generateContent(`${systemPrompt}\n\nUser: ${prompt}`);
    return result.response.text();
}

// ---------- Message Handler ----------
async function handleMessage(msg, remoteJid) {
    try {
        const messageContent = msg.message;
        if (!messageContent) return;

        // Check for media (image/PDF)
        const imageMsg = messageContent.imageMessage;
        const docMsg = messageContent.documentMessage;

        // Extract text
        let prompt = messageContent.conversation || messageContent.extendedTextMessage?.text || messageContent.imageMessage?.caption || '';
        prompt = sanitizeHtml(prompt.replace(/@\S+/g, "").trim());

        // Handle image
        if (imageMsg) {
            console.log("🖼️ Image received");
            try {
                await sock.sendMessage(remoteJid, { text: "🔍 Analyzing image..." });
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const base64 = buffer.toString('base64');
                const analysis = await analyzeImageWithDeepSeek(base64, imageMsg.mimetype || 'image/jpeg');
                await sock.sendMessage(remoteJid, { text: `📸 *Image Analysis:*\n\n${analysis}` });
                return;
            } catch (e) {
                console.error("Image analysis error:", e.message);
                await sock.sendMessage(remoteJid, { text: `⚠️ Image analysis failed: ${e.message}` });
                return;
            }
        }

        // Handle PDF
        if (docMsg && docMsg.mimetype === 'application/pdf') {
            console.log("📄 PDF received");
            try {
                await sock.sendMessage(remoteJid, { text: "📄 Processing PDF for quiz generation..." });
                const buffer = await downloadMediaMessage(msg, 'buffer', {});

                // Parse topic from caption
                let topic = 'General';
                const topicMatch = prompt.match(/(?:topic|about|on)\s*[:\s]?\s*([^,\n]+)/i);
                if (topicMatch) topic = topicMatch[1].trim();

                const questions = await quizEngine.generateQuizFromPdfBuffer({ pdfBuffer: buffer, topic, qty: 10, difficulty: 'medium' });

                if (questions.length === 0) {
                    await sock.sendMessage(remoteJid, { text: `❌ No questions generated. Try a different topic.` });
                    return;
                }

                // Send quiz as polls would require Baileys poll implementation
                // For now, send as text
                let quizText = `📚 *Quiz: ${topic}* (${questions.length} questions)\n\n`;
                questions.forEach((q, i) => {
                    quizText += `*Q${i + 1}.* ${q.question}\n`;
                    q.options.forEach((opt, j) => quizText += `${String.fromCharCode(65 + j)}) ${opt}\n`);
                    quizText += `✅ Answer: ${String.fromCharCode(65 + q.correct_index)}\n💡 ${q.answer_explanation || ''}\n\n`;
                });

                // Split if too long
                if (quizText.length > 4000) {
                    const chunks = quizText.match(/.{1,4000}/gs) || [quizText];
                    for (const chunk of chunks) await sock.sendMessage(remoteJid, { text: chunk });
                } else {
                    await sock.sendMessage(remoteJid, { text: quizText });
                }
                return;
            } catch (e) {
                console.error("PDF processing error:", e.message);
                await sock.sendMessage(remoteJid, { text: `⚠️ PDF processing failed: ${e.message}` });
                return;
            }
        }

        if (!prompt) return;
        console.log(`📩 Received: ${prompt}`);

        // Quiz from topic
        if (prompt.match(/\b(create|generate|make|start)\s+(?:a\s+)?(?:mock\s+)?(?:test|quiz|poll)/i) && !imageMsg && !docMsg) {
            let topic = 'General Knowledge';
            const topicMatch = prompt.match(/(?:on|about|topic)\s+["']?([^"'\n]+)["']?/i);
            if (topicMatch) topic = topicMatch[1].trim();

            let qty = 10;
            const qtyMatch = prompt.match(/(\d+)\s*(?:questions?|q)/i);
            if (qtyMatch) qty = Math.min(50, Math.max(1, parseInt(qtyMatch[1])));

            await sock.sendMessage(remoteJid, { text: `🧠 Generating ${qty} questions on "${topic}"...` });

            try {
                const questions = await quizEngine.generateQuizFromTopic({ topic, qty, difficulty: 'medium' });
                if (questions.length === 0) {
                    await sock.sendMessage(remoteJid, { text: `❌ Could not generate questions for "${topic}".` });
                    return;
                }

                let quizText = `📚 *Quiz: ${topic}* (${questions.length} questions)\n\n`;
                questions.forEach((q, i) => {
                    quizText += `*Q${i + 1}.* ${q.question}\n`;
                    q.options.forEach((opt, j) => quizText += `${String.fromCharCode(65 + j)}) ${opt}\n`);
                    quizText += `✅ Answer: ${String.fromCharCode(65 + q.correct_index)}\n💡 ${q.answer_explanation || ''}\n\n`;
                });

                if (quizText.length > 4000) {
                    const chunks = quizText.match(/.{1,4000}/gs) || [quizText];
                    for (const chunk of chunks) await sock.sendMessage(remoteJid, { text: chunk });
                } else {
                    await sock.sendMessage(remoteJid, { text: quizText });
                }
            } catch (e) {
                console.error("Quiz generation error:", e.message);
                await sock.sendMessage(remoteJid, { text: `⚠️ Quiz generation failed: ${e.message}` });
            }
            return;
        }

        // Stop quiz
        if (prompt.toLowerCase().includes("cancel quiz") || prompt.toLowerCase().includes("stop quiz")) {
            await sock.sendMessage(remoteJid, { text: quizEngine.stopQuiz(remoteJid) ? "✅ Quiz stopped." : "ℹ️ No active quiz." });
            return;
        }

        // General AI chat with Groq primary, Gemini fallback
        const isMCQ = prompt.match(/\?/) && (prompt.match(/^[A-D][).]/m) || prompt.match(/option|choose|select|explain|correct/i));

        const systemPrompt = isMCQ
            ? `You are an expert UPSC/SSC exam tutor. For MCQs, provide: ✅ Answer, 💡 Explanation (2-3 sentences), 🔑 Key Point. MAX 100 words.`
            : `You are an expert UPSC/government exam tutor. Be helpful, educational, concise. Remember: you help students prepare for competitive exams.`;

        const messagesArray = [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
            ...normalizeMessages(chatHistory.get(remoteJid) || [])
        ];

        let responseText = "";

        // Try Groq first
        try {
            console.log("🤖 Trying Groq...");
            const chatSession = await quizEngine.chat(messagesArray);
            responseText = chatSession.response.text();
        } catch (groqErr) {
            console.warn("⚠️ Groq failed, trying Gemini fallback:", groqErr.message);
            // Gemini fallback
            try {
                responseText = await chatWithGemini(prompt, systemPrompt);
                console.log("✅ Gemini fallback succeeded");
            } catch (geminiErr) {
                console.error("❌ Both Groq and Gemini failed:", geminiErr.message);
                await sock.sendMessage(remoteJid, { text: "⚠️ AI service unavailable. Please try again later." });
                return;
            }
        }

        if (!responseText?.trim()) responseText = "I couldn't generate a response. Please try again!";

        updateHistory(remoteJid, 'user', prompt);
        updateHistory(remoteJid, 'assistant', responseText);

        await sock.sendMessage(remoteJid, { text: responseText });
        console.log("✅ Response sent");

    } catch (err) {
        console.error("❌ Message error:", err.message);
        try { await sock.sendMessage(remoteJid, { text: "⚠️ An error occurred. Please try again!" }); } catch { }
    }
}

// ---------- Baileys Socket ----------
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { currentQR = qr; qrcodeTerminal.generate(qr, { small: true }); console.log('📱 QR ready - visit /qr'); }
        if (connection === 'close') {
            isConnected = false; currentQR = null;
            const reconnect = (lastDisconnect?.error?.output?.statusCode ?? 0) !== DisconnectReason.loggedOut;
            console.log('❌ Disconnected. Reconnect?', reconnect);
            if (reconnect) startSock();
        } else if (connection === 'open') {
            isConnected = true; currentQR = null;
            console.log('✅ WhatsApp connected - UPSC Tutor Bot ready!');
        }
    });

    sock.ev.on('messages.upsert', async (upsert) => {
        for (const msg of (upsert.messages || [])) {
            if (msg.key.fromMe || !msg.key.remoteJid) continue;
            await handleMessage(msg, msg.key.remoteJid);
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const upd of updates) {
            if (!upd.update?.pollUpdates) continue;
            try {
                const pollMsg = await getAggregateVotesInPollMessage({ message: upd.update, key: upd.key });
                if (pollMsg) await quizEngine.handleVote(pollMsg);
            } catch (e) { console.error('Poll vote error:', e.message); }
        }
    });
}

startSock();
