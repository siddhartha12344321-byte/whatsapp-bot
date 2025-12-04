const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal'); // For logs
const QRCodeImage = require('qrcode');     // NEW: For web browser
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// --- GLOBAL VAR TO STORE QR CODE ---
let qrCodeData = ""; 

// --- WEB SERVER ---
app.get('/', (req, res) => { res.send('Bot is Alive! Go to <b>/qr</b> to scan.'); });

// NEW ROUTE: Display QR as an Image
app.get('/qr', async (req, res) => {
    if (!qrCodeData) {
        return res.send('<h2>⏳ QR Code generating... reload this page in 10 seconds.</h2>');
    }
    try {
        // Convert the text QR into a scanable image
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`
            <div style="display:flex; justify-content:center; align-items:center; height:100vh;">
                <div style="text-align:center;">
                    <h1>Scan Me</h1>
                    <img src="${url}" style="width:300px; border: 5px solid black;" />
                    <p>Refresh if it expires.</p>
                </div>
            </div>
        `);
    } catch (err) {
        res.send('Error generating QR');
    }
});

app.listen(port, () => { console.log(`Server running on port ${port}`); });

// --- BOT LOGIC ---
const API_KEY = process.env.GEMINI_API_KEY; 
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED (Check /qr route)');
    qrCodeData = qr; // Save QR to variable for the website
    qrcode.generate(qr, { small: true }); // Still print to logs just in case
});

client.on('ready', () => {
    console.log('✅ Bot is Online!');
    qrCodeData = ""; // Clear QR code after login
});

client.on('message', async msg => {
    const chat = await msg.getChat();
    if (chat.isGroup && msg.body.includes("@")) {
        try {
            const prompt = msg.body.replace(/@\S+/g, "").trim();
            if (!prompt) return;
            await chat.sendStateTyping();
            const result = await model.generateContent(prompt);
            await msg.reply(result.response.text());
        } catch (error) { console.error(error); }
    }
});

client.initialize();
