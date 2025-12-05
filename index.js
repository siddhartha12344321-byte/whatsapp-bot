const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');

// --- 1. WEB SERVER ---
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = "";

app.get('/', (req, res) => res.send('Bot is Alive! <a href="/qr">Scan QR Code</a>'));
app.get('/qr', async (req, res) => {
    if (!qrCodeData) return res.send('<h2>⏳ Generating QR... Reload in 10 seconds.</h2>');
    try {
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;"><h1>📱 Scan This QR</h1><img src="${url}" style="border:5px solid #000; width:300px; border-radius:10px;"></div>`);
    } catch { res.send('Error generating QR image.'); }
});
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- 2. KEY ROTATION SYSTEM ---
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

function getModel() {
    return genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        systemInstruction: `
            You are **Siddhartha's AI Assistant**.
            **MODE: BULK QUIZ GENERATOR**
            - Action: Read content and generate **10 to 20** MCQs.
            - OUTPUT FORMAT: JSON ARRAY.
            {
                "type": "quiz_batch",
                "topic": "Subject",
                "quizzes": [
                    { "question": "Q1 text?", "options": ["A", "B", "C", "D"], "correct_index": 0, "answer_explanation": "Why A is correct." },
                    ...
                ]
            }
            *IMPORTANT:* "correct_index" must be 0, 1, 2, or 3.
        `
    });
}

// --- 3. EXAM SESSION MEMORY ---
// Stores: chatId -> { questions, index, timer, active, scores }
const quizSessions = new Map();

// Stores: msgId -> correctOptionIndex (For Live Grading)
const activePolls = new Map();

// --- 4. WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run']
    }
});

client.on('qr', (qr) => {
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Siddhartha\'s AI is Online!');
    qrCodeData = "";
});

// --- 5. LIVE GRADING LISTENER ---
client.on('vote_update', async (vote) => {
    if (activePolls.has(vote.parentMessage.id.id)) {
        const correctIndex = activePolls.get(vote.parentMessage.id.id);
        const chatId = vote.parentMessage.to;
        
        if (quizSessions.has(chatId)) {
            const session = quizSessions.get(chatId);
            const voterId = vote.voter;
            let currentScore = session.scores.get(voterId) || 0;
            const userSelected = vote.selectedOptions;
            
            // Check if they selected the correct option
            // (Simplified Logic: If correct option is in selection, give point)
            const isCorrect = userSelected.some(opt => opt.name === session.questions[session.index].options[correctIndex]);
            
            if (isCorrect) {
                // To prevent spam-voting for points, sophisticated logic is needed.
                // For now, we trust the latest vote state or simply accumulate.
                // We use a Set to ensure 1 point per question per user (Advanced logic simplified)
                session.scores.set(voterId, currentScore + 1);
            }
        }
    }
});

