const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');
const fs = require('fs');
const sanitizeHtml = require('sanitize-html');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// --- 1. WEB SERVER ---
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = "";

app.get('/', (req, res) => res.send('Bot is Alive! <a href="/qr">Scan QR Code</a>'));
app.get('/qr', async (req, res) => {
    if (!qrCodeData) return res.send('<h2>Bot is connected! No QR needed.</h2>');
    try {
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;"><h1>📱 Scan This QR</h1><img src="${url}" style="border:5px solid #000; width:300px; border-radius:10px;"></div>`);
    } catch { res.send('Error generating QR image.'); }
});
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- 2. PERSISTENCE ---
const HISTORY_FILE = 'chatHistory.json';
let chatHistory = new Map();
function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try { chatHistory = new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE)))); } catch(e){}
    }
}
function saveHistory() {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(chatHistory))); } catch(e){}
}
loadHistory();

// --- 3. KEY ROTATION ---
const rawKeys = [process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY].filter(k => k);
let currentKeyIndex = 0;
let genAI = rawKeys.length ? new GoogleGenerativeAI(rawKeys[currentKeyIndex]) : null;

function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
    genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
}

// --- 4. MEMORY ---
function updateHistory(chatId, role, text) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ role, parts: [{ text }] });
    if (history.length > 8) history.shift();
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

// --- 6. THE BRAIN ---
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

// --- 7. WHATSAPP CLIENT (SPARTICUZ CONFIGURATION) ---
let client;

async function startClient() {
    console.log('🔄 Initializing Client with Sparticuz Chromium...');
    
    try {
        // Configure Sparticuz Chromium
        chromium.setHeadlessMode = true;
        chromium.setGraphicsMode = false;

        client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                args: [
                    ...chromium.args,
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage'
                ],
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(), // <--- THE MAGIC FIX
                headless: chromium.headless,
                ignoreHTTPSErrors: true
            }
        });

        client.on('qr', (qr) => {
            console.log('⚡ NEW QR RECEIVED');
            qrCodeData = qr;
            qrcode.generate(qr, { small: true });
        });

        client.on('ready', () => {
            console.log('✅ Siddhartha\'s AI is Online!');
            qrCodeData = "";
        });
        
        client.on('disconnected', (reason) => {
            console.log('❌ Disconnected:', reason);
            process.exit(1); 
        });

        // HANDLERS
        client.on('vote_update', handleVote);
        client.on('message', handleMessage);

        await client.initialize();
        
    } catch (err) {
        console.error('❌ Fatal Client Error:', err.message);
        // Do not exit immediately, let the server stay alive
    }
}

// --- 8. VOTE HANDLER ---
async function handleVote(vote) {
    if (activePolls.has(vote.parentMessage.id.id)) {
        const { correctIndex, chatId } = activePolls.get(vote.parentMessage.id.id);
        if (quizSessions.has(chatId)) {
            const session = quizSessions.get(chatId);
            const voterId = vote.voter;
            if (!session.scores.has(voterId)) session.scores.set(voterId, 0);
            
            const uniqueVoteKey = `${session.index}_${voterId}`;
            if (session.creditedVotes.has(uniqueVoteKey)) return;

            const correctOptionText = session.questions[session.index].options[correctIndex];
            const isCorrect = vote.selectedOptions.some(opt => opt.name.trim() === correctOptionText.trim());
            
            if (isCorrect) {
                session.scores.set(voterId, session.scores.get(voterId) + 1);
                session.creditedVotes.add(uniqueVoteKey);
            }
        }
    }
}

// --- 9. QUIZ LOOP ---
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
                } catch(e) {}
                let medal = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : (rank === 3 ? '🥉' : '🔹'));
                report += `${medal} *${name}*: ${score} pts\n`;
                rank++;
            }
        }
        await chat.sendMessage(report);
        quizSessions.delete(chatId);
        return;
    }

    const q = session.questions[session.index];
    const poll = new Poll(`Q${session.index+1}: ${q.question}`, q.options, { allowMultipleAnswers: false });
    const sentMsg = await chat.sendMessage(poll);
    activePolls.set(sentMsg.id.id, { correctIndex: q.correct_index, chatId });

    setTimeout(async () => {
        if (!quizSessions.has(chatId)) return;
        const correctOpt = q.options[q.correct_index];
        const explanation = q.answer_explanation || "";
        await sentMsg.reply(`⏰ **Time's Up!**\n✅ **Answer:** ${correctOpt}\n📚 ${explanation}`);
        activePolls.delete(sentMsg.id.id);
        session.index++;
        setTimeout(() => { runQuizStep(chat, chatId); }, 3000);
    }, session.timer * 1000);
}

