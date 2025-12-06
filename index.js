const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');
const fs = require('fs');
const sanitizeHtml = require('sanitize-html');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const pdfParse = require('pdf-parse');

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

// --- 5. EXAM MEMORY & LIMITS ---
const quizSessions = new Map();
const activePolls = new Map();
const rateLimit = new Map();

function checkRateLimit(chatId) {
    const now = Date.now();
    if (!rateLimit.has(chatId)) rateLimit.set(chatId, []);
    const timestamps = rateLimit.get(chatId).filter(t => now - t < 60000);
    if (timestamps.length >= 25) return false;
    timestamps.push(now);
    rateLimit.set(chatId, timestamps);
    return true;
}

// --- 6. THE BRAIN (MULTI-MODE) ---
const MODEL_NAME = "gemini-2.0-flash";
const SYSTEM_INSTRUCTION = `
You are **Siddhartha's AI Assistant**.

**MODE 1: QUIZ GENERATOR**
- If user asks for "Quiz", "Test", "MCQ" -> OUTPUT STRICT JSON ONLY.
- NO intro text. ONLY JSON.
- Format: { "type": "quiz_batch", "topic": "Subject", "quizzes": [{ "question": "...", "options": ["A","B","C","D"], "correct_index": 0, "answer_explanation": "..." }] }

**MODE 2: IMAGE/TEXT SOLVER**
- If user sends an Image or asks a general question -> Answer normally in text.
- Be concise, professional, and helpful.
`;

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

// --- 7. PDF HELPER FUNCTIONS ---
async function extractTextFromPDF(buffer) {
    try {
        const parsed = await pdfParse(buffer);
        return parsed.text || "";
    } catch (e) {
        console.error("PDF parse error:", e);
        return "";
    }
}

