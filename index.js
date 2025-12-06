const { Client, LocalAuth, Poll, MessageMedia } = require('whatsapp-web.js');
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
const googleTTS = require('google-tts-api'); // 🗣️ Voice Mode

// 🌲 PINECONE CONNECTION (VECTOR DB)
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY || 'pcsk_4YGs7G_FB4bw1RbEejhHeiwEeL8wrU2vS1vQfFS2TcdhxJjsrehCHMyeFtHw4cHJkWPZvc' });
const indexName = 'whatsapp-bot';

// 🔌 MONGODB CONNECTION
// NOTE: Ideally, use process.env.MONGODB_URI. We add the fallback for immediate usage as requested.
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://amurag12344321_db_user:78mbO8WPw69AeTpt@siddharthawhatsappbot.wfbdgjf.mongodb.net/?appName=SiddharthaWhatsappBot";

mongoose.connect(MONGODB_URI)
    .then(() => console.log('🍃 MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 📝 USER SCHEMA
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    name: String,
    highScore: { type: Number, default: 0 },
    lastTopic: { type: String, default: 'General' },
    joined: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- 1. WEB SERVER ---
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = "";

app.get('/', (req, res) => res.send('Bot is Alive! <a href="/qr">Scan QR Code</a>'));
app.get('/qr', async (req, res) => {
    if (!qrCodeData) return res.send('<h2 style="color:orange;">⏳ Generating QR... Check back in 10s or Check Logs.</h2>');
    try {
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;"><h1>📱 Scan This QR</h1><img src="${url}" style="border:5px solid #000; width:300px; border-radius:10px;"></div>`);
    } catch { res.send('Error generating QR image.'); }
});
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- 2. PERSISTENCE ---
// (Moved to Memory Section below to avoid duplicates)

// --- 3. KEY ROTATION ---
const rawKeys = [process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY].filter(k => k);
let currentKeyIndex = 0;
let genAI = rawKeys.length ? new GoogleGenerativeAI(rawKeys[currentKeyIndex]) : null;

function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
    genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
}

// --- 4. MEMORY & USER DATABASE (MONGODB) ---
const HISTORY_FILE = 'chatHistory.json';
// const USER_DB_FILE = 'user_db.json'; // Deprecated
let chatHistory = new Map();
// let userDatabase = new Map(); // Deprecated

function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try { chatHistory = new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE)))); } catch (e) { }
    }
}
function saveHistory() {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(chatHistory))); } catch (e) { }
}
// function loadUserDatabase() ... Removed for MongoDB
// function saveUserDatabase() ... Removed for MongoDB

async function updateUserProfile(userId, name, topic, scoreToAdd = 0) {
    try {
        let user = await User.findOne({ userId });
        if (!user) {
            user = new User({ userId, name: name || 'Friend' });
        }

        if (name) user.name = name;
        if (topic) user.lastTopic = topic;

        if (scoreToAdd > 0) {
            const currentScore = user.highScore || 0;
            if (scoreToAdd > currentScore) user.highScore = scoreToAdd;
        }

        await user.save();
        return user;
    } catch (e) {
        console.error("MongoDB Error:", e);
        return { name: name || 'Friend', highScore: 0, lastTopic: topic || 'General' }; // Fallback
    }
}

loadHistory();
// loadUserDatabase(); // No longer needed

function updateHistory(chatId, role, text) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ role, parts: [{ text }] });
    if (history.length > 15) history.shift(); // Increased context depth
    saveHistory();
}

// --- 5. EXAM MEMORY ---
const quizSessions = new Map();
const activePolls = new Map();
const rateLimit = new Map();

function checkRateLimit(chatId) {
    const now = Date.now();
    if (!rateLimit.has(chatId)) rateLimit.set(chatId, []);
    const timestamps = rateLimit.get(chatId).filter(t => now - t < 60000);
    if (timestamps.length >= 20) return false;
    timestamps.push(now);
    rateLimit.set(chatId, timestamps);
    return true;
}

