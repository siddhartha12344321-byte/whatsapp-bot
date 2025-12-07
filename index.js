const { Client, LocalAuth, RemoteAuth, Poll, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');
const fs = require('fs');
const sanitizeHtml = require('sanitize-html');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const pdfParse = require('pdf-parse');
const mongoose = require('mongoose');
const { Pinecone } = require('@pinecone-database/pinecone');
const googleTTS = require('google-tts-api');

// --- CONFIGURATION ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://amurag12344321_db_user:78mbO8WPw69AeTpt@siddharthawhatsappbot.wfbdgjf.mongodb.net/?appName=SiddharthaWhatsappBot";
const PINECONE_API_KEY = process.env.PINECONE_API_KEY || 'pcsk_4YGs7G_FB4bw1RbEejhHeiwEeL8wrU2vS1vQfFS2TcdhxJjsrehCHMyeFtHw4cHJkWPZvc';
const indexName = 'whatsapp-bot';

// --- CONNECTIONS ---
// 1. MongoDB
mongoose.connect(MONGODB_URI)
    .then(() => console.log('🍃 MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 2. Pinecone
const pc = new Pinecone({ apiKey: PINECONE_API_KEY });

// 3. Gemini
const rawKeys = [process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY].filter(k => k);
let currentKeyIndex = 0;
let genAI = rawKeys.length ? new GoogleGenerativeAI(rawKeys[currentKeyIndex]) : null;

function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
    genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
    console.log(`🔑 Rotated to API Key Index: ${currentKeyIndex}`);
}

function getModel() {
    if (!genAI) rotateKey();
    return genAI.getGenerativeModel({
        model: "gemini-1.5-flash-001", // Precise version to avoid 404
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
    });
}

// ... Data Schemas ...

// ... (Skip to Helper Functions) ...

async function getEmbedding(text) {
    try {
        return await callWithRetry(async () => {
            if (!genAI) rotateKey();
            const model = genAI.getGenerativeModel({ model: "text-embedding-004" }); // CORRECT MODEL
            const result = await model.embedContent(text);
            return result.embedding.values;
        });
    } catch (e) {
        console.error("Embedding Error (Final):", e.message);
        return null; // Fail gracefully
    }
}

// --- DATA SCHEMAS ---
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    name: String,
    highScore: { type: Number, default: 0 },
    lastTopic: { type: String, default: 'General' },
    joined: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- MEMORY ---
const chatHistory = new Map();
const quizSessions = new Map();
const activePolls = new Map();
const rateLimit = new Map();

function updateHistory(chatId, role, text) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ role, parts: [{ text }] });
    if (history.length > 15) history.shift(); // Keep last 15 turns
}

function checkRateLimit(chatId) {
    const now = Date.now();
    const last = rateLimit.get(chatId) || 0;
    if (now - last < 1000) return false; // 1s cooldown
    rateLimit.set(chatId, now);
    return true;
}

// --- EXPRESS SERVER (HEALTH CHECK) ---
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = "";
let client; // Forward declaration

app.get('/', (req, res) => {
    let status = 'Initializing...';
    let color = 'orange';
    if (client && client.info && client.info.wid) {
        status = '✅ WhatsApp Connected (' + client.info.pushname + ')';
        color = 'green';
    } else if (qrCodeData) {
        status = '⚠️ Disconnected. <a href="/qr">Scan QR Code Now</a>';
        color = 'red';
    }
    res.send(`<html><head><meta http-equiv="refresh" content="10"></head><body style="font-family: sans-serif; text-align: center; padding-top: 50px;"><h1>🤖 Bot Status</h1><h2 style="color: ${color};">${status}</h2><p>Uptime: ${process.uptime().toFixed(0)} seconds</p><small>Auto-refreshes every 10s</small></body></html>`);
});
app.get('/qr', async (req, res) => {
    if (!qrCodeData) return res.send('<h2 style="color:orange;">⏳ Generating QR... Check back in 10s.</h2>');
    try {
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;"><h1>Scan QR</h1><img src="${url}" style="border:5px solid #000; width:300px;"></div>`);
    } catch { res.send('Error generating QR.'); }
});
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- HELPER FUNCTIONS ---
async function updateUserProfile(userId, name, topic, scoreToAdd = 0) {
    try {
        let user = await User.findOne({ userId });
        if (!user) user = new User({ userId, name: name || 'Friend' });
        if (name) user.name = name;
        if (topic) user.lastTopic = topic;
        if (scoreToAdd > 0 && scoreToAdd > (user.highScore || 0)) user.highScore = scoreToAdd;
        await user.save();
        return user;
    } catch (e) { console.error("DB Error:", e); return { name: name || 'Friend', highScore: 0 }; }
}