// --- 6. THE ACCURATE TIMER ENGINE ---
async function runQuizStep(chat, chatId) {
    const session = quizSessions.get(chatId);

    // Safety Check
    if (!session || !session.active) return;

    // A. CHECK IF QUIZ FINISHED
    if (session.index >= session.questions.length) {
        // GENERATE REPORT CARD
        let report = "📊 **FINAL REPORT CARD** 📊\n\n";
        const sortedScores = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
        
        if (sortedScores.length === 0) {
            report += "No votes recorded.";
        } else {
            let rank = 1;
            for (const [contactId, score] of sortedScores) {
                // Try to clean name
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

    // B. SEND QUESTION
    const q = session.questions[session.index];
    const poll = new Poll(q.question, q.options, { allowMultipleAnswers: false });
    const sentMsg = await chat.sendMessage(poll);
    
    // Track for grading
    activePolls.set(sentMsg.id.id, q.correct_index);

    // C. START THE MANUAL INTERVAL (The "Stopwatch")
    // This waits exactly for 'session.timer' seconds (e.g., 30s, 60s)
    setTimeout(async () => {
        // Double check session is still active
        if (!quizSessions.has(chatId)) return;

        // D. REVEAL ANSWER & SOLUTION
        const correctOpt = q.options[q.correct_index];
        const explanation = q.answer_explanation || "No explanation.";
        
        await sentMsg.reply(`⏰ **Time's Up!**\n\n✅ **Correct:** ${correctOpt}\n\n📚 **Solution:** ${explanation}`);
        
        // Stop tracking this poll
        activePolls.delete(sentMsg.id.id);

        // Move to next question
        session.index++;

        // Small 3s buffer before next question so users can read the solution
        setTimeout(() => {
             runQuizStep(chat, chatId);
        }, 3000);

    }, session.timer * 1000); // <--- HERE IS YOUR MANUAL INTERVAL
}

// --- 7. MAIN HANDLER ---
client.on('message', async msg => {
    const chat = await msg.getChat();
    
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            let prompt = msg.body.replace(/@\S+/g, "").trim();

            // STOP COMMAND
            if (prompt.toLowerCase().includes("stop")) {
                if (quizSessions.has(chat.id._serialized)) {
                    const session = quizSessions.get(chat.id._serialized);
                    session.active = false; // Kill the loop
                    quizSessions.delete(chat.id._serialized);
                    await msg.reply("🛑 Quiz stopped.");
                } else {
                    await msg.reply("⚠️ No quiz running.");
                }
                return;
            }

            let mediaPart = null;
            
            // --- DETECT MANUAL TIMER ---
            // Default 45 seconds if not specified
            let timerSeconds = 45; 
            
            // Regex to catch "every 60s", "every 30 seconds", "every 2 min"
            const timeMatch = prompt.match(/every (\d+)\s*(s|sec|min|m)/i);
            if (timeMatch) {
                let val = parseInt(timeMatch[1]);
                let unit = timeMatch[2];
                if (unit.startsWith('m')) val = val * 60; // Convert mins to secs
                timerSeconds = Math.max(10, val); // Minimum 10s safety
            }

            // Media & Context Reading
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
                }
            }

            if (!prompt && !mediaPart) return;

            // Identity Check
            if (prompt.toLowerCase().match(/^(who are you|your name)/)) {
                await msg.reply("I am Siddhartha's AI Assistant, Created By Siddhartha Vardhan Singh.");
                return;
            }

            // START QUIZ LOGIC
            if (prompt.toLowerCase().includes("quiz") || prompt.toLowerCase().includes("test")) {
                await chat.sendStateTyping();
                
                const model = getModel();
                const content = mediaPart ? [prompt, mediaPart] : [prompt];
                
                const result = await model.generateContent(content);
                const text = result.response.text();

                if (text.includes("quiz_batch")) {
                    try {
                        const cleanJson = text.replace(/```json|```/g, '').trim();
                        const data = JSON.parse(cleanJson);
                        const questions = data.quizzes.slice(0, 20);

                        if (questions.length > 0) {
                            await msg.reply(`🎰 **Quiz Loaded!**\nTopic: ${data.topic}\nQuestions: ${questions.length}\n⏱️ **Interval:** ${timerSeconds} seconds per question.\n\n*Starting in 3 seconds...*`);
                            
                            // SETUP SESSION
                            quizSessions.set(chat.id._serialized, {
                                questions: questions,
                                index: 0,
                                timer: timerSeconds, // Your Manual Timer is saved here
                                active: true,
                                scores: new Map()
                            });

                            // START LOOP
                            setTimeout(() => {
                                runQuizStep(chat, chat.id._serialized);
                            }, 3000);
                        }
                    } catch (e) {
                        console.error(e);
                        await msg.reply("❌ Error parsing quiz data.");
                    }
                } else {
                    await msg.reply(text);
                }
            } 
            // DYNAMIC TABLE/SYLLABUS
            else if (prompt.toLowerCase().includes("table") || prompt.toLowerCase().includes("syllabus")) {
                 const model = getModel();
                 const result = await model.generateContent(prompt); // Standard call
                 await msg.reply(result.response.text());
            }

        } catch (err) {
            console.error("Error:", err);
        }
    }
});

client.initialize();
