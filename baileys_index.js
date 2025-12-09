import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, DisconnectReason, downloadMediaMessage, delay } from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import { QuizEngine } from './quiz-engine.js';
import sanitizeHtml from 'sanitize-html';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { useMongoDBAuthState } from './mongo_auth.js';
import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';
import fs from 'fs';

// ---------- Global Error Handlers (Prevent Crashes) ----------
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection (not crashing):', reason?.message || reason);
});
process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error.message);
    // Don't exit - let the bot try to recover
});

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API Keys
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://amurag12344321_db_user:78mbO8WPw69AeTpt@siddharthawhatsappbot.wfbdgjf.mongodb.net/?appName=SiddharthaWhatsappBot";

// Global State
let sock = null;
let currentQR = null;
let isConnected = false;
let groupCache = {}; // id -> name

// --- Manual Simple Store (Fix for missing export) ---
const simpleStore = {
    messages: {}, // chatId -> { msgId -> msg }
    bind: (ev) => {
        ev.on('messages.upsert', ({ messages }) => {
            for (const m of messages) {
                const jid = m.key.remoteJid;
                if (!jid) continue;
                if (!simpleStore.messages[jid]) simpleStore.messages[jid] = {};
                simpleStore.messages[jid][m.key.id] = m;

                // Limit memory usage (keep last 100 messages per chat)
                const keys = Object.keys(simpleStore.messages[jid]);
                if (keys.length > 100) {
                    delete simpleStore.messages[jid][keys[0]];
                }
            }
        });
    },
    loadMessage: (jid, id) => {
        return simpleStore.messages[jid]?.[id];
    }
};
const store = simpleStore;

// Quiz State
const quizSessions = new Map(); // chatId -> Session Object
const activePolls = new Map(); // pollMsgId -> { chatId, questionIndex, options, correctIndex }
const chatHistory = new Map();
const polls = {}; // store pollId → poll data & votes (MANUAL TRACKING)

// ---------- Manual Vote Helpers ----------
function getPollResults(pollId) {
    const poll = polls[pollId];
    if (!poll) return null;

    const counts = Array(poll.options.length).fill(0);

    for (const voter in poll.votes) {
        counts[poll.votes[voter]]++;
    }

    return {
        question: poll.question,
        options: poll.options,
        counts
    };
}

// Shows "QUIZ RESULT" with Green/White squares
async function sendPollResult(jid, pollId, correctIndex) {
    const result = getPollResults(pollId);
    if (!result) return;

    let text = `*QUIZ RESULT*\n\n`;
    text += `*Q:* ${result.question}\n\n`;

    result.options.forEach((opt, i) => {
        text += `${i === correctIndex ? "🟩" : "⬜"} ${opt} — *${result.counts[i]} votes*\n`;
    });

    await sock.sendMessage(jid, { text });
}

// ---------- AI Clients ----------
const quizEngine = new QuizEngine(GROQ_API_KEY);
let genAI = null;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    console.log("✅ Gemini AI Initialized");
}

// ---------- MongoDB & Schemas ----------
mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

const QuizSchema = new mongoose.Schema({
    title: { type: String, required: true },
    topics: [String],
    questions: [{
        question: String,
        options: [String],
        correct: Number,
        explanation: String
    }],
    creator: String,
    status: { type: String, default: 'draft' },
    createdAt: { type: Date, default: Date.now },
    deployed: { type: Boolean, default: false },
    scheduledTime: Date,
    targetGroupId: String,
    timer: { type: Number, default: 30 },
    autoReportCard: { type: Boolean, default: true }
});
const Quiz = mongoose.model('Quiz', QuizSchema);