const util = require('util');
const sleep = util.promisify(setTimeout);

async function callWithRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            if (e.message && e.message.includes("429")) {
                console.warn(`⚠️ Rate Limit (429). Rotating key & Retrying (${i + 1}/${retries})...`);
                rotateKey();
                await sleep(2000 * (i + 1)); // Backoff
            } else {
                throw e; // Non-429 error, throw immediately
            }
        }
    }
    throw new Error("Max retries exceeded for AI Request.");
}

async function getEmbedding(text) {
    try {
        return await callWithRetry(async () => {
            const model = getModel(); // Get fresh model (maybe updated key)
            const result = await model.embedContent(text);
            return result.embedding.values;
        });
    } catch (e) {
        console.error("Embedding Error (Final):", e.message);
        return null; // Fail gracefully
    }
}

async function upsertToPinecone(text, id) {
    const vector = await getEmbedding(text);
    if (!vector) return;
    try {
        const index = pc.index(indexName);
        await index.upsert([{ id: id, values: vector, metadata: { text: text.substring(0, 2000) } }]);
    } catch (e) { console.error("Pinecone Upsert Error:", e); }
}

async function queryPinecone(queryText) {
    try {
        const index = pc.index(indexName);
        const vector = await getEmbedding(queryText);
        if (!vector) return null; // Embedding failed

        const queryResponse = await index.query({ vector: vector, topK: 3, includeMetadata: true });
        if (queryResponse.matches.length > 0) {
            return queryResponse.matches.filter(m => m.score > 0.5).map(m => m.metadata.text).join("\n\n");
        }
    } catch (e) { console.error("Pinecone Query Error:", e); }
    return null;
}

async function generateQuizFromPdfBuffer({ pdfBuffer, topic = 'General', qty = 10, difficulty = 'medium' }) {
    if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("PDF Buffer empty");
    const finalPrompt = `GENERATE QUIZ JSON. Topic: ${topic}. Difficulty: ${difficulty}. Qty: ${qty}. Source is the attached PDF. Extract questions from it. Output STRICT JSON: { "type": "quiz_batch", "topic": "${topic}", "quizzes": [ { "question": "...", "options":["A","B","C","D"], "correct_index": 0, "answer_explanation": "..." } ] }`;

    const model = getModel();
    const contentParts = [{ text: finalPrompt }, { inlineData: { data: pdfBuffer.toString('base64'), mimeType: 'application/pdf' } }];
    let result;
    try {
        result = await callWithRetry(async () => {
            const currentModel = getModel();
            return await currentModel.generateContent(contentParts);
        });
    } catch (e) { throw new Error("AI Overloaded (429) during Quiz Gen."); }

    // const result = await model.generateContent(contentParts); // Replaced
    const jsonMatch = result.response.text().match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const data = JSON.parse(jsonMatch[0]);
    let questions = data.quizzes || data.questions;
    return questions.map(q => {
        let options = q.options || ["True", "False"];
        let cIndex = -1;
        if (typeof q.correctAnswer === 'number') cIndex = q.correctAnswer;
        if (cIndex === -1 && typeof q.correctAnswer === 'string') cIndex = options.findIndex(opt => opt.trim() === q.correctAnswer.trim());
        if (cIndex === -1 && typeof q.correctAnswer === 'string' && q.correctAnswer.length === 1) cIndex = q.correctAnswer.toUpperCase().charCodeAt(0) - 65;
        if (cIndex === -1 && typeof q.correctAnswer === 'string') cIndex = options.findIndex(opt => opt.toLowerCase().includes(q.correctAnswer.toLowerCase()));
        if (cIndex < 0 || cIndex >= options.length) cIndex = 0;
        return { question: q.questionText || q.question, options: options, correct_index: cIndex, answer_explanation: q.explanation || q.answer_explanation };
    }).slice(0, qty);
}