// --- 6. THE BRAIN (GEMINI + RAG) ---
const MODEL_NAME = "gemini-2.0-flash";
const SYSTEM_INSTRUCTION = `You are Siddhartha's AI. QUIZ PROTOCOL: If user asks for Quiz/MCQ -> OUTPUT STRICT JSON: {"type": "quiz_batch", "topic": "Subject", "quizzes": [{"question": "...", "options": ["..."], "correct_index": 0, "answer_explanation": "..."}]}`;

function getModel() {
    return genAI.getGenerativeModel({
        model: MODEL_NAME,
        systemInstruction: SYSTEM_INSTRUCTION,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
        ]
    });
}

// 🧠 RAG HELPERS
async function getEmbedding(text) {
    const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const result = await model.embedContent(text);
    return result.embedding.values;
}

async function upsertToPinecone(text, filename) {
    // 1. Chunk Text (Simple 500 char chunks)
    const chunks = text.match(/.{1,500}/g) || [];
    const index = pc.index(indexName);
    const vectors = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await getEmbedding(chunk);
        vectors.push({
            id: `${filename}_${i}`,
            values: embedding,
            metadata: { text: chunk, filename }
        });
    }

    // Batch Upsert
    await index.upsert(vectors);
    console.log(`🌲 Upserted ${vectors.length} chunks to Pinecone.`);
}

async function queryPinecone(queryText) {
    try {
        const index = pc.index(indexName);
        const embedding = await getEmbedding(queryText);
        const queryResponse = await index.query({
            vector: embedding,
            topK: 3,
            includeMetadata: true
        });

        if (queryResponse.matches.length > 0) {
            return queryResponse.matches
                .filter(m => m.score > 0.5) // Relevance Threshold
                .map(m => m.metadata.text).join("\n\n");
        }
    } catch (e) {
        console.error("Pinecone Query Error:", e);
    }
    return null;
}

// --- 7. PDF HELPER (GEMINI VISION OCR) ---
async function generateQuizFromPdfBuffer({ pdfBuffer, topic = 'General', qty = 10, difficulty = 'medium' }) {
    if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("PDF Buffer empty");

    // We no longer use pdf-parse. We send the PDF directly to Gemini (Multimodal).

    const finalPrompt = `GENERATE QUIZ JSON. Topic: ${topic}. Difficulty: ${difficulty}. Qty: ${qty}. Source is the attached PDF. Extract questions from it. Output STRICT JSON: { "type": "quiz_batch", "topic": "${topic}", "quizzes": [ { "question": "...", "options":["A","B","C","D"], "correct_index": 0, "answer_explanation": "..." } ] }`;

    const model = getModel();
    const contentParts = [
        { text: finalPrompt },
        { inlineData: { data: pdfBuffer.toString('base64'), mimeType: 'application/pdf' } }
    ];

    const result = await model.generateContent(contentParts);
    const responseText = result.response.text();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in AI response");

    const data = JSON.parse(jsonMatch[0]);
    let questions = data.quizzes || data.questions;
    return questions.map(q => {
        let cIndex = typeof q.correctAnswer === 'string' ? q.options.indexOf(q.correctAnswer) : q.correctAnswer;
        if (cIndex === -1) cIndex = 0;
        return {
            question: q.questionText || q.question,
            options: q.options,
            correct_index: cIndex,
            answer_explanation: q.explanation || q.answer_explanation
        };
    }).slice(0, qty);
}

// --- 8. WHATSAPP CLIENT (FORCE NEW QR) ---
let client;