// ---------- Express Server ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Web Routes
app.get('/', (req, res) => res.send(`<h1>WhatsApp Bot Active</h1><p>Status: ${isConnected ? '✅ Connected' : '❌ Disconnected'}</p><p><a href="/qr">QR</a> | <a href="/quizsection">Quiz Panel</a></p>`));
app.get('/health', (_, res) => res.send('OK'));
app.get('/qr', async (req, res) => {
    if (isConnected) return res.send(`<html><body><h1>✅ Bot is connected</h1><a href="/">Home</a></body></html>`);
    if (!currentQR) return res.send(`<html><head><meta http-equiv="refresh" content="2"></head><body><h1>⏳ Generating QR...</h1></body></html>`);
    const url = await QRCode.toDataURL(currentQR);
    res.send(`<html><head><meta http-equiv="refresh" content="5"></head><body style="text-align:center;"><h1>Scan QR Code</h1><img src="${url}" /><br>Refresh page if needed.</body></html>`);
});
app.get('/quizsection', (req, res) => res.sendFile(path.join(__dirname, 'public', 'quizsection.html')));

// API Routes
app.get('/api/groups', async (req, res) => {
    if (sock) {
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const id in groups) groupCache[id] = groups[id].subject;
        } catch (e) { }
    }
    const list = Object.keys(groupCache).map(id => ({ id, name: groupCache[id] || id }));
    res.json(list);
});

