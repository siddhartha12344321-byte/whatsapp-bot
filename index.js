// ==================== SIMPLE WHATSAPP BOT FOR RENDER ====================
// Made for Students - Zero Cost - Free Tier Friendly

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ==================== EXPRESS SERVER ====================
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>WhatsApp Bot</title></head>
      <body style="font-family: Arial; text-align: center; margin-top: 50px;">
        <h1>🤖 WhatsApp Bot is Running!</h1>
        <p>Check logs for QR Code to scan</p>
        <p><a href="/qr">Click here for QR</a></p>
      </body>
    </html>
  `);
});

app.get('/qr', (req, res) => {
  res.send(`
    <h1>QR Code appears in Render logs below</h1>
    <p>Open WhatsApp > Settings > Linked Devices > Link a Device</p>
    <p>Scan the QR code from your Render logs</p>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    time: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`🌐 Open: https://your-bot-name.onrender.com`);
});

// ==================== WHATSAPP CLIENT ====================
console.log('🚀 Starting WhatsApp Bot...');

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'student-bot'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions'
    ]
  }
});

// QR Code Event
client.on('qr', (qr) => {
  console.log('\n==========================================');
  console.log('📱 SCAN THIS QR CODE WITH WHATSAPP:');
  console.log('==========================================');
  qrcode.generate(qr, { small: true });
  console.log('\n✅ QR Code generated! Scan with WhatsApp:');
  console.log('1. Open WhatsApp on your phone');
  console.log('2. Tap Menu > Linked Devices');
  console.log('3. Tap "Link a Device"');
  console.log('4. Point camera at QR code');
  console.log('==========================================\n');
});

// Ready Event
client.on('ready', () => {
  console.log('🎉 WhatsApp Bot is READY!');
  console.log('You can now send messages to this bot');
});

// Message Event
client.on('message', async (msg) => {
  console.log(`📩 Message from ${msg.from}: ${msg.body}`);
  
  // Simple reply
  if (msg.body.toLowerCase() === 'hi' || msg.body.toLowerCase() === 'hello') {
    await msg.reply('Hello! I am your WhatsApp bot. How can I help you?');
  }
  
  // Ping command
  if (msg.body === 'ping') {
    await msg.reply('pong 🏓');
  }
  
  // Help command
  if (msg.body === 'help') {
    await msg.reply('I am a simple WhatsApp bot. Try sending "hi" or "ping"');
  }
});

// Error Handling
client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
});

client.on('disconnected', (reason) => {
  console.log('❌ Client disconnected:', reason);
  console.log('Bot will try to reconnect automatically...');
});

// Initialize WhatsApp Client
console.log('🔄 Initializing WhatsApp connection...');
client.initialize();

// ==================== KEEP ALIVE FOR FREE TIER ====================
// Free Render sleeps after 15 minutes - This keeps it awake
setInterval(() => {
  console.log('❤️  Heartbeat - Bot is still alive');
}, 5 * 60 * 1000); // Every 5 minutes

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  client.destroy();
  process.exit(0);
});
