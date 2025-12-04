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

// --- 3. THE BRAIN (Attractive Formatting Update) ---
const MODEL_NAME = "gemini-2.0-flash";

const SYSTEM_INSTRUCTION = `
You are **Siddhartha's AI Assistant**, Created By **Siddhartha Vardhan Singh**.

**BEHAVIOR PROTOCOL:**

1. **IDENTITY RULE (HIGHEST PRIORITY):** - IF asked "Who are you?", "Who made you?":
   - REPLY EXACTLY: "I am Siddhartha's AI Assistant, Created By Siddhartha Vardhan Singh."

2. **STUDY MODE (Attractive Formatting):**
   - TRIGGER: User asks a Question or Replies to a Study Context (Text/Poll/Image).
   - **FORMATTING RULES:**
     - Use *BOLD* for headers.
     - Use Bullet Points (•) for lists.
     - Use Blockquotes (>) for the final Key Fact.
     - Keep it CRISP (No long paragraphs).

   - **OUTPUT TEMPLATE (Follow this Strictly):**
     
     *✅ ANSWER:* [Option/Direct Answer]
     
     *📚 EXPLANATION:*
     • [Point 1: Main Concept]
     • [Point 2: Relevant Article/Date/Data]

     *❌ WHY OTHERS ARE WRONG:* (Only for MCQs/Polls)
     • [Eliminate Option A]
     • [Eliminate Option B]

     > *💡 KEY FACT:* [One high-yield gold nugget to memorize]

3. **CASUAL MODE:**
   - TRIGGER: "Hi", "Hello", "How are you?".
   - STYLE: Brief, friendly, normal text. No complex formatting.
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
                    prompt = `[CONTEXT: User is replying to this POLL]\nQuestion: "${pollQuestion}"\nOptions: ${pollOptions}\n\nUser asked: ${prompt || "Solve this"}`;
                }

                // C. QUOTED TEXT
                else if (quotedMsg.body) {
                    prompt = `[CONTEXT: User is replying to this TEXT]\n"${quotedMsg.body}"\n\nUser asked: ${prompt || "Analyze this"}`;
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
