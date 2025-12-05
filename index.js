const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');

// --- 1. WEB SERVER (Keep-Alive) ---
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = "";

app.get('/', (req, res) => res.send('Bot is Alive! <a href="/qr">Scan QR Code</a>'));
app.get('/qr', async (req, res) => {
    if (!qrCodeData) return res.send('<h2>Bot is successfully connected! No QR needed.</h2>');
    try {
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;"><h1>📱 Scan This QR</h1><img src="${url}" style="border:5px solid #000; width:300px; border-radius:10px;"></div>`);
    } catch { res.send('Error generating QR image.'); }
});
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- 2. KEY ROTATION ---
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

// --- 3. MEMORY SYSTEM ---
const chatHistory = new Map();
function updateHistory(chatId, role, text) {
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    history.push({ role: role, parts: [{ text: text }] });
    if (history.length > 10) history.shift(); 
}

// --- 4. EXAM SESSION MEMORY ---
const quizSessions = new Map();
const activePolls = new Map();

// --- 5. THE BRAIN ---
const MODEL_NAME = "gemini-2.0-flash";
const SYSTEM_INSTRUCTION = `
You are **Siddhartha's AI Assistant**.
**BEHAVIOR:**
- **CONTEXT AWARE:** Remember previous messages.
- **QUIZ GENERATOR:** If asked for a quiz, output JSON batch format.
- **UPSC TUTOR:** Be concise, accurate, and relevant.
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

// --- 6. WHATSAPP CLIENT (STABILIZED) ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        // 🔥 AGGRESSIVE ARGUMENTS TO PREVENT CRASHES ON FREE TIER 🔥
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Critical for low RAM
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('⚡ NEW QR RECEIVED');
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Siddhartha\'s AI is Online!');
    qrCodeData = ""; // Clear QR so web page knows we are connected
});

// 🔥 SELF-HEALING CODE: If disconnected, kill app so Render restarts it
client.on('disconnected', (reason) => {
    console.log('❌ Client was logged out', reason);
    process.exit(1); // Force Restart
});

client.on('auth_failure', () => {
    console.error('❌ Authentication failure');
    process.exit(1); // Force Restart
});

// --- 7. LIVE GRADING ---
client.on('vote_update', async (vote) => {
    if (activePolls.has(vote.parentMessage.id.id)) {
        const correctIndex = activePolls.get(vote.parentMessage.id.id);
        const chatId = vote.parentMessage.to;
        if (quizSessions.has(chatId)) {
            const session = quizSessions.get(chatId);
            const voterId = vote.voter;
            let currentScore = session.scores.get(voterId) || 0;
            const isCorrect = vote.selectedOptions.some(opt => opt.name === session.questions[session.index].options[correctIndex]);
            if (isCorrect) session.scores.set(voterId, currentScore + 1);
        }
    }
});

// --- 8. QUIZ LOGIC ---
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
                    if (contact.name || contact.pushname) name = contact.name || contact.pushname;
                } catch(e) {}
                let medal = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : (rank === 3 ? '🥉' : '🔹'));
                report += `${medal} *${name}*: ${score} pts\n`;
                rank++;
            }
        }
        await chat.sendMessage(report);
        await chat.sendMessage("🏁 Quiz Completed.");
        quizSessions.delete(chatId);
        return;
    }

    const q = session.questions[session.index];
    const poll = new Poll(q.question, q.options, { allowMultipleAnswers: false });
    const sentMsg = await chat.sendMessage(poll);
    activePolls.set(sentMsg.id.id, q.correct_index);

    setTimeout(async () => {
        if (!quizSessions.has(chatId)) return;
        const correctOpt = q.options[q.correct_index];
        const explanation = q.answer_explanation || "No explanation.";
        await sentMsg.reply(`⏰ **Time's Up!**\n\n✅ **Correct:** ${correctOpt}\n\n📚 **Solution:** ${explanation}`);
        activePolls.delete(sentMsg.id.id);
        session.index++;
        setTimeout(() => { runQuizStep(chat, chatId); }, 3000);
    }, session.timer * 1000);
}

// --- 9. MAIN HANDLER ---
client.on('message', async msg => {
    const chat = await msg.getChat();
    
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            let prompt = msg.body.replace(/@\S+/g, "").trim();

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
            
            const timeMatch = prompt.match(/every (\d+)\s*(s|sec|min|m)/i);
            if (timeMatch) {
                let val = parseInt(timeMatch[1]);
                if (timeMatch[2].startsWith('m')) val *= 60;
                timerSeconds = Math.max(10, val);
            }

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

            if (prompt.toLowerCase().match(/^(who are you|your name)/)) {
                await msg.reply("I am Siddhartha's AI Assistant, Created By Siddhartha Vardhan Singh.");
                return;
            }

            let success = false;
            let attempts = 0;
            let history = chatHistory.get(chat.id._serialized) || [];

            while (!success && attempts < 3) {
                attempts++;
                try {
                    const model = getModel();
                    let responseText = "";
                    
                    if (prompt.toLowerCase().includes("quiz") || prompt.toLowerCase().includes("test") || mediaPart) {
                        const finalPrompt = (prompt.toLowerCase().includes("quiz")) 
                            ? `[GENERATE QUIZ BATCH JSON - Max 20 Questions] ${prompt}` 
                            : prompt;
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

                    if (responseText.trim().startsWith('{') && responseText.includes('"type": "quiz_batch"')) {
                        const cleanJson = responseText.replace(/```json|```/g, '').trim();
                        const data = JSON.parse(cleanJson);
                        const questions = data.quizzes.slice(0, 20);

                        if (questions.length > 0) {
                            await msg.reply(`🎰 **Quiz Loaded!**\nTopic: ${data.topic}\nQuestions: ${questions.length}\n⏱️ ${timerSeconds}s per question.`);
                            quizSessions.set(chat.id._serialized, {
                                questions: questions, index: 0, timer: timerSeconds, active: true, scores: new Map()
                            });
                            setTimeout(() => { runQuizStep(chat, chat.id._serialized); }, 3000);
                        }
                    } else {
                        await msg.reply(responseText);
                    }
                    
                    success = true;
                } catch (error) {
                    console.error(`Attempt ${attempts} Failed:`, error.message);
                    if (error.message.includes("429")) rotateKey();
                    else break; 
                }
            }
        } catch (err) {
            console.error("Error:", err);
        }
    }
});

// --- ANTI-CRASH HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('⚠️ Caught Exception:', err);
});

client.initialize();