async function startClient() {
    console.log('🔄 Initializing Client...');
    qrCodeData = "";

    // Heartbeat to keep active logging (helpful for Render logs)
    setInterval(() => {
        console.log('💓 Heartbeat - Bot is alive');
    }, 5 * 60 * 1000); // Every 5 minutes

    // 🛑 SESSION DELETION REMOVED FOR PERSISTENCE 🛑
    // The line below is commented out to allow the bot to remember the session.
    // try {
    //     console.log('🧹 Clearing old session to ensure fresh QR...');
    //     fs.rmSync('.wwebjs_auth', { recursive: true, force: true });
    //     console.log('✅ Session cleared.');
    // } catch (e) {
    //     console.log('ℹ️ No session to clear.');
    // }

    try {
        let puppetConfig;
        if (process.platform === 'win32') {
            const bravePath = `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`;
            console.log(`🖥️ Windows detected. Using Local Brave: ${bravePath}`);
            puppetConfig = {
                executablePath: bravePath,
                headless: false,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            };
        } else {
            console.log('🐧 Linux/Render detected. Using @sparticuz/chromium');
            chromium.setHeadlessMode = true;
            chromium.setGraphicsMode = false;
            puppetConfig = {
                args: [
                    ...chromium.args,
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-software-rasterizer'
                ],
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                ignoreHTTPSErrors: true,
                timeout: 120000
            };
        }

        client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: puppetConfig
        });

        client.on('qr', (qr) => {
            console.log('⚡ NEW QR RECEIVED - Scan this!');
            qrCodeData = qr;
            qrcode.generate(qr, { small: true });
        });

        client.on('ready', () => {
            console.log('✅ Siddhartha\'s AI is Online!');
            qrCodeData = "";
        });

        client.on('disconnected', (reason) => {
            console.log('❌ Disconnected:', reason);
            // process.exit(1); 
        });

        client.on('vote_update', handleVote);
        client.on('message', handleMessage);

        await client.initialize();
    } catch (err) {
        console.error('❌ Fatal Error:', err.message);
        process.exit(1);
    }
}

// --- 9. VOTE HANDLER ---
async function handleVote(vote) {
    try {
        if (!activePolls.has(vote.parentMessage.id.id)) return;
        const { correctIndex, chatId, questionIndex } = activePolls.get(vote.parentMessage.id.id);

        if (!quizSessions.has(chatId)) return;
        const session = quizSessions.get(chatId);

        // Safety: Ensure session is still on the same question
        if (questionIndex !== session.index) return;

        const voterId = vote.voter;
        const uniqueVoteKey = `${session.index}_${voterId}`;

        // 🛡️ Prevent Duplicate Processing
        if (session.creditedVotes.has(uniqueVoteKey)) return;
        session.creditedVotes.add(uniqueVoteKey); // Mark as voted immediately

        if (!session.scores.has(voterId)) session.scores.set(voterId, 0);

        // 🛡️ Crash-Proof Answer Check
        try {
            const currentQ = session.questions[session.index];
            if (!currentQ || !currentQ.options) return;

            // Safe trim helper
            const safeTrim = (str) => (typeof str === 'string' ? str.trim() : "");

            const correctOptionText = safeTrim(currentQ.options[correctIndex]);
            const isCorrect = vote.selectedOptions.some(opt => safeTrim(opt.name) === correctOptionText);

            if (isCorrect) {
                session.scores.set(voterId, session.scores.get(voterId) + 1);
            }
        } catch (innerErr) {
            console.error("⚠️ Error calculating score (vote counted as attempt):", innerErr.message);
        }
    } catch (err) {
        console.error("❌ Fatal Vote Error (Safely Ignored):", err.message);
    }
}

// --- 10. SUMMARY GENERATOR ---
async function sendMockTestSummaryWithAnswers(chat, chatId) {
    const session = quizSessions.get(chatId);
    if (!session) return;

    let template = `📘 *MockTest Summary — ${session.topic || 'General'}*\n\n`;
    session.questions.forEach((q, idx) => {
        const correct = q.options[q.correct_index];
        const expl = q.answer_explanation || "—";
        template += `*Q${idx + 1}.* ${q.question}\n✅ *Ans:* ${correct}\n💡 *Exp:* ${expl}\n\n`;
    });

    if (template.length > 2000) {
        const chunks = template.match(/.{1,2000}/g);
        for (const chunk of chunks) await chat.sendMessage(chunk);
    } else {
        await chat.sendMessage(template);
    }
}