app.get('/api/quiz/counts', async (req, res) => {
    try {
        const counts = {};
        for (const creator of ['SIDDHARTHA', 'SAURABH', 'VIKAS', 'GAURAV']) {
            counts[creator] = await Quiz.countDocuments({ creator });
        }
        res.json(counts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/quizzes/:creator', async (req, res) => {
    try {
        const list = await Quiz.find({ creator: req.params.creator }).sort({ createdAt: -1 });
        res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/quiz/create', async (req, res) => {
    try {
        const data = req.body;
        // Fix: Map frontend 'targetGroup' to schema 'targetGroupId'
        if (data.targetGroup) data.targetGroupId = data.targetGroup;

        const quiz = new Quiz(data);

        // Immediate Deployment Trigger
        if (data.status === 'active' && data.targetGroupId) {
            if (sock) {
                console.log(`🚀 Immediate Deployment: Starting quiz "${quiz.title}" in ${data.targetGroupId}`);
                try {
                    await startQuizSession(data.targetGroupId, quiz);
                    quiz.deployed = true;
                } catch (err) {
                    console.error("❌ Failed to start quiz session:", err);
                }
            } else {
                console.error("⚠️ Socket not ready for immediate deployment");
            }
        }

        await quiz.save();
        res.json({ success: true, id: quiz._id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/quiz/delete/:id', async (req, res) => {
    try {
        await Quiz.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/quiz/deploy/:id', async (req, res) => {
    try {
        const quiz = await Quiz.findById(req.params.id);
        if (!quiz) return res.status(404).json({ error: 'Not found' });

        const groupId = quiz.targetGroupId || req.body.groupId;
        if (!groupId) return res.status(400).json({ error: 'No group selected' });

        if (!groupCache[groupId]) {
            try { await sock.groupMetadata(groupId); } catch (e) { }
        }

        startQuizSession(groupId, quiz);
        quiz.deployed = true;
        await quiz.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Quiz Logic ----------

async function startQuizSession(chatId, quizData) {
    if (quizSessions.has(chatId)) {
        await sock.sendMessage(chatId, { text: "⚠️ A quiz is already in progress here!" });
        return;
    }

    await sock.sendMessage(chatId, { text: `📢 *New Quiz Started: ${quizData.title}*\n\n❓ Questions: ${quizData.questions.length}\n⏱️ Timer: ${quizData.timer}s per question\n\nGet ready!` });
    await delay(3000);

    const session = {
        title: quizData.title,
        questions: quizData.questions,
        timer: quizData.timer,
        currentIndex: 0,
        questionScores: [],
        chatId: chatId,
        active: true
    };
    quizSessions.set(chatId, session);
    runNextQuestion(chatId);
}

async function runNextQuestion(chatId) {
    const session = quizSessions.get(chatId);
    if (!session || !session.active) return;

    if (session.currentIndex >= session.questions.length) {
        endQuiz(chatId);
        return;
    }

    const q = session.questions[session.currentIndex];
    session.questionScores[session.currentIndex] = new Map();

    // Handle both formats: correct (web UI) and correct_index (QuizEngine)
    const correctIndex = q.correct !== undefined ? q.correct : q.correct_index;

    // Send Poll
    const sentMsg = await sock.sendMessage(chatId, {
        poll: {
            name: `Q${session.currentIndex + 1}: ${q.question}`,
            values: q.options,
            selectableCount: 1
        }
    });

    // Wait for Timer
    setTimeout(async () => {
        if (!sentMsg) return;
        const pollId = sentMsg.key.id;

        // --- Calculate Scores Manually ---
        const pollData = polls[pollId];
        if (pollData) {
            const qScoreMap = session.questionScores[session.currentIndex];

            // Iterate all votes
            for (const voter in pollData.votes) {
                const votedIndex = pollData.votes[voter];
                if (votedIndex === correctIndex) {
                    qScoreMap.set(voter, 1); // Correct answer = 1 point
                }
            }
        } else {
            console.warn(`⚠️ Poll data not found for ID: ${pollId}`);
        }

        // --- Show Result (User requested format) ---
        await sendPollResult(chatId, pollId, correctIndex);

        // Cleanup manual poll data to save memory
        if (polls[pollId]) delete polls[pollId];

        session.currentIndex++;
        await delay(2000);
        runNextQuestion(chatId);
    }, session.timer * 1000);
}

function endQuiz(chatId) {
    const session = quizSessions.get(chatId);
    if (!session) return;

    const totalScores = new Map();
    session.questionScores.forEach(qMap => {
        qMap.forEach((points, userId) => {
            totalScores.set(userId, (totalScores.get(userId) || 0) + points);
        });
    });

    const sortedScores = [...totalScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    let report = `🏆 *Quiz Report: ${session.title}* 🏆\n\n`;
    if (sortedScores.length === 0) {
        report += "No participation recorded.";
    } else {
        sortedScores.forEach((entry, idx) => {
            const [uid, score] = entry;
            const name = uid.split('@')[0];
            report += `${idx + 1}. @${name} : ${score}/${session.questions.length}\n`;
        });
    }

    sock.sendMessage(chatId, {
        text: report,
        mentions: sortedScores.map(s => s[0])
    });

    quizSessions.delete(chatId);
}

// ---------- Helper Functions ----------
function updateHistory(chatId, role, content) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const h = chatHistory.get(chatId);
    h.push({ role: role === 'model' ? 'assistant' : role, content });
    if (h.length > 20) h.shift();
}

function normalizeMessages(messages) {
    return messages.map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content || '' })).filter(m => m.content && m.content.trim().length > 0);
}

async function analyzeImage(buffer, mime) {
    const base64 = buffer.toString('base64');

    // Try Gemini Vision first (most reliable)
    if (genAI) {
        try {
            console.log("📸 Trying Gemini Vision...");
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const result = await model.generateContent([
                { text: "Analyze this image. If it's an exam question, solve it step by step. If not, describe what you see in detail." },
                { inlineData: { data: base64, mimeType: mime } }
            ]);
            const text = result.response.text();
            if (text && text.length > 10) {
                console.log("✅ Gemini Vision success");
                return text;
            }
        } catch (e) {
            console.warn("⚠️ Gemini Vision failed:", e.message);
        }
    }

    // Try Groq Llama Vision as fallback
    if (GROQ_API_KEY) {
        try {
            console.log("📸 Trying Groq Llama Vision...");
            const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'llama-3.2-11b-vision-preview',
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Analyze this image. If exam question, solve it. Otherwise describe it.' },
                            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
                        ]
                    }],
                    max_tokens: 1024
                })
            });
            const data = await resp.json();
            if (resp.ok && data.choices?.[0]?.message?.content) {
                console.log("✅ Groq Vision success");
                return data.choices[0].message.content;
            }
            console.warn("⚠️ Groq Vision response:", data.error?.message || "No content");
        } catch (e) {
            console.warn("⚠️ Groq Vision failed:", e.message);
        }
    }

    // Try DeepSeek as last resort
    if (DEEPSEEK_API_KEY) {
        try {
            console.log("📸 Trying DeepSeek Vision...");
            const resp = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Analyze this image. If exam question, solve it. If not, describe it.' },
                            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
                        ]
                    }]
                })
            });
            const data = await resp.json();
            if (resp.ok && data.choices?.[0]?.message?.content) {
                console.log("✅ DeepSeek Vision success");
                return data.choices[0].message.content;
            }
            console.warn("⚠️ DeepSeek response:", data.error?.message || JSON.stringify(data));
        } catch (e) {
            console.warn("⚠️ DeepSeek Vision failed:", e.message);
        }
    }

    return "❌ Image analysis failed - no vision API available. Please check API keys.";
}

