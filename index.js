const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal'); 
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');

// --- WEB SERVER ---
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = ""; 

app.get('/', (req, res) => res.send('Bot is Alive! <a href="/qr">Scan QR</a>'));
app.get('/qr', async (req, res) => {
    if (!qrCodeData) return res.send('<h2>⏳ Generating QR... Reload in 10s.</h2>');
    try {
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;">
                  <img src="${url}" style="border:5px solid black;width:300px;"></div>`);
    } catch { res.send('Error generating QR'); }
});
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- AI SETUP ---
const API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);

// ✅ NEW LIST: Mix of 'Flash', 'Lite' and '2.5' to avoid hitting one single limit
const MODELS_TO_TRY = [
    "gemini-2.0-flash", 
    "gemini-2.5-flash",           // Backup 1 (Newer)
    "gemini-2.0-flash-lite-preview-02-05", // Backup 2 (Lightweight)
    "gemini-flash-latest"         // Backup 3 (Standard)
];
let currentModelIndex = 0;

function getModel() {
    const modelName = MODELS_TO_TRY[currentModelIndex];
    console.log(`🧠 Switching Brain to: ${modelName}`);
    return genAI.getGenerativeModel({ 
        model: modelName,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
        ]
    });
}

// --- WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run']
    }
});

client.on('qr', (qr) => {
    console.log('⚡ QR RECEIVED! Check /qr link.');
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot is Online!');
    qrCodeData = ""; 
});

client.on('message', async msg => {
    const chat = await msg.getChat();
    
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            const prompt = msg.body.replace(/@\S+/g, "").trim();
            if (!prompt) return;

            await chat.sendStateTyping();

            try {
                const model = getModel();
                const result = await model.generateContent(prompt);
                await msg.reply(result.response.text());
                
            } catch (aiError) {
                console.error(`❌ Model ${MODELS_TO_TRY[currentModelIndex]} crashed:`, aiError.message);
                
                // 🛑 CRITICAL FIX: Catch "429 Too Many Requests" OR "404 Not Found"
                if (aiError.message.includes("429") || aiError.message.includes("404") || aiError.message.includes("not found") || aiError.message.includes("quota")) {
                    
                    currentModelIndex++; // Move to next brain
                    
                    if (currentModelIndex < MODELS_TO_TRY.length) {
                        console.log(`⚠️ Quota Hit! Trying Backup: ${MODELS_TO_TRY[currentModelIndex]}`);
                        const backupModel = getModel();
                        const retryResult = await backupModel.generateContent(prompt);
                        await msg.reply(retryResult.response.text());
                    } else {
                        // If ALL failed, reset index and tell user to wait
                        await msg.reply("I am thinking too fast! Give me 1 minute to cool down. 🥵");
                        currentModelIndex = 0; 
                    }
                }
            }
        } catch (error) {
            console.error("General Error:", error);
        }
    }
});

client.initialize();
