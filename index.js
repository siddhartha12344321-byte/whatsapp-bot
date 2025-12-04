const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal'); 
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');

// --- 1. WEB SERVER (For Scanning & Uptime) ---
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = ""; 

app.get('/', (req, res) => res.send('Bot is Alive! <a href="/qr">Scan QR Code</a>'));

app.get('/qr', async (req, res) => {
    if (!qrCodeData) return res.send('<h2>⏳ Generating QR... Reload in 10 seconds.</h2>');
    try {
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`
            <div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">
                <h1>📱 Scan This QR</h1>
                <img src="${url}" style="border:5px solid #000; width:300px; border-radius:10px;">
                <p>Open WhatsApp > Linked Devices > Link a Device</p>
            </div>
        `);
    } catch { res.send('Error generating QR image.'); }
});

app.listen(port, () => console.log(`Server running on port ${port}`));

// --- 2. KEY ROTATION SYSTEM (Priority: Key 2 -> Key 1) ---
const rawKeys = [
    process.env.GEMINI_API_KEY_2, // FIRST PRIORITY 🥇
    process.env.GEMINI_API_KEY    // BACKUP 🥈
].filter(k => k); // Removes empty keys if you forget one

if (rawKeys.length === 0) {
    console.error("❌ NO API KEYS FOUND! Please add GEMINI_API_KEY_2 in Render Environment.");
    process.exit(1);
}

let currentKeyIndex = 0;
let genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);

function rotateKey() {
    // Switch to the next key in the list
    currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
    console.log(`🔄 Quota Hit! Switching to API Key #${currentKeyIndex + 1}`);
    genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
}

// --- 3. MODEL CONFIGURATION ---
// Using Gemini 2.0 as discovered in your logs
const MODEL_NAME = "gemini-2.0-flash"; 

function getModel() {
    return genAI.getGenerativeModel({ 
        model: MODEL_NAME,
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
        // Critical arguments for Cloud Hosting (Render)
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run']
    }
});

client.on('qr', (qr) => {
    console.log('⚡ NEW QR RECEIVED! Check your /qr link.');
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot is Online & Ready!');
    qrCodeData = ""; 
});

client.on('message', async msg => {
    const chat = await msg.getChat();
    
    // Logic: Only reply to Groups when Tagged (@)
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            const prompt = msg.body.replace(/@\S+/g, "").trim();
            if (!prompt) return;

            await chat.sendStateTyping();

            // RETRY LOOP: Handles "429" (Quota) errors automatically
            let success = false;
            let attempts = 0;

            while (!success && attempts < 3) {
                attempts++;
                try {
                    const model = getModel();
                    const result = await model.generateContent(prompt);
                    await msg.reply(result.response.text());
                    success = true; // Success! Stop looping.

                } catch (error) {
                    console.error(`Attempt ${attempts} Failed:`, error.message);

                    // If error is 429 (Too Many Requests), Swap Keys!
                    if (error.message.includes("429") || error.message.includes("quota")) {
                        rotateKey();
                        // The loop will run again with the NEW key
                    } else {
                        // If it's a different error (like 500), stop trying.
                        break; 
                    }
                }
            }

            if (!success) {
                // If all keys fail, just stay silent or log it.
                console.log("❌ All keys exhausted or unknown error.");
            }

        } catch (err) {
            console.error("General Bot Error:", err);
        }
    }
});

client.initialize();
