const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal'); // For logs (backup)
const QRCodeImage = require('qrcode');     // For web browser (primary)
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');

// --- 1. SETUP WEB SERVER (For UptimeRobot & QR Display) ---
const app = express();
const port = process.env.PORT || 3000;

// Global variable to store the QR code text
let qrCodeData = ""; 

app.get('/', (req, res) => {
    res.send('<h1>Bot is Active 🤖</h1><p>Go to <a href="/qr">/qr</a> to scan your code.</p>');
});

app.get('/qr', async (req, res) => {
    if (!qrCodeData) {
        return res.send('<h2>⏳ Bot is connected (or regenerating)... Reload in 10s.</h2>');
    }
    try {
        // Convert text QR to an Image URL
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`
            <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; font-family:sans-serif;">
                <h1>📱 Scan Me</h1>
                <img src="${url}" style="width:300px; border: 5px solid #333; border-radius:10px;" />
                <p>Open WhatsApp > Linked Devices > Link a Device</p>
                <p><i>Refreshes automatically when code changes.</i></p>
            </div>
        `);
    } catch (err) {
        res.send('Error generating QR Image.');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- 2. CONFIGURATION & AI BRAIN ---
const API_KEY = process.env.GEMINI_API_KEY; 

if (!API_KEY) {
    console.error("❌ CRITICAL ERROR: GEMINI_API_KEY is missing in Render Environment Variables!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

// SAFETY SETTINGS: Turn OFF filters so it doesn't get stuck "Typing..."
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
    ]
});

// --- 3. WHATSAPP CLIENT SETUP ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        // Critical args for Render/Cloud hosting
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run'
        ]
    }
});

// --- 4. EVENTS ---

client.on('qr', (qr) => {
    console.log('⚡ NEW QR RECEIVED. Check the /qr link!');
    qrCodeData = qr; // Update the variable for the website
    qrcode.generate(qr, { small: true }); // Print to logs as backup
});

client.on('ready', () => {
    console.log('✅ Bot is successfully logged in and online!');
    qrCodeData = ""; // Clear QR so website doesn't show old code
});

client.on('message', async msg => {
    const chat = await msg.getChat();

    // LOGIC: Only reply if it's a Group AND the bot is Tagged (@)
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            // Remove the "@BotName" part from the message
            const prompt = msg.body.replace(/@\S+/g, "").trim();
            
            if (!prompt) return; // Don't reply to empty messages

            // Show "Typing..."
            await chat.sendStateTyping();

            // Ask Gemini
            const result = await model.generateContent(prompt);
            const response = result.response.text();

            // Reply
            await msg.reply(response);

        } catch (error) {
            console.error("❌ AI Error:", error);
            // If it crashes, tell the group (optional)
            // await msg.reply("My brain froze! 🥶 Check logs.");
        }
    }
});

// Start the bot
client.initialize();
