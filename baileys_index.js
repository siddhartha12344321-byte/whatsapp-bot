import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, DisconnectReason, downloadMediaMessage, delay, makeInMemoryStore } from '@whiskeysockets/baileys';
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

// InMemory Store for Baileys (to track poll messages)
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });
// We can bind the store later

// Quiz State
const quizSessions = new Map(); // chatId -> Session Object
const activePolls = new Map(); // pollMsgId -> { chatId, questionIndex, options, correctIndex }

// Chat History
const chatHistory = new Map();

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
    createdAt: { type: Date, default: Date.now },
    deployed: { type: Boolean, default: false },
    scheduledTime: Date,
    targetGroupId: String,
    timer: { type: Number, default: 30 }
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
        const quiz = new Quiz(req.body);
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
            // Try to fetch to ensure access
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
        questionScores: [], // Array of Map<userId, points> (0 or 1)
        chatId: chatId,
        active: true
    };
    quizSessions.set(chatId, session);
    runNextQuestion(chatId);
}

async function runNextQuestion(chatId) {
    const session = quizSessions.get(chatId);
    if (!session || !session.active) return; // Stopped

    if (session.currentIndex >= session.questions.length) {
        endQuiz(chatId);
        return;
    }

    const q = session.questions[session.currentIndex];
    session.questionScores[session.currentIndex] = new Map(); // Init scores for this question

    // Send Poll
    const sentMsg = await sock.sendMessage(chatId, {
        poll: {
            name: `Q${session.currentIndex + 1}: ${q.question}`,
            values: q.options,
            selectableCount: 1
        }
    });

    if (sentMsg) {
        activePolls.set(sentMsg.key.id, {
            chatId,
            questionIndex: session.currentIndex,
            options: q.options,
            correctIndex: q.correct
        });
    }

    // Wait for Timer
    setTimeout(async () => {
        // Calculate/Show Answer
        const correctOpt = q.options[q.correct];
        await sock.sendMessage(chatId, {
            text: `⏰ Time's up!\n\n✅ Correct: *${correctOpt}*\n\n💡 ${q.explanation || ''}`
        });

        // Clean up poll tracking after question ends (votes no longer counted)
        if (sentMsg) activePolls.delete(sentMsg.key.id);

        session.currentIndex++;
        await delay(2000);
        runNextQuestion(chatId);
    }, session.timer * 1000);
}

function endQuiz(chatId) {
    const session = quizSessions.get(chatId);
    if (!session) return;

    // Aggregating Total Scores
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
            // Format ID: 12345@s.whatsapp.net -> 12345
            const name = uid.split('@')[0];
            report += `${idx + 1}. @${name} : ${score}/${session.questions.length}\n`;
        });
    }

    // Send Report
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
    if (!DEEPSEEK_API_KEY) throw new Error("DeepSeek Config Missing");
    const base64 = buffer.toString('base64');
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
            model: 'deepseek-vl2',
            messages: [
                {
                    role: 'user', content: [
                        { type: 'text', text: 'Analyze this. If exam question, solve it. If not, describe it.' },
                        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
                    ]
                }
            ]
        })
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "Analysis failed";
}

// ---------- Main Message Handler ----------
async function handleMessage(msg, remoteJid) {
    try {
        if (!msg.message) return;

        // Populate Group Cache
        if (remoteJid.endsWith('@g.us')) {
            groupCache[remoteJid] = msg.pushName || (groupCache[remoteJid] || remoteJid);
        }

        const msgContent = msg.message;
        let text = msgContent.conversation || msgContent.extendedTextMessage?.text || msgContent.imageMessage?.caption || '';
        text = text.trim();

        // 1. PDF Handling
        if (msgContent.documentMessage && msgContent.documentMessage.mimetype === 'application/pdf') {
            await sock.sendMessage(remoteJid, { text: "📄 Reading PDF..." });
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                let topic = 'General';
                const match = text.match(/(?:topic|on)\s+([a-zA-Z0-9 ]+)/i);
                if (match) topic = match[1];

                const questions = await quizEngine.generateQuizFromPdfBuffer({ pdfBuffer: buffer, topic, qty: 10 });
                if (questions.length > 0) {
                    await startQuizSession(remoteJid, { title: `PDF Quiz: ${topic}`, questions, timer: 30 });
                } else {
                    await sock.sendMessage(remoteJid, { text: "❌ No questions found in PDF." });
                }
            } catch (e) {
                console.error(e);
                await sock.sendMessage(remoteJid, { text: "⚠️ PDF Error: " + e.message });
            }
            return;
        }

        // 2. Image Handling
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

        // 3. Quiz Commands
        if (text.match(/!quiz stop/i) || text.match(/stop quiz/i)) {
            if (quizSessions.has(remoteJid)) {
                quizSessions.get(remoteJid).active = false; // Stop loop
                quizSessions.delete(remoteJid);
                await sock.sendMessage(remoteJid, { text: "🛑 Quiz Stopped." });
            } else {
                await sock.sendMessage(remoteJid, { text: "ℹ️ No quiz running." });
            }
            return;
        }

        if (text.match(/!quiz start/i) || text.match(/create quiz/i)) {
            // Simplified text quiz
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

        if (!text) return;

        // 4. AI Chat (Groq/Gemini)
        console.log(`📩 [${remoteJid}] ${text}`);

        // Determine Personality
        const isMCQ = text.includes('?') && (text.includes('Option') || text.match(/^[A-D]\)/m));
        const systemPrompt = isMCQ
            ? "You are a UPSC Exam Tutor. For MCQs, give Answer, Explanation, and Key Concept. Concise."
            : "You are a helpful UPSC Exam Tutor. Helping students prepare. Be polite and concise.";

        // History
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


// ---------- Socket Start ----------
async function startSock() {
    const mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const authCollection = mongoClient.db("whatsapp_bot").collection("auth_state_baileys");

    // Auth
    const { state, saveCreds } = await useMongoDBAuthState(authCollection);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ["UPSC Bot", "Chrome", "1.0.0"],
        syncFullHistory: false
    });

    // Bind Store
    store.bind(sock.ev);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) currentQR = qr;

        if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('✅ Connected to WhatsApp!');

            // Allow time for sync
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
            console.log('❌ Connection Closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startSock();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (!m.key.fromMe && m.key.remoteJid) {
                await handleMessage(m, m.key.remoteJid);
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.pollUpdates) {
                const pollId = update.key.id;
                const pollData = activePolls.get(pollId);

                if (pollData) {
                    const votes = await getAggregateVotesInPollMessage({
                        message: update.update,
                        key: update.key,
                        pollUpdates: update.update.pollUpdates
                    });

                    // Logic: Check correct vote
                    const correctOptionText = pollData.options[pollData.correctIndex];

                    const correctVoteEntry = votes.find(v => v.name === correctOptionText);
                    const currentCorrectVoters = new Set(correctVoteEntry ? correctVoteEntry.voters : []);

                    // Update Session Scores for this question
                    const session = quizSessions.get(pollData.chatId);
                    if (session && session.active && session.questionScores[pollData.questionIndex]) {

                        // We replace the entire map of who is currently winning this question
                        // If they change vote, they are gone from currentCorrectVoters
                        const qScoreMap = session.questionScores[pollData.questionIndex];
                        qScoreMap.clear();

                        currentCorrectVoters.forEach(voterJid => {
                            qScoreMap.set(voterJid, 1);
                        });
                    }
                }
            }
        }
    });
}

app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
startSock();