// --- CORE HANDLERS ---
async function handleVote(vote) {
    try {
        const msgId = vote.parentMessage.id.id;
        if (!activePolls.has(msgId)) return;
        const { correctIndex, chatId, questionIndex, originalOptions } = activePolls.get(msgId); // Deep Memory
        if (!quizSessions.has(chatId)) return;
        const session = quizSessions.get(chatId);
        if (questionIndex !== session.index) return;

        const uniqueVoteKey = `${session.index}_${vote.voter}`;
        if (session.creditedVotes.has(uniqueVoteKey)) return;
        session.creditedVotes.add(uniqueVoteKey);
        if (!session.scores.has(vote.voter)) session.scores.set(vote.voter, 0);

        try {
            // Options Check
            const options = originalOptions || session.questions[session.index].options;
            const normalize = (str) => (str ? String(str).trim().toLowerCase() : "");
            const correctText = normalize(options[correctIndex]);

            const isCorrect = vote.selectedOptions.some(opt => {
                const voteText = normalize(opt.name);
                return voteText === correctText || (voteText.length > 2 && correctText.includes(voteText)) || (correctText.length > 2 && voteText.includes(correctText));
            });

            console.log(`🗳️ Vote: ${vote.voter} | Expect: ${correctText} | Correct: ${isCorrect}`);
            if (isCorrect) session.scores.set(vote.voter, session.scores.get(vote.voter) + 1);
        } catch (e) { console.error("Vote Logic Error:", e); }
    } catch (e) { console.error("Fatal Vote Error:", e); }
}

async function sendMockTestSummaryWithAnswers(chat, chatId) {
    const session = quizSessions.get(chatId);
    if (!session) return;
    let template = `📘 *DETAILED SOLUTIONS* 📘\n*Topic:* ${session.topic}\n──────────────────\n\n`;
    session.questions.forEach((q, idx) => {
        template += `*Q${idx + 1}.* ${q.question}\n✅ ${q.options[q.correct_index]}\n💡 ${q.answer_explanation || ""}\n──────────────────\n\n`;
    });
    if (template.length > 2000) {
        const chunks = template.match(/.{1,2000}/g);
        for (const chunk of chunks) await chat.sendMessage(chunk);
    } else await chat.sendMessage(template);
}

async function runQuizStep(chat, chatId) {
    const session = quizSessions.get(chatId);
    if (!session || !session.active) return;
    if (session.index >= session.questions.length) {
        let report = `🏆 *RANK LIST* 🏆\n*Subject:* ${session.topic}\n──────────────────\n`;
        const sorted = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) report += "No votes.";
        else sorted.forEach(([id, sc], i) => {
            report += `${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} @${id.split('@')[0]} : ${sc}/${session.questions.length}\n`;
        });
        report += `──────────────────`;
        await chat.sendMessage(report, { mentions: sorted.map(s => s[0]) });
        await sendMockTestSummaryWithAnswers(chat, chatId);
        quizSessions.delete(chatId);
        return;
    }

    const q = session.questions[session.index];
    const poll = new Poll(`Q${session.index + 1}: ${q.question}`, q.options, { allowMultipleAnswers: false });
    const sentMsg = await chat.sendMessage(poll);
    activePolls.set(sentMsg.id.id, { correctIndex: q.correct_index, chatId, questionIndex: session.index, originalOptions: q.options });

    setTimeout(() => {
        if (!quizSessions.has(chatId)) return;
        activePolls.delete(sentMsg.id.id);
        session.index++;
        setTimeout(() => runQuizStep(chat, chatId), 1000);
    }, session.timer * 1000);
}