// Check API Keys at Startup
if (!GEMINI_API_KEY && !GROQ_API_KEY && !DEEPSEEK_API_KEY) {
    console.warn("⚠️ NO AI API KEYS FOUND! Image and PDF analysis will NOT work. Please set GEMINI_API_KEY, GROQ_API_KEY, or DEEPSEEK_API_KEY.");
} else {
    if (GEMINI_API_KEY) console.log("✅ Gemini API Key found");
    if (GROQ_API_KEY) console.log("✅ Groq API Key found");
    if (DEEPSEEK_API_KEY) console.log("✅ DeepSeek API Key found");
}

// ---------- PDF Analysis with Multi-Provider Fallback ----------
async function analyzePdf(buffer, userQuestion = null) {
    const base64 = buffer.toString('base64');

    // 1. Try Gemini Native PDF Support (Best for Scanned PDFs/images)
    if (genAI) {
        try {
            console.log("📄 Trying Gemini Native PDF Analysis...");
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

            const prompt = userQuestion
                ? `Answer this question based on the document: "${userQuestion}"`
                : "Analyze this document. partial summary, key points, and important facts.";

            const result = await model.generateContent([
                { text: prompt },
                { inlineData: { data: base64, mimeType: "application/pdf" } }
            ]);

            const text = result.response.text();
            if (text && text.length > 20) {
                console.log("✅ Gemini PDF success");
                return text;
            }
        } catch (e) {
            console.warn("⚠️ Gemini PDF failed:", e.message);
        }
    }

    // 2. Fallback: Extract Text (for Groq/DeepSeek)
    // Only useful if PDF works with pdf-parse (not scanned)
    let pdfText = '';
    try {
        const pdfParse = (await import('pdf-parse')).default;
        const data = await pdfParse(buffer);
        pdfText = data.text || '';
        console.log(`📄 Extracted ${pdfText.length} characters from PDF`);
    } catch (e) {
        console.error("PDF extraction error:", e.message);
    }

    if (pdfText.length < 50) {
        if (!genAI) return "❌ PDF appears to be scanned/image-only. Gemini API Key required to analyze scanned PDFs.";
        return "❌ PDF appears to be empty or contains only images.";
    }

    // Truncate if too large
    if (pdfText.length > 30000) {
        pdfText = pdfText.substring(0, 30000) + "\n...[truncated]";
    }

    const promptText = userQuestion
        ? `Based on context, answer: "${userQuestion}"\n\nCONTEXT:\n${pdfText}`
        : `Summarize this:\n\n${pdfText}`;

    // Try Groq as fallback
    if (GROQ_API_KEY) {
        try {
            console.log("📄 Trying Groq for PDF analysis...");
            const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: promptText }],
                    max_tokens: 2048
                })
            });
            const data = await resp.json();
            if (resp.ok && data.choices?.[0]?.message?.content) {
                console.log("✅ Groq PDF analysis success");
                return data.choices[0].message.content;
            }
        } catch (e) {
            console.warn("⚠️ Groq PDF failed:", e.message);
        }
    }

    return "❌ PDF analysis failed. Please ensure GEMINI_API_KEY is set for best results.";
}

