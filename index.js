const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');
const fs = require('fs'); // For free file-based persistence
const sanitizeHtml = require('sanitize-html'); // Free package for input sanitization

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

// --- 2. FREE PERSISTENCE (JSON FILE) ---
const HISTORY_FILE = 'chatHistory.json';
let chatHistory = new Map();
function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            chatHistory = new Map(Object.entries(data));
        } catch (e) { console.log('Failed to load history:', e.message); }
    }
}
function saveHistory() {
    try {
        const data = Object.fromEntries(chatHistory);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.log('Failed to save history:', e.message); }
}
loadHistory(); // Load on startup

// --- 3. KEY ROTATION ---
const rawKeys = [
    process.env.GEMINI_API_KEY_2, 
    process.env.GEMINI_API_KEY
].filter(k => k);

if (rawKeys.length === 0) {
    console.error("❌ NO API KEYS FOUND!");
    process.exit(1);
}

let currentKeyIndex = 0;
let genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);

function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
    console.log(`🔄 Switching to API Key #${currentKeyIndex + 1}`);
    genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
}

// --- 4. MEMORY SYSTEM (WITH PERSISTENCE) ---
function updateHistory(chatId, role, text) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ role: role, parts: [{ text: text }] });
    if (history.length > 10) history.shift(); 
    saveHistory(); // Persist after update
}

// --- 5. EXAM SESSION MEMORY ---
const quizSessions = new Map();
// FIX: activePolls now stores { correctIndex, chatId } for accurate vote tracking
const activePolls = new Map();

// --- 6. FREE ANALYTICS & RATE LIMITING ---
const usageStats = { messages: 0, quizzes: 0, errors: 0 };
const rateLimit = new Map(); // In-memory rate limiter (free)

function checkRateLimit(chatId) {
    const now = Date.now();
    const window = 60000; // 1 minute
    const maxRequests = 10; // Max 10 messages per minute per chat
    if (!rateLimit.has(chatId)) rateLimit.set(chatId, []);
    const timestamps = rateLimit.get(chatId).filter(t => now - t < window);
    if (timestamps.length >= maxRequests) return false;
    timestamps.push(now);
    rateLimit.set(chatId, timestamps);
    return true;
}

// --- 7. THE BRAIN ---
const MODEL_NAME = "gemini-2.0-flash";
const SYSTEM_INSTRUCTION = `
You are **Siddhartha's AI Assistant**.

**BEHAVIOR:**
- **QUIZ GENERATOR:** Read content and generate MCQs.
- **FORMAT:** Output strictly **JSON**.
- **TOPIC:** UPSC/General Knowledge.
- **MULTI-LANGUAGE:** Respond in the user's detected language.

**REQUIRED JSON FORMAT:**
{
    "type": "quiz_batch",
    "topic": "Subject Name",
    "quizzes": [
        { "question": "Q1 Text?", "options": ["A", "B", "C", "D"], "correct_index": 0, "answer_explanation": "Why?" },
        ...
    ]
}
*Note: correct_index must be a number (0-3).*
`;

function getModel() {
    return genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        systemInstruction: SYSTEM_INSTRUCTION,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM }, // Tighter for safety
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM }
        ]
    });
}

// --- 8. WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote']
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
    console.log('❌ Client logged out', reason);
    process.exit(1); 
});

// --- 9. LIVE GRADING LISTENER (FIXED FOR VOTE COUNTING) ---
client.on('vote_update', async (vote) => {
    try {
        if (activePolls.has(vote.parentMessage.id.id)) {
            const pollData = activePolls.get(vote.parentMessage.id.id); // Now { correctIndex, chatId }
            const { correctIndex, chatId } = pollData;
            
            if (quizSessions.has(chatId)) {
                const session = quizSessions.get(chatId);
                const voterId = vote.voter;
                if (!session.scores.has(voterId)) session.scores.set(voterId, 0); // Ensure voter is initialized
                let currentScore = session.scores.get(voterId);
                const isCorrect = vote.selectedOptions.some(opt => opt.name === session.questions[session.index].options[correctIndex]);
                
                if (isCorrect) {
                    session.scores.set(voterId, currentScore + 1);
                }
            }
        }
    } catch (e) {
        console.error('Vote update error:', e);
        usageStats.errors++;
    }
});

// --- 10. THE EXAM CONTROLLER LOOP ---
async function runQuizStep(chat, chatId) {
    try {
        const session = quizSessions.get(chatId);
        if (!session || !session.active) return;

        // A. CHECK IF FINISHED
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
                        if (contact.name || contact.pushname) name = contact.name || contact.pushname;
                    } catch(e) {}
                    let medal = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : (rank === 3 ? '🥉' : '🔹'));
                    report += `${medal} *${name}*: ${score} pts\n`;
                    rank++;
                }
            }
            await chat.sendMessage(report);
            await chat.sendMessage("🏁 Quiz Completed. Export results by copying above!");
            quizSessions.delete(chatId);
            return;
        }

        // B. SEND QUESTION WITH PROGRESS
        const q = session.questions[session.index];
        const progress = `Question ${session.index + 1}/${session.questions.length}`;
        const poll = new Poll(`${progress}\n${q.question}`, q.options, { allowMultipleAnswers: false });
        const sentMsg = await chat.sendMessage(poll);
        // FIX: Store both correctIndex and chatId in activePolls
        activePolls.set(sentMsg.id.id, { correctIndex: q.correct_index, chatId });

        // C. WAIT (MANUAL TIMER)
        setTimeout(async () => {
            try {
                if (!quizSessions.has(chatId)) return;

                // D. REVEAL ANSWER
                const correctOpt = q.options[q.correct_index];
                const explanation = q.answer_explanation || "No explanation.";
                await sentMsg.reply(`⏰ **Time's Up!**\n\n✅ **Correct:** ${correctOpt}\n\n📚 **Solution:** ${explanation}`);
                activePolls.delete(sentMsg.id.id);
                session.index++;

                // Buffer before next Q
                setTimeout(() => { runQuizStep(chat, chatId); }, 3000);
            } catch (e) {
                console.error('Quiz step error:', e);
                usageStats.errors++;
            }
        }, session.timer * 1000); 
    } catch (e) {
        console.error('Run quiz step error:', e);
        usageStats.errors++;
    }
}