async function generateQuizFromPdfBuffer({ pdfBuffer, topic='General Knowledge', qty=10, difficulty='medium' }) {
    const text = await extractTextFromPDF(pdfBuffer);
    if (!text || text.trim().length < 50) throw new Error("PDF empty or unreadable.");

    const finalPrompt = `
    Generate a quiz from this PDF text.
    TOPIC: "${topic}" (Focus strictly on this).
    DIFFICULTY: ${difficulty}
    QUANTITY: Exactly ${qty} questions.
    PDF TEXT (Partial): """${text.slice(0, 30000)}"""
    
    OUTPUT: STRICT JSON ONLY. Format:
    {
      "type": "quiz_batch",
      "topic": "${topic}",
      "quizzes": [
        { "question": "...", "options":["A","B","C","D"], "correct_index": 0, "answer_explanation": "..." }
      ]
    }
    `;

    const model = getModel();
    const result = await model.generateContent(finalPrompt);
    const responseText = result.response.text();
    
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    
    const data = JSON.parse(jsonMatch[0]);
    let questions = data.quizzes || data.questions;
    
    // Normalize
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

// --- 8. WHATSAPP CLIENT (SPARTICUZ) ---
let client;

async function startClient() {
    console.log('🔄 Initializing Client with Sparticuz...');
    try {
        chromium.setHeadlessMode = true;
        chromium.setGraphicsMode = false;

        client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
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

        client.on('vote_update', handleVote);
        client.on('message', handleMessage);

        await client.initialize();
    } catch (err) {
        console.error('❌ Fatal Client Error:', err.message);
    }
}

// --- 9. VOTE HANDLER (ROBUST) ---
async function handleVote(vote) {
    if (activePolls.has(vote.parentMessage.id.id)) {
        const { correctIndex, chatId, questionIndex } = activePolls.get(vote.parentMessage.id.id);
        if (quizSessions.has(chatId)) {
            const session = quizSessions.get(chatId);
            const voterId = vote.voter;
            
            // Allow scores for current question ONLY
            if (questionIndex !== session.index) return; // Ignore votes on old questions

            if (!session.scores.has(voterId)) session.scores.set(voterId, 0);
            
            const uniqueVoteKey = `${session.index}_${voterId}`;
            if (session.creditedVotes.has(uniqueVoteKey)) return; // Already counted

            const correctOptionText = session.questions[session.index].options[correctIndex];
            // Check trim match
            const isCorrect = vote.selectedOptions.some(opt => opt.name.trim() === correctOptionText.trim());
            
            if (isCorrect) {
                session.scores.set(voterId, session.scores.get(voterId) + 1);
                session.creditedVotes.add(uniqueVoteKey);
            }
        }
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

    // Send in chunks if too long
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
        // REPORT CARD
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
        
        // SEND SUMMARY
        await sendMockTestSummaryWithAnswers(chat, chatId);
        
        await chat.sendMessage("🏁 Quiz Ended.");
        quizSessions.delete(chatId);
        return;
    }

    // SEND POLL
    const q = session.questions[session.index];
    const poll = new Poll(`Q${session.index+1}: ${q.question}`, q.options, { allowMultipleAnswers: false });
    const sentMsg = await chat.sendMessage(poll);
    
    // Track poll with QuestionIndex
    activePolls.set(sentMsg.id.id, { correctIndex: q.correct_index, chatId, questionIndex: session.index });

    // TIMER
    setTimeout(async () => {
        if (!quizSessions.has(chatId)) return;
        const correctOpt = q.options[q.correct_index];
        const explanation = q.answer_explanation || "";
        
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
    
    // Check if user replied A, B, C, D or 1, 2, 3, 4
    const letterMatch = prompt.match(/^\s*([A-Da-d])\s*$/);
    const numMatch = prompt.match(/^\s*([1-4])\s*$/);
    
    let chosenIndex = -1;
    if (letterMatch) chosenIndex = letterMatch[1].toUpperCase().charCodeAt(0) - 65; // A=0
    else if (numMatch) chosenIndex = parseInt(numMatch[1]) - 1;
    
    if (chosenIndex === -1) return false; // Not a vote

    const voterId = msg.from;
    const uniqueVoteKey = `${session.index}_${voterId}`;
    if (session.creditedVotes.has(uniqueVoteKey)) return true; // Already voted

    const q = session.questions[session.index];
    if (chosenIndex === q.correct_index) {
        if (!session.scores.has(voterId)) session.scores.set(voterId, 0);
        session.scores.set(voterId, session.scores.get(voterId) + 1);
        session.creditedVotes.add(uniqueVoteKey);
        await msg.react('✅'); // Feedback
    } else {
        await msg.react('❌'); // Feedback
        session.creditedVotes.add(uniqueVoteKey); // Mark attempted
    }
    return true;
}

// --- 13. MAIN HANDLER ---
async function handleMessage(msg) {
    const chat = await msg.getChat();
    if (chat.isGroup && !msg.body.includes("@")) return;
    
    let prompt = sanitizeHtml(msg.body.replace(/@\S+/g, "").trim());
    if (!checkRateLimit(chat.id._serialized)) return;

    // 1. Check Text Fallback Vote first
    if (await handleTextAsVoteFallback(msg, chat, prompt)) return;

    // 2. Stop Command
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

    // 3. Parse Params
    const timeMatch = prompt.match(/every (\d+)\s*(s|sec|min|m)/i);
    if (timeMatch) timerSeconds = parseInt(timeMatch[1]) * (timeMatch[2].startsWith('m') ? 60 : 1);
    
    const countMatch = prompt.match(/(\d+)\s*(q|ques|question)/i);
    if (countMatch) questionLimit = Math.min(parseInt(countMatch[1]), 25);

    if (prompt.toLowerCase().includes("easy")) difficulty = "easy";
    if (prompt.toLowerCase().includes("hard")) difficulty = "hard";
    
    const topicMatch = prompt.match(/quiz\s+on\s+(.+?)(?:\s|$)/i);
    if (topicMatch) topic = topicMatch[1].trim();

    // 4. Media Handling (PDF & Image)
    let pdfBuffer = null;
    
    // Check direct media or quoted media
    let messageWithMedia = msg.hasMedia ? msg : (msg.hasQuotedMsg ? await msg.getQuotedMessage() : null);
    
    if (messageWithMedia && messageWithMedia.hasMedia) {
        const media = await messageWithMedia.downloadMedia();
        if (media) {
            if (media.mimetype === 'application/pdf') {
                pdfBuffer = Buffer.from(media.data, 'base64');
                mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } }; // Also Keep for AI
            } else if (media.mimetype.startsWith('image/')) {
                mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } };
            }
        }
    }

    if (!prompt && !mediaPart) return;
    if (prompt.toLowerCase().match(/^(who are you|your name)/)) return msg.reply("I am Siddhartha's AI Assistant.");

    // 5. DECISION: PDF Mock Test vs Normal Quiz vs General AI
    
    // A. PDF MOCK TEST TRIGGER
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

    // B. NORMAL QUIZ TRIGGER
    const isQuiz = prompt.toLowerCase().includes("quiz") || prompt.toLowerCase().includes("test") || prompt.toLowerCase().includes("mcq");
    
    try {
        const model = getModel();
        let responseText = "";
        
        if (isQuiz) {
            const finalPrompt = `[GENERATE QUIZ BATCH JSON - Count: ${questionLimit}, Topic: "${topic}", Difficulty: ${difficulty}] ${prompt}`;
            const content = mediaPart ? [finalPrompt, mediaPart] : [finalPrompt];
            const result = await model.generateContent(content);
            responseText = result.response.text();
        } else {
            // C. GENERAL AI (IMAGE/TEXT SOLVER)
            // Just answer the user's question about the image or text
            let history = chatHistory.get(chat.id._serialized) || [];
            if (mediaPart) {
                // If Image/PDF is sent with a question "Solve this", answer it.
                const content = [prompt || "Analyze this", mediaPart];
                const result = await model.generateContent(content);
                responseText = result.response.text();
            } else {
                const chatSession = model.startChat({ history });
                const result = await chatSession.sendMessage(prompt);
                responseText = result.response.text();
                updateHistory(chat.id._serialized, "user", prompt);
                updateHistory(chat.id._serialized, "model", responseText);
            }
        }

        // Check for JSON (Quiz)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        
        if (isQuiz && jsonMatch) {
            // It's a quiz response
            try {
                const data = JSON.parse(jsonMatch[0]);
                let questions = data.quizzes || data.questions;
                if (questions) {
                    // Normalization
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
            // It's a normal answer
            await msg.reply(responseText);
        }
    } catch (err) {
        if (err.message.includes("429")) rotateKey();
    }
}

// START
startClient();