// ---------- Main Message Handler ----------
async function handleMessage(msg, remoteJid) {
    try {
        if (!msg.message) return;

        if (remoteJid.endsWith('@g.us')) {
            groupCache[remoteJid] = msg.pushName || (groupCache[remoteJid] || remoteJid);
        }

        const msgContent = msg.message;
        let text = msgContent.conversation || msgContent.extendedTextMessage?.text || msgContent.imageMessage?.caption || '';
        text = text.trim();

        if (msgContent.documentMessage && msgContent.documentMessage.mimetype === 'application/pdf') {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            const caption = text.toLowerCase();

            // Check what user wants to do with PDF
            const wantsQuiz = caption.includes('quiz') || caption.includes('test') || caption.includes('mcq');
            const hasQuestion = caption.includes('?') || caption.startsWith('what') || caption.startsWith('how') ||
                caption.startsWith('why') || caption.startsWith('explain') || caption.startsWith('tell');

            try {
                if (wantsQuiz) {
                    // Mode 1: Generate Quiz from PDF
                    await sock.sendMessage(remoteJid, { text: "📝 Generating quiz from PDF..." });
                    let topic = 'General';
                    const match = text.match(/(?:topic|on|about)\\s+([a-zA-Z0-9 ]+)/i);
                    if (match) topic = match[1];

                    const questions = await quizEngine.generateQuizFromPdfBuffer({ pdfBuffer: buffer, topic, qty: 10 });
                    if (questions.length > 0) {
                        await startQuizSession(remoteJid, { title: `PDF Quiz: ${topic}`, questions, timer: 30 });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "❌ Could not generate quiz from this PDF." });
                    }
                } else if (hasQuestion) {
                    // Mode 2: Answer question from PDF content
                    await sock.sendMessage(remoteJid, { text: "🔍 Searching PDF for answer..." });
                    const answer = await analyzePdf(buffer, text);
                    await sock.sendMessage(remoteJid, { text: `📄 *Answer from PDF:*\n\n${answer}` });
                } else {
                    // Mode 3: Summarize PDF
                    await sock.sendMessage(remoteJid, { text: "📄 Analyzing PDF..." });
                    const summary = await analyzePdf(buffer, null);
                    await sock.sendMessage(remoteJid, { text: `📄 *PDF Summary:*\n\n${summary}` });
                }
            } catch (e) {
                console.error("PDF Error:", e);
                await sock.sendMessage(remoteJid, { text: "⚠️ PDF Error: " + e.message });
            }
            return;
        }

        if (msgContent.imageMessage) {
            await sock.sendMessage(remoteJid, { text: "🔍 Analyzing Image..." });
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const result = await analyzeImage(buffer, msgContent.imageMessage.mimetype);
                await sock.sendMessage(remoteJid, { text: `📸 *Analysis:*\n${result}` });
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: "⚠️ Image Error: " + e.message });
            }
            return;
        }

        if (text.match(/!quiz stop/i) || text.match(/stop quiz/i)) {
            if (quizSessions.has(remoteJid)) {
                quizSessions.get(remoteJid).active = false;
                quizSessions.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: "🛑 Quiz Stopped." });
            } else {
                await sock.sendMessage(remoteJid, { text: "ℹ️ No quiz running." });
            }
            return;
        }

        /*
        // DISABLED: Quiz generation via chat commands
        if (text.match(/!quiz start/i) || text.match(/create quiz/i)) {
            let topic = "General Knowledge";
            const match = text.match(/on\s+([a-zA-Z0-9 ]+)/i);
            if (match) topic = match[1];

            await sock.sendMessage(remoteJid, { text: `🧠 Generating quiz on "${topic}"...` });
            try {
                const questions = await quizEngine.generateQuizFromTopic({ topic, qty: 10 });
                await startQuizSession(remoteJid, { title: topic, questions, timer: 30 });
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: "❌ Generation Failed: " + e.message });
            }
            return;
        }
        */

        if (!text) return;

        console.log(`📩 [${remoteJid}] ${text}`);

        const isMCQ = text.includes('?') && (text.includes('Option') || text.match(/^[A-D]\)/m));
        const systemPrompt = isMCQ
            ? "You are a UPSC Exam Tutor. For MCQs, give Answer, Explanation, and Key Concept. Concise."
            : "You are a helpful UPSC Exam Tutor. Helping students prepare. Be polite and concise.";

        updateHistory(remoteJid, 'user', text);
        const messages = [
            { role: 'system', content: systemPrompt },
            ...normalizeMessages(chatHistory.get(remoteJid) || [])
        ];

        let response = "";
        try {
            const chat = await quizEngine.chat(messages);
            response = chat.response.text();
        } catch (e) {
            console.warn("Groq failed, trying Gemini...");
            if (genAI) {
                const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
                const res = await model.generateContent(systemPrompt + "\n\n" + text);
                response = res.response.text();
            } else {
                response = "⚠️ AI Unavailable.";
            }
        }

        updateHistory(remoteJid, 'assistant', response);
        await sock.sendMessage(remoteJid, { text: response });

    } catch (e) {
        console.error("Handler Error:", e);
    }
}