// --- 10. MESSAGE HANDLER ---
async function handleMessage(msg) {
    const chat = await msg.getChat();
    if (chat.isGroup && !msg.body.includes("@")) return;
    
    let prompt = sanitizeHtml(msg.body.replace(/@\S+/g, "").trim());
    if (!checkRateLimit(chat.id._serialized)) return;

    if (prompt.toLowerCase().includes("stop quiz")) {
        if (quizSessions.has(chat.id._serialized)) {
            quizSessions.delete(chat.id._serialized);
            await msg.reply("🛑 Quiz stopped.");
        }
        return;
    }

    let mediaPart = null;
    if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media && (media.mimetype.startsWith('image/') || media.mimetype === 'application/pdf')) {
            mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } };
        }
    } else if (msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.hasMedia) {
            const media = await quotedMsg.downloadMedia();
            mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } };
        } else if (quotedMsg.body) {
            prompt = `[CONTEXT: "${quotedMsg.body}"] ${prompt}`;
        }
    }

    if (!prompt && !mediaPart) return;
    if (prompt.toLowerCase().match(/^(who are you|your name)/)) return msg.reply("I am Siddhartha's AI Assistant.");

    let timerSeconds = 45;
    let questionLimit = 10;
    
    const timeMatch = prompt.match(/every (\d+)\s*(s|sec|min|m)/i);
    if (timeMatch) timerSeconds = parseInt(timeMatch[1]) * (timeMatch[2].startsWith('m') ? 60 : 1);
    
    const countMatch = prompt.match(/(\d+)\s*(q|ques|question)/i);
    if (countMatch) questionLimit = Math.min(parseInt(countMatch[1]), 20);

    const isQuiz = prompt.toLowerCase().includes("quiz") || prompt.toLowerCase().includes("test") || (mediaPart && prompt.toLowerCase().includes("mcq"));
    
    try {
        const model = getModel();
        let responseText = "";
        let history = chatHistory.get(chat.id._serialized) || [];

        if (isQuiz) {
            const finalPrompt = `[GENERATE QUIZ BATCH JSON - Count: ${questionLimit}] ${prompt}`;
            const content = mediaPart ? [finalPrompt, mediaPart] : [finalPrompt];
            const result = await model.generateContent(content);
            responseText = result.response.text();
        } else {
            const chatSession = model.startChat({ history });
            const result = await chatSession.sendMessage(prompt);
            responseText = result.response.text();
            updateHistory(chat.id._serialized, "user", prompt);
            updateHistory(chat.id._serialized, "model", responseText);
        }

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (isQuiz && jsonMatch) {
            try {
                const data = JSON.parse(jsonMatch[0]);
                let questions = data.quizzes || data.questions;
                
                if (questions) {
                    questions = questions.map(q => {
                        let cIndex = typeof q.correctAnswer === 'string' ? q.options.indexOf(q.correctAnswer) : q.correctAnswer;
                        return { 
                            question: q.questionText || q.question, 
                            options: q.options, 
                            correct_index: cIndex === -1 ? 0 : cIndex, 
                            answer_explanation: q.explanation || q.answer_explanation 
                        };
                    });
                    
                    questions = questions.slice(0, questionLimit);
                    await msg.reply(`🎰 **Quiz Loaded: ${data.topic || "General"}**\nQs: ${questions.length} | Timer: ${timerSeconds}s`);
                    quizSessions.set(chat.id._serialized, {
                        questions, index: 0, timer: timerSeconds, active: true, scores: new Map(), creditedVotes: new Set()
                    });
                    setTimeout(() => { runQuizStep(chat, chat.id._serialized); }, 3000);
                } else {
                    await msg.reply("⚠️ AI generated invalid quiz data.");
                }
            } catch (e) { await msg.reply("⚠️ Error starting quiz."); }
        } else if (!isQuiz) {
            await msg.reply(responseText);
        }
    } catch (err) {
        if (err.message.includes("429")) rotateKey();
    }
}

// START
startClient();