// --- 11. QUIZ LOOP ---
async function runQuizStep(chat, chatId) {
    const session = quizSessions.get(chatId);
    if (!session || !session.active) return;

    if (session.index >= session.questions.length) {
        let report = "📊 **FINAL REPORT CARD** 📊\n\n";
        const sortedScores = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
        if (sortedScores.length === 0) report += "No votes recorded.";
        else {
            let rank = 1;
            for (const [contactId, score] of sortedScores) {
                let name = contactId.replace('@c.us', '');
                try {
                    const contact = await client.getContactById(contactId);
                    if (contact.pushname) name = contact.pushname;
                } catch (e) { }
                let medal = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : (rank === 3 ? '🥉' : '🔹'));
                report += `${medal} *${name}*: ${score} pts\n`;
                rank++;
            }
        }
        await chat.sendMessage(report);
        await sendMockTestSummaryWithAnswers(chat, chatId);
        await chat.sendMessage("🏁 Quiz Ended.");
        quizSessions.delete(chatId);
        return;
    }

    const q = session.questions[session.index];
    const poll = new Poll(`Q${session.index + 1}: ${q.question}`, q.options, { allowMultipleAnswers: false });
    const sentMsg = await chat.sendMessage(poll);
    activePolls.set(sentMsg.id.id, { correctIndex: q.correct_index, chatId, questionIndex: session.index });

    setTimeout(async () => {
        if (!quizSessions.has(chatId)) return;

        // 🛡️ Safety: Fix "undefined" answer bug
        let correctOpt = "Check Summary";
        if (q.options && typeof q.correct_index === 'number' && q.options[q.correct_index]) {
            correctOpt = q.options[q.correct_index];
        }

        await sentMsg.reply(`⏰ **Time's Up!**\n✅ **Answer:** ${correctOpt}`);
        activePolls.delete(sentMsg.id.id);
        session.index++;
        setTimeout(() => { runQuizStep(chat, chatId); }, 3000);
    }, session.timer * 1000);
}

// --- 12. TEXT FALLBACK VOTING ---
async function handleTextAsVoteFallback(msg, chat, prompt) {
    if (!quizSessions.has(chat.id._serialized)) return false;
    const session = quizSessions.get(chat.id._serialized);

    const letterMatch = prompt.match(/^\s*([A-Da-d])\s*$/);
    const numMatch = prompt.match(/^\s*([1-4])\s*$/);

    let chosenIndex = -1;
    if (letterMatch) chosenIndex = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
    else if (numMatch) chosenIndex = parseInt(numMatch[1]) - 1;

    if (chosenIndex === -1) return false;

    const voterId = msg.from;
    const uniqueVoteKey = `${session.index}_${voterId}`;
    if (session.creditedVotes.has(uniqueVoteKey)) return true;

    const q = session.questions[session.index];
    if (chosenIndex === q.correct_index) {
        if (!session.scores.has(voterId)) session.scores.set(voterId, 0);
        session.scores.set(voterId, session.scores.get(voterId) + 1);
        session.creditedVotes.add(uniqueVoteKey);
        await msg.react('✅');
    } else {
        await msg.react('❌');
        session.creditedVotes.add(uniqueVoteKey);
    }
    return true;
}

// --- 13. LEVEL 4: THE ARTIST & RESEARCHER ---
async function handleImageGeneration(msg, prompt) {
    await msg.reply("🎨 Drawing...");
    try {
        // Pollinations.ai (Free, No Key)
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
        const media = await MessageMedia.fromUrl(imageUrl);
        await msg.reply(media);
    } catch (e) {
        console.error("Image Gen Error:", e);
        await msg.reply("❌ Failed to generate image.");
    }
}