// Global Mongo Client
const mongoClient = new MongoClient(MONGODB_URI);
let authCollection = null;

async function initMongo() {
    try {
        await mongoClient.connect();
        authCollection = mongoClient.db("whatsapp_bot").collection("auth_state_baileys");
        console.log("✅ MongoDB Global Client Connected");
    } catch (e) {
        console.error("❌ MongoDB Connection Error:", e);
        process.exit(1);
    }
}

// ---------- Socket Start ----------
async function startSock() {
    if (!authCollection) await initMongo();

    // Auth
    const { state, saveCreds } = await useMongoDBAuthState(authCollection);

    // Fetch latest version
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'warn' }), // Reduce log noise (was 'info')
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        // Better timeout handling for Render's network
        connectTimeoutMs: 60000, // 60 seconds connection timeout
        retryRequestDelayMs: 2000, // Wait 2s before retrying failed requests
        defaultQueryTimeoutMs: 60000 // 60s for queries
    });

    store.bind(sock.ev);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr;
            console.log("Scan this QR Code to login:");
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('✅ Connected to WhatsApp!');
            setTimeout(async () => {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    for (const id in groups) groupCache[id] = groups[id].subject;
                    console.log(`📂 Cached ${Object.keys(groupCache).length} groups`);
                } catch (e) { console.error("Group fetch failed:", e.message); }
            }, 5000);
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.error('❌ Connection Closed:', lastDisconnect?.error);
            console.log('Reconnecting:', shouldReconnect);
            if (shouldReconnect) startSock();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg || !msg.message) return;

        // --- 1. Manual Poll Tracking Logic (User provided) ---

        // When a poll is created (Outgoing or Incoming)
        if (msg.message.pollCreationMessage || msg.message.pollCreationMessageV3) {
            const pollMsg = msg.message.pollCreationMessage || msg.message.pollCreationMessageV3;
            const pollId = msg.key.id;

            polls[pollId] = {
                question: pollMsg.name,
                options: pollMsg.options.map(o => o.optionName),
                // optionHashes usually match optionName in simple polls, or strict sha256 in V3. 
                // We map both to ensure we catch votes.
                optionHashes: pollMsg.options.map(o => o.optionName),
                votes: {}
            };

            console.log("� POLL CREATED (Manual Track):", pollId);
        }

        // When a user votes
        if (msg.message.pollUpdateMessage) {
            const pollUpdate = msg.message.pollUpdateMessage;
            const pollId = pollUpdate.pollCreationMessageKey?.id; // Baileys standard location

            if (polls[pollId]) {
                const vote = pollUpdate.vote;
                const voter = msg.key.participant || msg.key.remoteJid;

                if (vote && vote.selectedOption) {
                    const selectedOption = vote.selectedOption;
                    const optionIndex = polls[pollId].options.indexOf(selectedOption);

                    if (optionIndex !== -1) {
                        polls[pollId].votes[voter] = optionIndex;
                        console.log(`🗳️ VOTE RECEIVED → ${voter.split('@')[0]} voted for "${selectedOption}"`);
                    }
                }
            }
        }

        // --- 2. Normal Message Handling ---
        if (!msg.key.fromMe && msg.key.remoteJid) {
            await handleMessage(msg, msg.key.remoteJid);
        }
    });

    // Removed: sock.ev.on('messages.update') - No longer needed
}

app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
startSock();
