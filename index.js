const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');

// --- 1. SETUP WEB SERVER (To keep the bot running 24/7) ---
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Your WhatsApp Bot is Alive and Running! 🚀');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// --- 2. CONFIGURATION ---
// Get the API Key from the Environment Variable (Set this in Render Dashboard)
const API_KEY = process.env.GEMINI_API_KEY; 

if (!API_KEY) {
    console.error("❌ ERROR: GEMINI_API_KEY is missing! Set it in your Environment Variables.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- 3. WHATSAPP CLIENT SETUP ---
const client = new Client({
    authStrategy: new LocalAuth(), // Saves login session
    puppeteer: {
        headless: true,
        // These arguments are ESSENTIAL for running on free cloud servers (Render/Replit)
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
    }
});

// --- 4. EVENTS ---

// Generate QR Code
client.on('qr', (qr) => {
    // This logs the QR code to the "Logs" tab in Render so you can scan it
    console.log('⚡ SCAN THIS QR CODE NOW ⚡');
    qrcode.generate(qr, { small: true });
});

// Login Successful
client.on('ready', () => {
    console.log('✅ Bot is successfully logged in and online!');
});

// Handle Messages
client.on('message', async msg => {
    const chat = await msg.getChat();

    // Only reply if it's a Group AND the bot is mentioned/tagged
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            // Remove the bot's tag from the message to get the pure prompt
            const prompt = msg.body.replace(/@\S+/g, "").trim();
            
            if (!prompt) return; // Ignore empty messages

            // Show "Typing..." state
            await chat.sendStateTyping();

            // Ask Gemini AI
            const result = await model.generateContent(prompt);
            const response = result.response.text();

            // Reply to user
            await msg.reply(response);

        } catch (error) {
            console.error("Error generating response:", error);
            // Optional: await msg.reply("My brain is taking a nap. Try again later!");
        }
    }
});

// Start the Client
client.initialize();