// --- 11. MAIN MESSAGE HANDLER ---
client.on('message', async msg => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup && !msg.body.includes("@")) return; // Allow private if mentioned

        let prompt = sanitizeHtml(msg.body.replace(/@\S+/g, "").trim(), { allowedTags: [], allowedAttributes: {} }); // Sanitize input

        if (!checkRateLimit(chat.id._serialized)) {
            await msg.reply("⏳ Too many messages! Slow down.");
            return;
        }
        usageStats.messages++;

        // NEW COMMANDS
        if (prompt.toLowerCase().includes("help")) {
            await msg.reply("🤖 **Commands:**\n- 'quiz [topic] [difficulty]' (e.g., 'easy quiz on history')\n- 'stop quiz'\n- 'status' (bot info)\n- 'reset history'\n- 'who are you'\nMention me with @ in groups!");
            return;
        }
        if (prompt.toLowerCase().includes("status")) {
            await msg.reply(`📈 **Bot Status:**\nMessages: ${usageStats.messages}\nQuizzes: ${usageStats.quizzes}\nErrors: ${usageStats.errors}\nUptime: ${process.uptime()}s`);
            return;
        }
        if (prompt.toLowerCase().includes("reset history")) {
            chatHistory.delete(chat.id._serialized);
            saveHistory();
            await msg.reply("🗑️ Chat history reset.");
            return;
        }

        // STOP COMMAND
        if (prompt.toLowerCase().includes("stop quiz")) {
            if (quizSessions.has(chat.id._serialized)) {
                quizSessions.get(chat.id._serialized).active = false;
                quizSessions.delete(chat.id._serialized);
                await msg.reply("🛑 Quiz stopped.");
            }
            return;
        }

        let mediaPart = null;
        let timerSeconds = 45; 
        let questionLimit = 10;
        let difficulty = "medium"; // New: Default difficulty
        let topic = "General Knowledge"; // FIX: Default topic, parsed from prompt

        // PARSE TIMER
        const timeMatch = prompt.match(/every (\d+)\s*(s|sec|min|m)/i);
        if (timeMatch) {
            let val = parseInt(timeMatch[1]);
            if (timeMatch[2].startsWith('m')) val *= 60;
            timerSeconds = Math.max(10, val);
        }

        // PARSE QUESTION COUNT
        const countMatch = prompt.match(/(\d+)\s*(q|ques|question|mcq)/i);
        if (countMatch) {
            let val = parseInt(countMatch[1]);
            questionLimit = Math.min(val, 25);
            questionLimit = Math.max(1, questionLimit);
        }

        // NEW: PARSE DIFFICULTY
        if (prompt.toLowerCase().includes("easy")) difficulty = "easy";
        else if (prompt.toLowerCase().includes("hard")) difficulty = "hard";

        // FIX: PARSE TOPIC (e.g., "quiz on polity" -> "polity")
        const topicMatch = prompt.match(/quiz\s+on\s+(.+?)(?:\s|$)/i);
        if (topicMatch) topic = topicMatch[1].trim();

        // Media Handling (Expanded)
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media.mimetype === 'application/pdf' || media.mimetype.startsWith('image/')) {
                mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } };
            }
        } else if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.hasMedia) {
                const media = await quotedMsg.downloadMedia();
                mediaPart = { inlineData: { data: media.data, mimeType: media.mimetype } };
            } else if (quotedMsg.body) {
                prompt = `[CONTEXT: "${quotedMsg.body}"]\n\nUser Request: ${prompt}`;
            }
        }

        if (!prompt && !mediaPart) return;

        // Identity Check
        if (prompt.toLowerCase().match(/^(who are you|your name)/)) {
            await msg.reply("I am Siddhartha's AI Assistant, Created By Siddhartha Vardhan Singh. Fully free and advanced!");
            return;
        }

        // AI GENERATION WITH FEEDBACK
        await msg.reply("⏳ Generating response..."); // Feedback
        let success = false;
        let attempts = 0;
        let history = chatHistory.get(chat.id._serialized) || [];

        while (!success && attempts < 3) {
            attempts++;
            try {
                const model = getModel();
                let responseText = "";
                
                if (prompt.toLowerCase().includes("quiz") || mediaPart) {
                    usageStats.quizzes++;
                    // FIX: Strict topic enforcement in prompt
                    const finalPrompt = `[GENERATE QUIZ BATCH JSON - Difficulty: ${difficulty}, Strictly generate questions on "${topic}" based on the provided content. Do not include unrelated topics. Create exactly ${questionLimit} Questions] ${prompt}`;
                    const content = mediaPart ? [finalPrompt, mediaPart] : [finalPrompt];
                    const result = await model.generateContent(content);
                    responseText = result.response.text();
                } else {
                    const chatSession = model.startChat({ history: history });
                    const result = await chatSession.sendMessage(prompt);
                    responseText = result.response.text();
                    updateHistory(chat.id._serialized, "user", prompt);
                    updateHistory(chat.id._serialized, "model", responseText);
                }

                // SMART JSON PARSER
                const cleanedResponse = responseText.replace(/