async function handleWebSearch(msg, query) {
    if (!process.env.TAVILY_API_KEY) {
        return await msg.reply("⚠️ Web Search requires TAVILY_API_KEY.");
    }
    await msg.reply("🕵️‍♂️ Searching the web...");
    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query: query,
                search_depth: "basic",
                include_answer: true,
                max_results: 3
            })
        });
        const data = await response.json();

        let resultText = "";
        if (data.answer) resultText += `📝 **Answer:** ${data.answer}\n\n`;
        if (data.results && data.results.length > 0) {
            resultText += "🔗 **Sources:**\n";
            data.results.forEach(r => resultText += `- [${r.title}](${r.url})\n`);
        }

        await msg.reply(resultText || "❌ No results found.");
        return resultText; // Return for Gemini context if needed
    } catch (e) {
        console.error("Search Error:", e);
        await msg.reply("❌ Search failed.");
    }
    return null;
}

// --- 13. MAIN HANDLER ---
async function handleMessage(msg) {
    const chat = await msg.getChat();

    // � STRICT GROUP LOGIC
    if (chat.isGroup) {
        // 1. Is it a direct mention? (Library regex or @ symbol)
        const myId = client.info.wid._serialized;
        const myNumber = client.info.wid.user;
        const isTagged = msg.mentionedIds.includes(myId) || msg.body.includes("@") || msg.body.includes(myNumber);

        // 2. Is there an ACTIVE Quiz?
        const hasActiveSession = quizSessions.has(chat.id._serialized);

        // CASE: NOT TAGGED
        if (!isTagged) {
            // If NO quiz -> IGNORE COMPLETEY.
            if (!hasActiveSession) return;

            // If QUIZ IS RUNNING -> Only accept simple votes (A,B,C,D,1,2,3,4) or "Stop"
            const isVote = msg.body.trim().match(/^[a-dA-D1-4]$/);
            const isStop = msg.body.toLowerCase().includes("stop");

            if (!isVote && !isStop) return; // Ignore random chatter during quiz
        }
    }

    // ✂️ COMMAND EXTRACTION
    // Remove all mentions from the text so AI sees "Hello" instead of "@12345 Hello"
    let prompt = sanitizeHtml(msg.body.replace(/@\S+/g, "").trim());

    // 🧠 HUMAN CONTEXT (REPLIES)
    // If user replies to a message, the AI should know what they are replying to.
    if (msg.hasQuotedMsg) {
        try {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg && quotedMsg.body) {
                // Prepend context so AI understands "it", "that", "him", etc.
                prompt = `[Context - Replying to: "${sanitizeHtml(quotedMsg.body)}"]\n${prompt}`;
            }
        } catch (e) { /* Ignore fetch error */ }
    }

    // Rate Limit Check
    if (!checkRateLimit(chat.id._serialized)) return;

    if (await handleTextAsVoteFallback(msg, chat, prompt)) return;

    if (prompt.toLowerCase().includes("stop quiz")) {
        if (quizSessions.has(chat.id._serialized)) {
            quizSessions.delete(chat.id._serialized);
            await msg.reply("🛑 Quiz stopped.");
        }
        return;
    }

    let mediaPart = null;
    let timerSeconds = 30;
    let questionLimit = 10;
    let difficulty = "medium";
    let topic = "General Knowledge";

    const timeMatch = prompt.match(/every (\d+)\s*(s|sec|min|m)/i);
    if (timeMatch) timerSeconds = parseInt(timeMatch[1]) * (timeMatch[2].startsWith('m') ? 60 : 1);

    const countMatch = prompt.match(/(\d+)\s*(q|ques|question)/i);
    if (countMatch) questionLimit = Math.min(parseInt(countMatch[1]), 25);

    if (prompt.toLowerCase().includes("easy")) difficulty = "easy";
    if (prompt.toLowerCase().includes("hard")) difficulty = "hard";
    const topicMatch = prompt.match(/quiz\s+on\s+(.+?)(?:\s|$)/i);
    if (topicMatch) topic = topicMatch[1].trim();

    let pdfBuffer = null;
    let messageWithMedia = msg.hasMedia ? msg : (msg.hasQuotedMsg ? await msg.getQuotedMessage() : null);

    if (messageWithMedia && messageWithMedia.hasMedia) {
        const media = await messageWithMedia.downloadMedia();
        if (media) {
            if (media.mimetype === 'application/pdf') {
                pdfBuffer = Buffer.from(media.data, 'base64');
                mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } };
            } else if (media.mimetype.startsWith('image/')) {
                mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } };
            } else if (media.mimetype.startsWith('audio/')) {
                // 🎤 LEVEL 5: VOICE MODE (LISTENING)
                // We treat audio as "inlineData" for Gemini to hear.
                mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } };
                // If there is no text prompt with the audio, we add a default one.
                if (!prompt) prompt = "Listen to this audio and reply to the user concisely.";
            }
        }
    }

    if (!prompt && !mediaPart) return;
    if (prompt.toLowerCase().match(/^(who are you|your name)/)) return msg.reply("I am Siddhartha's AI Assistant.");

    // --- LEVEL 4 TRIGGER: THE ARTIST ---
    if (prompt.match(/^(draw|generate image|create image|picture of)\b/i)) {
        const imagePrompt = prompt.replace(/^(draw|generate image|create image|picture of)/i, "").trim();
        if (imagePrompt) {
            await handleImageGeneration(msg, imagePrompt);
            return;
        }
    }

    // --- LEVEL 4 TRIGGER: THE RESEARCHER ---
    let webContext = ""; // For Gemini to use later
    if (prompt.match(/^(search|google|news about|what happened in)\b/i)) {
        const searchQuery = prompt.replace(/^(search|google|news about|what happened in)/i, "").trim();
        if (searchQuery) {
            webContext = await handleWebSearch(msg, searchQuery);
            if (!webContext) return; // Search failed or no results
            // Note: We don't return here. We let the code fall through to Gemini so it can summarize the search results.
        }
    }

    // PDF MOCK TEST / LEARNING LOGIC
    if (pdfBuffer) {
        // A. LEARNING MODE (Ingest to RAG)
        if (prompt.toLowerCase().includes("learn") || prompt.toLowerCase().includes("save") || prompt.toLowerCase().includes("read")) {
            await msg.reply(`🧠 Reading & Memorizing Document...`);
            try {
                const data = await pdfParse(pdfBuffer);
                await upsertToPinecone(data.text, "UserUpload_" + Date.now());
                await msg.reply("✅ Memorized! I can now recall this information.");
            } catch (e) {
                console.error(e);
                await msg.reply("❌ Failed to memorize.");
            }
            return;
        }
    }

    // B. EXISTING MOCK TEST LOGIC
    if (pdfBuffer && (prompt.toLowerCase().includes("mocktest") || prompt.toLowerCase().includes("quiz"))) {
        await msg.reply(`🔎 Generating Mock Test from PDF: ${topic}...`);
        try {
            const questions = await generateQuizFromPdfBuffer({ pdfBuffer, topic, qty: questionLimit, difficulty });
            await msg.reply(`🎰 **Mock Test Ready!**\nQs: ${questions.length} | Timer: ${timerSeconds}s`);

            quizSessions.set(chat.id._serialized, {
                questions, index: 0, timer: timerSeconds, active: true, scores: new Map(), creditedVotes: new Set(), topic
            });
            setTimeout(() => { runQuizStep(chat, chat.id._serialized); }, 3000);
        } catch (e) {
            console.error(e);
            await msg.reply("⚠️ Error reading PDF. Ensure it has readable text.");
        }
        return;
    }

    // GENERAL AI / IMAGE / QUIZ
    const isQuiz = prompt.toLowerCase().includes("quiz") || prompt.toLowerCase().includes("test") || prompt.toLowerCase().includes("mcq");

    // 🧠 LOAD USER PROFILE
    let userProfile = null;
    try {
        const contact = await msg.getContact();
        const name = contact.pushname || "Friend";
        userProfile = updateUserProfile(msg.from, name, isQuiz ? topic : "Chat");
    } catch (e) { }

    try {
        const model = getModel();
        let responseText = "";

        if (isQuiz) {
            const finalPrompt = `[GENERATE QUIZ BATCH JSON - Count: ${questionLimit}, Topic: "${topic}", Difficulty: ${difficulty}] ${prompt}`;
            const content = mediaPart ? [finalPrompt, mediaPart] : [finalPrompt];
            const result = await model.generateContent(content);
            responseText = result.response.text();
        } else {
            let history = chatHistory.get(chat.id._serialized) || [];

            // 🧠 INJECT PROFILE + RAG + WEB CONTEXT
            let systemContext = "";

            // 0. Web Search Results (Highest Priority)
            if (webContext) {
                systemContext += `[REAL-TIME WEB SEARCH RESULTS: ${webContext}]\n(Use these results to answer the user's question accurately.)\n`;
            }

            // 1. RAG Retrieve
            const ragContext = await queryPinecone(prompt);
            if (ragContext) {
                systemContext += `[FACTS FROM MEMORY: ${ragContext}]\n`;
            }

            // 2. User Profile
            if (userProfile) {
                systemContext += `[User Info: Name="${userProfile.name}", LastTopic="${userProfile.lastTopic}", HighScore=${userProfile.highScore}]\n`;
            }

            if (mediaPart) {
                const content = [systemContext + (prompt || "Analyze this"), mediaPart];
                const result = await model.generateContent(content);
                responseText = result.response.text();
            } else {
                const chatSession = model.startChat({ history });
                const result = await chatSession.sendMessage(systemContext + prompt);
                responseText = result.response.text();
                updateHistory(chat.id._serialized, "user", prompt);
                updateHistory(chat.id._serialized, "model", responseText);
            }
        }

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);

        if (isQuiz && jsonMatch) {
            try {
                const data = JSON.parse(jsonMatch[0]);
                let questions = data.quizzes || data.questions;
                if (questions) {
                    questions = questions.map(q => ({
                        question: q.questionText || q.question,
                        options: q.options,
                        correct_index: typeof q.correctAnswer === 'string' ? q.options.indexOf(q.correctAnswer) : q.correctAnswer,
                        answer_explanation: q.explanation || q.answer_explanation
                    })).slice(0, questionLimit);

                    await msg.reply(`🎰 **Quiz Loaded: ${data.topic || topic}**\nQs: ${questions.length} | Timer: ${timerSeconds}s`);
                    quizSessions.set(chat.id._serialized, {
                        questions, index: 0, timer: timerSeconds, active: true, scores: new Map(), creditedVotes: new Set(), topic: data.topic
                    });
                    setTimeout(() => { runQuizStep(chat, chat.id._serialized); }, 3000);
                }
            } catch (e) { await msg.reply("⚠️ AI formatting error."); }
        } else if (!isQuiz) {
            // 🗣️ LEVEL 5: VOICE MODE (SPEAKING)
            // If the user sent an audio message (PTT/Audio), we reply with Audio.
            const isVoiceMessage = msg.type === 'ptt' || msg.type === 'audio';

            if (isVoiceMessage) {
                try {
                    // Convert AI text to Audio (MP3)
                    const ttsUrl = googleTTS.getAudioUrl(responseText, { lang: 'en', slow: false });
                    const audioMedia = await MessageMedia.fromUrl(ttsUrl, { unsafeMime: true });
                    await client.sendMessage(msg.from, audioMedia, { sendAudioAsVoice: true });
                    // We also send text for clarity (Optional, but good UX)
                    // await msg.reply(responseText); 
                } catch (e) {
                    console.error("TTS Error:", e);
                    await msg.reply(responseText); // Fallback to text
                }
            } else {
                await msg.reply(responseText);
            }
        }
    } catch (err) {
        if (err.message.includes("429")) rotateKey();
    }
}

// START
startClient();