async function handleImageGeneration(msg, prompt) {
    await msg.reply("🎨 Drawing...");
    try {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?nologo=true`;
        const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
        await msg.reply(media);
    } catch (e) { console.error(e); await msg.reply("❌ Image Gen Failed"); }
}

async function handleWebSearch(msg, query) {
    if (!process.env.TAVILY_API_KEY) return "No API Key";
    await msg.reply("🕵️‍♂️ Searching...");
    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, search_depth: "basic", include_answer: true, max_results: 3 })
        });
        const data = await response.json();
        let txt = data.answer ? `📝 ${data.answer}\n` : "";
        if (data.results) data.results.forEach(r => txt += `- [${r.title}](${r.url})\n`);
        await msg.reply(txt || "No results");
        return txt;
    } catch (e) { return null; }
}

async function handleMessage(msg) {
    try {
        console.log(`📩 RECEIVED: ${msg.body} from ${msg.from}`);
        const chat = await msg.getChat();

        // STRICT GATEKEEPER
        if (chat.isGroup) {
            const isTagged = msg.mentionedIds.includes(client.info.wid._serialized) || msg.body.includes("@");
            const hasSession = quizSessions.has(chat.id._serialized);
            if (!isTagged) {
                if (!hasSession) return;
                // If session, only accept votes (A-D, 1-4) or Stop
                if (!msg.body.trim().match(/^[a-dA-D1-4]$/) && !msg.body.toLowerCase().includes("stop")) return;
            }
        }

        let prompt = sanitizeHtml(msg.body.replace(/@\S+/g, "").trim());
        const user = await updateUserProfile(msg.from, msg._data.notifyName);

        // TEXT VOTING FALLBACK
        const letterMatch = prompt.match(/^\s*([A-Da-d1-4])\s*$/);
        if (letterMatch && quizSessions.has(chat.id._serialized)) {
            // Logic to handle text vote... simplified for brevity, assume poll is preferred
            // But we can implement if needed. 
        }

        if (prompt.toLowerCase() === "stop quiz") {
            if (quizSessions.has(chat.id._serialized)) { quizSessions.delete(chat.id._serialized); await msg.reply("🛑 Stopped."); }
            return;
        }

        // --- COMMANDS ---
        if (prompt.toLowerCase().startsWith("draw ")) {
            return await handleImageGeneration(msg, prompt.replace("draw ", ""));
        }
        if (prompt.toLowerCase().startsWith("search ")) {
            return await handleWebSearch(msg, prompt.replace("search ", ""));
        }

        // --- QUIZ & AI ---
        // TRAINING MODE
        if (msg.hasMedia && prompt.toLowerCase().includes("learn")) {
            await msg.reply("🧠 Memorizing...");
            try {
                const media = await msg.downloadMedia();
                let text = "";
                if (media.mimetype === 'application/pdf') {
                    // Vision or Extract
                    // For now use buffer if needed, but here we assume simple text
                    const data = await pdfParse(Buffer.from(media.data, 'base64'));
                    text = data.text;
                } else if (media.mimetype === 'text/plain') {
                    text = Buffer.from(media.data, 'base64').toString('utf-8');
                }
                if (text) {
                    await upsertToPinecone(text, "UserUpload_" + Date.now());
                    await msg.reply("✅ Memorized.");
                } else await msg.reply("❌ Invalid File.");
            } catch (e) { await msg.reply("❌ Error."); }
            return;
        }

        // QUIZ GENERATION
        if (msg.hasMedia && prompt.toLowerCase().includes("quiz")) {
            // PDF Logic
            const media = await msg.downloadMedia();
            if (media.mimetype === 'application/pdf') {
                await msg.reply("📄 Reasoning from PDF...");
                const pdfBuffer = Buffer.from(media.data, 'base64');

                let timer = 30;
                const timeMatch = prompt.match(/every (\d+)\s*(s|m)/);
                if (timeMatch) timer = parseInt(timeMatch[1]) * (timeMatch[2] == 'm' ? 60 : 1);

                const questions = await generateQuizFromPdfBuffer({ pdfBuffer, topic: "PDF Content", qty: 10 });
                quizSessions.set(chat.id._serialized, { questions, index: 0, timer, active: true, scores: new Map(), creditedVotes: new Set(), topic: "PDF" });
                runQuizStep(chat, chat.id._serialized);
                return;
            }
        }

        // INFINITE QUIZ / DAILY POLLS
        if (prompt.toLowerCase().includes("daily polls") || (prompt.toLowerCase().includes("quiz") && !msg.hasMedia)) {
            // Logic to start simple quiz
            // For brevity, using simple generator or tavily
            await msg.reply("🎲 Starting General Quiz...");
            // You'd call Generation Logic here.
            // Implemented simple:
            const questions = [
                { question: "What is the capital of India?", options: ["Mumbai", "Delhi", "Chennai", "Kolkata"], correct_index: 1, answer_explanation: "New Delhi is the capital." },
                { question: "2 + 2 = ?", options: ["3", "4", "5", "6"], correct_index: 1, answer_explanation: "Math." }
            ];
            quizSessions.set(chat.id._serialized, { questions, index: 0, timer: 30, active: true, scores: new Map(), creditedVotes: new Set(), topic: "General" });
            runQuizStep(chat, chat.id._serialized);
            return;
        }

        // CHAT / VOICE
        const isVoice = msg.type === 'ptt' || msg.type === 'audio' || prompt.includes("speak");

        // RAG + GEMINI
        const context = await queryPinecone(prompt);
        const model = getModel();
        const chatSession = model.startChat({
            history: [
                { role: "user", parts: [{ text: "SYSTEM: You are a strict exam mentor. Be concise. Logic > Fluff." }] },
                ...(chatHistory.get(chat.id._serialized) || [])
            ]
        });

        const finalPrompt = context ? `Context: ${context}\nUser: ${prompt}` : prompt;
        const result = await chatSession.sendMessage(finalPrompt);
        const responseText = result.response.text();

        updateHistory(chat.id._serialized, "user", prompt);
        updateHistory(chat.id._serialized, "model", responseText);

        if (isVoice) {
            try {
                const url = googleTTS.getAudioUrl(responseText, { lang: 'en', slow: false });
                const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
                await client.sendMessage(msg.from, media, { sendAudioAsVoice: true });
            } catch (e) { await msg.reply(responseText); }
        } else {
            await msg.reply(responseText);
        }

    } catch (e) {
        console.error("🔥 FATAL MSG ERROR:", e);
    }
}

// --- INITIALIZATION ---
async function startClient() {
    console.log('🔄 Init Client with RemoteAuth...');
    const store = new MongoStore({ mongoose: mongoose });

    let puppetConfig = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    };
    if (process.platform === 'win32') {
        puppetConfig.executablePath = `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`;
        puppetConfig.headless = false;
    } else {
        puppetConfig.executablePath = await chromium.executablePath();
    }

    client = new Client({
        authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 60000 }),
        puppeteer: puppetConfig
    });

    client.on('qr', (qr) => { qrCodeData = qr; qrcode.generate(qr, { small: true }); console.log("⚡ SCAN QR"); });
    client.on('ready', () => { console.log("✅ Ready"); qrCodeData = ""; });
    client.on('vote_update', handleVote);
    client.on('message', handleMessage);
    client.on('remote_session_saved', () => console.log('💾 Saved Session'));

    await client.initialize();
}

startClient();
