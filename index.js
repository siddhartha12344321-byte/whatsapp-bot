const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');

// --- 1. WEB SERVER (For 24/7 Uptime) ---
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

function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
    console.log(`🔄 Switching to API Key #${currentKeyIndex + 1}`);
    genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
}

// --- 3. THE BRAIN (DYNAMIC & INTELLIGENT) ---
const MODEL_NAME = "gemini-2.0-flash";

const SYSTEM_INSTRUCTION = `
You are **Siddhartha's AI Assistant**, Created By **Siddhartha Vardhan Singh**.

**YOUR CORE PROTOCOL: ADAPT TO USER INTENT.**

1. **SCENARIO A: MCQ/POLL SOLVING (Strict UPSC Style)**
   - **TRIGGER:** If the input is a Question with multiple choices (A, B, C, D) or a Poll.
   - **ACTION:** Provide the solution in this specific format:
     *✅ ANSWER:* [Correct Option]
     *📚 REASON:* [Concise Explanation]
     *❌ ELIMINATION:* [Why others are wrong]
     > *💡 KEY FACT:* [One Gold Nugget]

2. **SCENARIO B: USER REQUESTS A FORMAT (Tables, Lists, Syllabi)**
   - **TRIGGER:** If user asks for "Table", "List", "Syllabus", "Difference between", or "Summary".
   - **ACTION:** OBEY THE FORMATTING REQUEST.
   - If asked for a Table -> **Output a Markdown Table.**
   - If asked for a Syllabus -> **Provide the full syllabus structure.**
   - DO NOT use the MCQ format here. Be a smart assistant.

3. **SCENARIO C: GENERAL CONVERSATION/QUERIES**
   - **TRIGGER:** General questions like "Explain Inflation", "What is the 16th FC?".
   - **ACTION:** Give a clear, accurate, and high-quality explanation. Use Bullet points for clarity.

**CRITICAL RULE:** Do not force "Elimination" or "Key Facts" onto standard questions or requests for tables. Only use those for MCQs.
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

// --- MAIN MESSAGE LOGIC ---
client.on('message', async msg => {
    const chat = await msg.getChat();
    
    // Logic: Reply only if tagged (@) in a Group OR if it's a direct message
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            await chat.sendStateTyping();

            // 1. Clean the user's prompt (remove the @Tag)
            let prompt = msg.body.replace(/@\S+/g, "").trim();
            let imagePart = null;

            // --- HARD-CODED IDENTITY CHECK (Fixes the "Who are you" confusion) ---
            // If the user asks for identity, we reply immediately and STOP. We don't ask AI.
            const lowerPrompt = prompt.toLowerCase();
            if (lowerPrompt.match(/^(who are you|your name|who created you|intro|introduction)/)) {
                await msg.reply("I am Siddhartha's AI Assistant, Created By Siddhartha Vardhan Singh.");
                return; // Stop processing here.
            }

            // --- UNIVERSAL CONTEXT READER ---
            if (msg.hasQuotedMsg) {
                const quotedMsg = await msg.getQuotedMessage();

                // A. QUOTED IMAGE
                if (quotedMsg.hasMedia) {
                    const media = await quotedMsg.downloadMedia();
                    if (media && media.mimetype.startsWith('image/')) {
                        imagePart = { inlineData: { data: media.data, mimeType: media.mimetype } };
                    }
                }

                // B. QUOTED POLL
                if (quotedMsg.type === 'poll_creation') {
                    const pollQuestion = quotedMsg.pollName || quotedMsg.body || "Question";
                    let pollOptions = "Options not readable.";
                    if (quotedMsg.pollOptions && Array.isArray(quotedMsg.pollOptions)) {
                        pollOptions = quotedMsg.pollOptions.map(opt => opt.name).join(", ");
                    }
                    // We clearly tell Gemini this is an MCQ
                    prompt = `[TASK: SOLVE THIS MCQ/POLL]\nQuestion: "${pollQuestion}"\nOptions: ${pollOptions}\n\nUser Instruction: ${prompt}`;
                }

                // C. QUOTED TEXT
                else if (quotedMsg.body) {
                    prompt = `[CONTEXT MESSAGE]\n"${quotedMsg.body}"\n\nUSER REQUEST: ${prompt}`;
                }
            } 
            // --- DIRECT IMAGE HANDLING ---
            else if (msg.hasMedia) {
                const media = await msg.downloadMedia();
                if (media && media.mimetype.startsWith('image/')) {
                    imagePart = { inlineData: { data: media.data, mimeType: media.mimetype } };
                }
            }

            // Safety check
            if (!prompt && !imagePart) return; 

            // RETRY LOOP
            let success = false;
            let attempts = 0;

            while (!success && attempts < 3) {
                attempts++;
                try {
                    const model = getModel();
                    const content = imagePart ? [prompt, imagePart] : [prompt];
                    const result = await model.generateContent(content);
                    await msg.reply(result.response.text());
                    success = true;

                } catch (error) {
                    console.error(`Attempt ${attempts} Failed:`, error.message);
                    if (error.message.includes("429") || error.message.includes("quota")) {
                        rotateKey();
                    } else {
                        break; 
                    }
                }
            }

        } catch (err) {
            console.error("Bot Error:", err);
        }
    }
});

client.initialize();
