const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
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

function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
    console.log(`🔄 Switching to API Key #${currentKeyIndex + 1}`);
    genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
}

// --- 3. MODEL CONFIGURATION (UPSC TUTOR MODE) ---
const MODEL_NAME = "gemini-2.0-flash";

// 🔥 THIS IS THE BRAIN UPGRADE 🔥
const SYSTEM_INSTRUCTION = `
You are an expert UPSC (Union Public Service Commission) Exam Tutor. 
Your Target Audience: Serious aspirants preparing for the Civil Services Exam.
Your Goal: Provide the most concise, high-yield, and accurate solution possible.

Guidelines:
1. Direct Answer: State the correct option/answer clearly first.
2. The "Why": Provide a 2-3 sentence explanation focusing on the specific Article, Amendment, History Date, or Economic concept.
3. Elimination: Briefly mention why the confusing distractors are wrong (if applicable).
4. Tone: Professional, strict, and to-the-point. No "Hello" or "Hope this helps".
5. For Polls: Analyze the question and options carefully.
`;

function getModel() {
    return genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        systemInstruction: SYSTEM_INSTRUCTION, // <-- Added Persona Here
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
    console.log('✅ UPSC Bot is Online!');
    qrCodeData = "";
});

// --- MAIN MESSAGE LOGIC ---
client.on('message', async msg => {
    const chat = await msg.getChat();
    
    // Logic: Reply only if tagged (@) in a Group OR if it's a direct message
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            await chat.sendStateTyping();

            let prompt = msg.body.replace(/@\S+/g, "").trim();
            let imagePart = null;

            // A. CHECK FOR IMAGES (Direct or Quoted)
            if (msg.hasMedia) {
                const media = await msg.downloadMedia();
                if (media && media.mimetype.startsWith('image/')) {
                    imagePart = { inlineData: { data: media.data, mimeType: media.mimetype } };
                }
            } else if (msg.hasQuotedMsg) {
                const quotedMsg = await msg.getQuotedMessage();
                if (quotedMsg.hasMedia) {
                    const media = await quotedMsg.downloadMedia();
                    if (media && media.mimetype.startsWith('image/')) {
                        imagePart = { inlineData: { data: media.data, mimeType: media.mimetype } };
                    }
                }
                
                // B. CHECK FOR POLLS (Handle Poll Replies)
                if (quotedMsg.type === 'poll_creation') {
                    const pollQuestion = quotedMsg.pollName;
                    const pollOptions = quotedMsg.pollOptions.map(opt => opt.name).join(", ");
                    
                    prompt = `[UPSC POLL QUESTION]\nQuestion: "${pollQuestion}"\nOptions: ${pollOptions}\n\nTask: Identify the correct option and explain the core concept concisely for an aspirant.`;
                }
            }

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
            console.error("Error:", err);
        }
    }
});

client.initialize();
