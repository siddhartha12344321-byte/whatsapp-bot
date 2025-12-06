// index.js — Production Ready for Render
// WhatsApp Bot with Gemini 2.0 + UPSC Quiz System
// Environment variables required:
//   GEMINI_API_KEY (required), GEMINI_API_KEY_2 (optional), 
//   HISTORY_SECRET (required), PORT (auto-set by Render)

// ==================== ENVIRONMENT VALIDATION ====================
function validateEnvironment() {
  const required = ['GEMINI_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('The bot will start but AI features will fail.');
    // Don't exit, as WhatsApp connection might still work
  }
  
  if (!process.env.HISTORY_SECRET) {
    console.warn('⚠️ HISTORY_SECRET not set. Chat history will be stored in plain text.');
  }
  
  console.log(`✅ Environment check complete. Node ${process.version}`);
}

validateEnvironment();

// ==================== IMPORTS ====================
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');
const fs = require('fs');
const path = require('path');
const sanitizeHtml = require('sanitize-html');
const crypto = require('crypto');

// Conditional imports for Render compatibility
let puppeteer;
let chromium;
try {
  // Use puppeteer-core for production (Render) to reduce size
  puppeteer = require('puppeteer-core');
  chromium = require('chrome-aws-lambda');
  console.log('✅ Using puppeteer-core for production');
} catch (e) {
  console.warn('⚠️ puppeteer-core not found, falling back to puppeteer');
  puppeteer = require('puppeteer');
  chromium = null;
}

// ==================== WEB SERVER ====================
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = "";
let sessionAuthenticated = false;
let lastReadyAt = null;

// Middleware for security
app.use((req, res, next) => {
  res.set('X-Powered-By', 'Siddhartha AI');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// Health endpoints
app.get('/', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
    <head>
      <title>Siddhartha's AI Assistant</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }
        .status { padding: 15px; border-radius: 5px; margin: 20px 0; }
        .online { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .offline { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .btn { display: inline-block; padding: 10px 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
        .btn:hover { background: #45a049; }
        .info { background: #d1ecf1; color: #0c5460; padding: 15px; border-radius: 5px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 Siddhartha's AI Assistant</h1>
        <div class="status ${sessionAuthenticated ? 'online' : 'offline'}">
          <strong>Status:</strong> ${sessionAuthenticated ? '✅ Online & Connected' : '❌ Offline or Connecting...'}
        </div>
        <div class="info">
          <p><strong>Uptime:</strong> ${process.uptime().toFixed(0)} seconds</p>
          <p><strong>Active Quizzes:</strong> ${quizSessions.size}</p>
          <p><strong>Last Ready:</strong> ${lastReadyAt ? new Date(lastReadyAt).toLocaleString() : 'Never'}</p>
        </div>
        <a href="/qr" class="btn">📱 Scan QR Code</a>
        <a href="/health" class="btn">📊 Health Check</a>
        <a href="/metrics" class="btn">📈 Metrics</a>
        <a href="/ping" class="btn">❤️ Keep Alive</a>
      </div>
    </body>
  </html>
  `;
  res.send(html);
});

// QR Code endpoint
app.get('/qr', async (req, res) => {
  try {
    if (!qrCodeData && sessionAuthenticated) {
      return res.send('<h2>✅ Bot is connected! No QR needed.</h2><p><a href="/">Return to home</a></p>');
    }
    if (!qrCodeData) {
      return res.send('<h2>⏳ No QR available right now — try again later.</h2><p><a href="/">Return to home</a></p>');
    }
    const url = await QRCodeImage.toDataURL(qrCodeData);
    res.send(`
      <div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">
        <h1>📱 Scan This QR Code</h1>
        <p>Open WhatsApp > Settings > Linked Devices > Link a Device</p>
        <img src="${url}" style="border:5px solid #000; width:300px; border-radius:10px; margin:20px;">
        <p><a href="/">Return to home</a></p>
      </div>
    `);
  } catch (e) {
    console.error('QR route error:', e);
    res.status(500).send('Error generating QR image.');
  }
});

// Health endpoint
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const memMB = {
    rss: (mem.rss / 1024 / 1024).toFixed(2),
    heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2),
    heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(2)
  };
  
  res.json({
    status: sessionAuthenticated ? 'healthy' : 'connecting',
    whatsapp: sessionAuthenticated ? 'connected' : 'disconnected',
    lastReadyAt: lastReadyAt ? new Date(lastReadyAt).toISOString() : null,
    sessionAuthenticated,
    modelKeyIndex: currentKeyIndex,
    memory: memMB,
    uptimeSeconds: process.uptime(),
    quizSessions: quizSessions.size,
    activePolls: activePolls.size,
    nodeVersion: process.version,
    platform: process.platform,
    timestamp: Date.now()
  });
});

// Prometheus metrics
app.get('/metrics', (req, res) => {
  const mem = process.memoryUsage();
  res.set('Content-Type', 'text/plain');
  res.send(`
# HELP app_quiz_sessions Number of active quiz sessions
app_quiz_sessions ${quizSessions.size}
# HELP app_active_polls Number of active polls
app_active_polls ${activePolls.size}
# HELP app_memory_rss_bytes Resident set size
app_memory_rss_bytes ${mem.rss}
# HELP app_memory_heap_used_bytes Heap memory used
app_memory_heap_used_bytes ${mem.heapUsed}
# HELP app_memory_heap_total_bytes Heap memory total
app_memory_heap_total_bytes ${mem.heapTotal}
# HELP app_uptime_seconds Application uptime in seconds
app_uptime_seconds ${process.uptime()}
  `);
});

// Keep-alive endpoint for Render sleep cycles
app.get('/ping', (req, res) => {
  res.json({
    status: 'pong',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    authenticated: sessionAuthenticated
  });
});

// Start server
const server = app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`🔗 Health: http://localhost:${port}/health`);
  console.log(`🔗 QR Code: http://localhost:${port}/qr`);
});

// ==================== ENCRYPTED PERSISTENCE ====================
const HISTORY_FILE = path.join(__dirname, 'chatHistory.json');
const HISTORY_SECRET = process.env.HISTORY_SECRET || null;
const HISTORY_ALGO = 'aes-256-gcm';

// Secure key derivation with PBKDF2
function deriveKey(secret, salt) {
  return crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256');
}

function encryptBuffer(buffer) {
  if (!HISTORY_SECRET) {
    throw new Error('HISTORY_SECRET is required for encryption.');
  }
  
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(HISTORY_SECRET, salt);
  
  const cipher = crypto.createCipheriv(HISTORY_ALGO, key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  // Format: salt(16) + iv(12) + tag(16) + ciphertext
  return Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

function decryptBuffer(b64) {
  if (!HISTORY_SECRET) {
    throw new Error('HISTORY_SECRET is required for decryption.');
  }
  
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 44) throw new Error('Invalid encrypted data length');
  
  const salt = raw.slice(0, 16);
  const iv = raw.slice(16, 28);
  const tag = raw.slice(28, 44);
  const ct = raw.slice(44);
  
  const key = deriveKey(HISTORY_SECRET, salt);
  const decipher = crypto.createDecipheriv(HISTORY_ALGO, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec;
}

let chatHistory = new Map();

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.log('No history file found, starting fresh.');
    return;
  }
  
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    let parsed;
    
    if (HISTORY_SECRET) {
      try {
        const dec = decryptBuffer(raw);
        parsed = JSON.parse(dec.toString('utf8'));
        console.log('✅ History loaded (encrypted)');
      } catch (e) {
        console.warn('Failed to decrypt history. Trying plain JSON...', e.message);
        parsed = JSON.parse(raw);
      }
    } else {
      parsed = JSON.parse(raw);
      console.log('✅ History loaded (plain text)');
    }
    
    chatHistory = new Map(Object.entries(parsed));
    console.log(`📊 Loaded ${chatHistory.size} chat histories`);
    
  } catch (e) {
    console.error('Failed to load history:', e.message);
    // Backup corrupted file
    try {
      const backupName = `chatHistory_backup_${Date.now()}.json`;
      fs.copyFileSync(HISTORY_FILE, backupName);
      console.log(`Backup created: ${backupName}`);
    } catch (backupErr) {
      console.error('Failed to create backup:', backupErr.message);
    }
  }
}

function saveHistory() {
  try {
    const obj = Object.fromEntries(chatHistory);
    const json = JSON.stringify(obj, null, 2);
    
    if (HISTORY_SECRET) {
      const enc = encryptBuffer(Buffer.from(json, 'utf8'));
      fs.writeFileSync(HISTORY_FILE, enc, 'utf8');
    } else {
      fs.writeFileSync(HISTORY_FILE, json, 'utf8');
    }
    
    // Keep only latest backup
    try {
      const backups = fs.readdirSync(__dirname)
        .filter(f => f.startsWith('chatHistory_backup_'))
        .sort()
        .reverse();
      
      if (backups.length > 5) {
        for (let i = 5; i < backups.length; i++) {
          fs.unlinkSync(path.join(__dirname, backups[i]));
        }
      }
    } catch (e) {
      // Ignore backup cleanup errors
    }
    
  } catch (e) {
    console.error('Failed to save history:', e.message);
  }
}

// Load history on startup
loadHistory();

// ==================== KEY ROTATION ====================
const rawKeys = [
  process.env.GEMINI_API_KEY_2, 
  process.env.GEMINI_API_KEY
].filter(k => k && k.trim().length > 0);

if (rawKeys.length === 0) {
  console.error("❌ NO GEMINI API KEYS FOUND! Set GEMINI_API_KEY environment variable.");
} else {
  console.log(`✅ ${rawKeys.length} Gemini API key(s) loaded`);
}

let currentKeyIndex = 0;
let genAI = rawKeys.length > 0 ? new GoogleGenerativeAI(rawKeys[currentKeyIndex]) : null;
const disabledKeys = new Map(); // key -> disabledUntil timestamp

function rotateKey() {
  if (!rawKeys.length) return;
  
  const now = Date.now();
  // Try to find a non-disabled key
  for (let i = 1; i <= rawKeys.length; i++) {
    const idx = (currentKeyIndex + i) % rawKeys.length;
    const key = rawKeys[idx];
    const disabledUntil = disabledKeys.get(key) || 0;
    
    if (now >= disabledUntil) {
      currentKeyIndex = idx;
      genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
      console.log(`🔄 Switching to API Key #${currentKeyIndex + 1}`);
      return;
    }
  }
  
  // All keys disabled? Use round-robin as fallback
  currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
  genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
  console.log(`🔄 (Fallback) switched to key #${currentKeyIndex + 1}`);
}

function disableCurrentKeyTemporary(minutes = 10) {
  if (!rawKeys.length) return;
  
  const key = rawKeys[currentKeyIndex];
  const until = Date.now() + minutes * 60 * 1000;
  disabledKeys.set(key, until);
  console.warn(`⛔ Key #${currentKeyIndex + 1} disabled until ${new Date(until).toLocaleTimeString()}`);
  rotateKey();
}

// Clean up disabled keys periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, disabledUntil] of disabledKeys.entries()) {
    if (now >= disabledUntil) {
      disabledKeys.delete(key);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// ==================== MEMORY SYSTEM ====================
function updateHistory(chatId, role, text) {
  if (!chatId) return;
  
  if (!chatHistory.has(chatId)) {
    chatHistory.set(chatId, []);
  }
  
  const history = chatHistory.get(chatId);
  history.push({ 
    role, 
    parts: [{ text }], 
    timestamp: Date.now() 
  });
  
  // Keep last 8 messages
  while (history.length > 8) history.shift();
  
  // Debounced save
  if (!updateHistory.saveTimer) {
    updateHistory.saveTimer = setTimeout(() => {
      saveHistory();
      updateHistory.saveTimer = null;
    }, 2000);
  }
}

// ==================== QUIZ & RATE LIMIT SYSTEMS ====================
const quizSessions = new Map(); // chatId -> session object
const activePolls = new Map(); // messageId -> { correctIndex, chatId }
const rateLimit = new Map();

// Clean up rate limit map periodically
const RATE_LIMIT_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  const WINDOW = 60000; // 1 minute window
  
  for (const [key, timestamps] of rateLimit.entries()) {
    const filtered = timestamps.filter(t => now - t < WINDOW);
    if (filtered.length === 0) {
      rateLimit.delete(key);
    } else {
      rateLimit.set(key, filtered);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL);

function checkRateLimit(chatId, from) {
  const now = Date.now();
  const WINDOW = 60000; // 1 minute
  const MAX_PER_USER = 40;
  const MAX_PER_CHAT = 200;

  const userKey = `${chatId}::${from}`;
  
  // User rate limit
  if (!rateLimit.has(userKey)) rateLimit.set(userKey, []);
  let userTimestamps = rateLimit.get(userKey);
  userTimestamps = userTimestamps.filter(t => now - t < WINDOW);
  
  if (userTimestamps.length >= MAX_PER_USER) return false;
  userTimestamps.push(now);
  rateLimit.set(userKey, userTimestamps);

  // Chat rate limit
  if (!rateLimit.has(chatId)) rateLimit.set(chatId, []);
  let chatTimestamps = rateLimit.get(chatId);
  chatTimestamps = chatTimestamps.filter(t => now - t < WINDOW);
  
  if (chatTimestamps.length >= MAX_PER_CHAT) return false;
  chatTimestamps.push(now);
  rateLimit.set(chatId, chatTimestamps);

  return true;
}

// Clean up stale quiz sessions
setInterval(() => {
  const now = Date.now();
  const QUIZ_TTL = 2 * 60 * 60 * 1000; // 2 hours
  
  for (const [chatId, session] of quizSessions.entries()) {
    if (!session.lastActivity || (now - session.lastActivity > QUIZ_TTL)) {
      console.log(`Cleaning up stale quiz session for ${chatId}`);
      quizSessions.delete(chatId);
      
      // Also clean up active polls for this chat
      for (const [msgId, pollData] of activePolls.entries()) {
        if (pollData.chatId === chatId) {
          activePolls.delete(msgId);
        }
      }
    }
  }
}, 10 * 60 * 1000); // Every 10 minutes

// ==================== GEMINI AI MODEL ====================
const MODEL_NAME = "gemini-2.0-flash";
const SYSTEM_INSTRUCTION = `
You are **Siddhartha's AI Assistant** - an expert UPSC companion bot.

**QUIZ GENERATION PROTOCOL:**
1. When user requests "Quiz", "Test", "MCQ" -> OUTPUT STRICT JSON ONLY.
2. No introductory text - ONLY pure JSON.
3. Topic Strictness: If user asks for "Polity Quiz", generate ONLY Polity questions.

**REQUIRED JSON FORMAT:**
{
    "type": "quiz_batch",
    "topic": "Subject Name",
    "quizzes": [
        { 
            "question": "Question text?", 
            "options": ["A", "B", "C", "D"], 
            "correct_index": 0, 
            "answer_explanation": "Detailed explanation" 
        }
    ]
}
`;

function getModel() {
  if (!genAI) {
    throw new Error('No generative AI client configured (API keys missing).');
  }
  
  return genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_INSTRUCTION,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }
    ],
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    }
  });
}

// ==================== WHATSAPP CLIENT ====================
let client = null;
let clientInitInProgress = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
let keepAliveInterval = null;
let messageQueues = new Map(); // For handling concurrent messages

function clientInitialized() {
  return client && client.info && sessionAuthenticated;
}

async function getPuppeteerConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction && chromium) {
    // Render production configuration
    return {
      executablePath: await chromium.executablePath,
      args: chromium.args,
      headless: chromium.headless,
      ignoreHTTPSErrors: true
    };
  } else {
    // Local development
    return {
      executablePath: puppeteer.executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
      headless: true
    };
  }
}

async function createClient() {
  console.log('🔄 Creating WhatsApp client...');
  
  try {
    const puppeteerConfig = await getPuppeteerConfig();
    
    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '.wwebjs_auth'),
        clientId: 'siddhartha-ai-bot'
      }),
      puppeteer: puppeteerConfig,
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
      }
    });

    // QR Code event
    client.on('qr', (qr) => {
      console.log('⚡ NEW QR CODE RECEIVED');
      qrCodeData = qr;
      qrcode.generate(qr, { small: true });
    });

    // Ready event
    client.on('ready', () => {
      console.log("✅ Siddhartha's AI Assistant is Online!");
      sessionAuthenticated = true;
      lastReadyAt = Date.now();
      reconnectAttempts = 0;
      
      // Clear QR after 1 minute
      setTimeout(() => { 
        if (qrCodeData) {
          qrCodeData = "";
          console.log('QR code cleared');
        }
      }, 60 * 1000);
      
      // Start heartbeat if not running
      if (!keepAliveInterval) {
        startKeepAlive();
      }
    });

    // Disconnected event
    client.on('disconnected', (reason) => {
      console.warn('❌ WhatsApp client disconnected:', reason);
      sessionAuthenticated = false;
      stopKeepAlive();
      scheduleReconnect();
    });

    // Authentication failure
    client.on('auth_failure', (msg) => {
      console.error('❌ Authentication failed:', msg);
      sessionAuthenticated = false;
    });

    // Loading screen events
    client.on('loading_screen', (percent, message) => {
      console.log(`🔄 Loading: ${percent}% - ${message}`);
    });

    // Attach handlers
    attachVoteHandler();
    attachMessageHandler();

    // Initialize client
    await client.initialize();
    console.log('✅ WhatsApp client initialized');
    
  } catch (err) {
    console.error('❌ Client initialization error:', err.message);
    throw err;
  }
}

function startKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }
  
  keepAliveInterval = setInterval(() => {
    const mem = process.memoryUsage();
    const memMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    
    console.log(`❤️  Heartbeat: ${new Date().toLocaleTimeString()} | Auth: ${sessionAuthenticated} | Quizzes: ${quizSessions.size} | Memory: ${memMB}MB`);
    
    // Save history periodically
    saveHistory();
    
    // Self-ping to prevent Render sleep
    if (process.env.NODE_ENV === 'production' && port) {
      try {
        fetch(`http://localhost:${port}/ping`).catch(() => {});
      } catch (e) {
        // Ignore ping errors
      }
    }
  }, 60 * 1000); // Every minute
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max reconnect attempts reached. Manual intervention required.');
    return;
  }
  
  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * Math.pow(1.5, Math.min(reconnectAttempts, 8)));
  
  console.log(`⏳ Reconnect attempt ${reconnectAttempts} in ${Math.round(delay/1000)}s`);
  
  setTimeout(async () => {
    try {
      if (client && typeof client.destroy === 'function') {
        try { 
          await client.destroy(); 
        } catch (e) { 
          console.log('Client destroy error (ignored):', e.message);
        }
      }
    } catch (e) {
      console.log('Error during client cleanup:', e.message);
    }
    
    clientInitInProgress = false;
    tryInitClient();
  }, delay);
}

async function tryInitClient() {
  if (clientInitInProgress) {
    console.log('Client initialization already in progress');
    return;
  }
  
  clientInitInProgress = true;
  
  try {
    await createClient();
    clientInitInProgress = false;
  } catch (e) {
    console.error('Failed to create client:', e.message);
    clientInitInProgress = false;
    scheduleReconnect();
  }
}

// Start client initialization
setTimeout(() => {
  tryInitClient();
}, 2000); // Small delay to let server start first

// ==================== VOTE HANDLER ====================
function attachVoteHandler() {
  if (!client || typeof client.on !== 'function') return;
  
  client.on('poll_vote', async (vote) => {
    try {
      const parentId = vote.parentMessageId?.id;
      if (!parentId || !activePolls.has(parentId)) return;
      
      const pollData = activePolls.get(parentId);
      const { correctIndex, chatId } = pollData;
      
      if (!quizSessions.has(chatId)) return;
      
      const session = quizSessions.get(chatId);
      const voterId = vote.sender;
      
      if (!voterId) return;
      
      // Initialize score if not exists
      if (!session.scores.has(voterId)) {
        session.scores.set(voterId, 0);
      }
      
      // Check if already credited for this question
      const uniqueVoteKey = `${session.index}_${voterId}`;
      if (session.creditedVotes.has(uniqueVoteKey)) {
        return; // Already credited
      }
      
      // Check if vote is correct
      const q = session.questions[session.index];
      const correctOptionText = q.options[correctIndex];
      const isCorrect = vote.selectedOptions?.some(
        opt => (opt.name || '').trim() === (correctOptionText || '').trim()
      );
      
      if (isCorrect) {
        const currentScore = session.scores.get(voterId);
        session.scores.set(voterId, currentScore + 1);
        session.creditedVotes.add(uniqueVoteKey);
        console.log(`✅ Correct vote by ${voterId} for question ${session.index + 1}`);
      }
      
    } catch (e) {
      console.error('Vote processing error:', e.message);
    }
  });
}

// ==================== QUIZ CONTROLLER ====================
async function runQuizStep(chat, chatId) {
  if (!quizSessions.has(chatId)) return;
  
  const session = quizSessions.get(chatId);
  if (!session || !session.active) return;
  
  // Update last activity
  session.lastActivity = Date.now();
  
  // A. FINISH & SHOW REPORT CARD
  if (session.index >= session.questions.length) {
    let report = "📊 **FINAL REPORT CARD** 📊\n\n";
    const sortedScores = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
    
    if (sortedScores.length === 0) {
      report += "No votes recorded for this quiz.\n";
    } else {
      let rank = 1;
      for (const [contactId, score] of sortedScores) {
        let name = contactId.replace('@c.us', '');
        try {
          const contact = await client.getContactById(contactId);
          if (contact && (contact.pushname || contact.name)) {
            name = contact.pushname || contact.name;
          }
        } catch (e) {
          // Use default name
        }
        
        let medal = '';
        if (rank === 1) medal = '🥇';
        else if (rank === 2) medal = '🥈';
        else if (rank === 3) medal = '🥉';
        else medal = '🔹';
        
        const pointsText = score === 1 ? 'point' : 'points';
        report += `${medal} *${name}*: ${score} ${pointsText}\n`;
        rank++;
      }
    }
    
    report += `\n🏁 Quiz completed: *${session.questions.length} questions*`;
    
    await chat.sendMessage(report);
    quizSessions.delete(chatId);
    return;
  }
  
  // B. SEND CURRENT QUESTION
  const q = session.questions[session.index];
  const progress = `Question ${session.index + 1}/${session.questions.length}`;
  
  try {
    const poll = new Poll(
      `${progress}\n\n${q.question}`,
      q.options,
      { allowMultipleAnswers: false }
    );
    
    const sentMsg = await chat.sendMessage(poll);
    activePolls.set(sentMsg.id.id, { 
      correctIndex: q.correct_index, 
      chatId,
      questionIndex: session.index 
    });
    
    // C. TIMER
    setTimeout(async () => {
      try {
        if (!quizSessions.has(chatId) || !quizSessions.get(chatId).active) {
          activePolls.delete(sentMsg.id.id);
          return;
        }
        
        const correctOpt = q.options[q.correct_index];
        const explanation = q.answer_explanation || "No explanation provided.";
        
        await sentMsg.reply(
          `⏰ **Time's Up!**\n\n` +
          `✅ **Correct Answer:** ${correctOpt}\n\n` +
          `📚 **Explanation:** ${explanation}`
        );
        
        activePolls.delete(sentMsg.id.id);
        session.index++;
        
        // Next question after 3 seconds
        setTimeout(() => {
          runQuizStep(chat, chatId);
        }, 3000);
        
      } catch (e) {
        console.error('Poll timeout error:', e.message);
        activePolls.delete(sentMsg.id.id);
      }
    }, Math.max(5, session.timer) * 1000);
    
  } catch (e) {
    console.error('Error sending poll:', e.message);
    // Try to continue with next question
    session.index++;
    setTimeout(() => {
      runQuizStep(chat, chatId);
    }, 2000);
  }
}

// ==================== MESSAGE HANDLER ====================
function attachMessageHandler() {
  if (!client || typeof client.on !== 'function') return;
  
  // Message queue for concurrency control
  const processMessageWithQueue = async (msg) => {
    const chatId = msg.from;
    
    if (!messageQueues.has(chatId)) {
      messageQueues.set(chatId, Promise.resolve());
    }
    
    // Chain messages for same chat
    messageQueues.set(chatId, 
      messageQueues.get(chatId)
        .catch(() => {}) // Ignore errors in previous messages
        .then(() => handleSingleMessage(msg))
    );
    
    return messageQueues.get(chatId);
  };
  
  client.on('message', async (msg) => {
    try {
      await processMessageWithQueue(msg);
    } catch (e) {
      console.error('Message queue error:', e.message);
    }
  });
}

async function handleSingleMessage(msg) {
  try {
    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    
    // Check if mentioned in group (remove @bot mentions)
    let body = msg.body || '';
    const botMention = body.match(/@(\d+)/);
    const shouldReplyInGroup = isGroup && (botMention || body.includes('@'));
    
    if (isGroup && !shouldReplyInGroup) {
      return; // Ignore group messages without mention
    }
    
    // Remove mentions from prompt
    let prompt = sanitizeHtml(
      body.replace(/@\d+/g, '').trim(),
      { allowedTags: [], allowedAttributes: {} }
    );
    
    // Rate limiting
    if (!checkRateLimit(chat.id._serialized, msg.from)) {
      await msg.reply("⚠️ You're sending messages too quickly. Please wait a moment.");
      return;
    }
    
    // STOP QUIZ command
    if (prompt.toLowerCase().includes("stop quiz")) {
      if (quizSessions.has(chat.id._serialized)) {
        quizSessions.delete(chat.id._serialized);
        await msg.reply("🛑 Quiz stopped successfully.");
      } else {
        await msg.reply("No active quiz to stop.");
      }
      return;
    }
    
    // HELP command
    if (prompt.toLowerCase().includes("help") || prompt === "/help") {
      const helpText = `
🤖 *Siddhartha's AI Assistant Help*

*Basic Commands:*
• Just chat with me normally!
• Send a PDF/image and ask questions about it

*Quiz Commands:*
• "Give me a Polity quiz" - Topic-based quiz
• "5 questions every 30 seconds" - Custom timer
• "Stop quiz" - Stop current quiz

*Examples:*
• "Explain the Indian Constitution"
• "Give me 10 history MCQs"
• "Quiz on Geography with 5 questions every 20s"
• "Easy science quiz"

*Note:* In groups, mention me with @ to get my attention.

Made with ❤️ by Siddhartha Vardhan Singh
      `;
      await msg.reply(helpText);
      return;
    }
    
    // Identity check
    if (prompt.toLowerCase().match(/^(who are you|your name|what are you)/)) {
      await msg.reply("I am Siddhartha's AI Assistant, created by Siddhartha Vardhan Singh. I help with UPSC preparation and general knowledge quizzes!");
      return;
    }
    
    // Parse parameters
    let mediaPart = null;
    let timerSeconds = 30;
    let questionLimit = 5;
    let difficulty = "medium";
    let topic = "General Knowledge";
    
    // Timer parsing
    const timeMatch = prompt.match(/(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes)/i);
    if (timeMatch) {
      let val = parseInt(timeMatch[1]);
      if (timeMatch[2].toLowerCase().startsWith('m')) val *= 60;
      timerSeconds = Math.max(5, Math.min(val, 300)); // 5s to 5min
    }
    
    // Question count parsing
    const countMatch = prompt.match(/(\d+)\s*(q|ques|question|mcq|questions)/i);
    if (countMatch) {
      questionLimit = Math.max(1, Math.min(parseInt(countMatch[1]), 20));
    }
    
    // Difficulty parsing
    if (prompt.toLowerCase().includes("easy")) difficulty = "easy";
    else if (prompt.toLowerCase().includes("hard") || prompt.toLowerCase().includes("difficult")) difficulty = "hard";
    
    // Topic extraction
    const topicMatch = prompt.match(/\bquiz\s+(?:on\s+)?["']?([^"'\n]+?)["']?\b/i) || 
                      prompt.match(/\b["']?([^"'\n]+?)["']?\s+quiz\b/i);
    if (topicMatch && topicMatch[1]) {
      topic = topicMatch[1].trim();
    }
    
    // Media handling with size limit
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          // Check size (5MB limit)
          const sizeInBytes = Buffer.from(media.data, 'base64').length;
          if (sizeInBytes > 5 * 1024 * 1024) {
            await msg.reply("⚠️ File is too large (max 5MB). Please send a smaller file.");
            return;
          }
          
          if (media.mimetype === 'application/pdf' || media.mimetype.startsWith('image/')) {
            mediaPart = { 
              inlineData: { 
                data: media.data, 
                mimeType: media.mimetype 
              } 
            };
            console.log(`Media attached: ${media.mimetype} (${(sizeInBytes/1024).toFixed(1)}KB)`);
          }
        }
      } catch (e) {
        console.error('Media download error:', e.message);
      }
    }
    
    // Quoted message handling
    else if (msg.hasQuotedMsg) {
      try {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg && quotedMsg.hasMedia) {
          const media = await quotedMsg.downloadMedia();
          if (media) {
            const sizeInBytes = Buffer.from(media.data, 'base64').length;
            if (sizeInBytes <= 5 * 1024 * 1024) {
              mediaPart = { 
                inlineData: { 
                  data: media.data, 
                  mimeType: media.mimetype 
                } 
              };
            }
          }
        } else if (quotedMsg && quotedMsg.body) {
          prompt = `[Context from quoted message: "${quotedMsg.body}"]\n\nUser's request: ${prompt}`;
        }
      } catch (e) {
        console.error('Quoted message error:', e.message);
      }
    }
    
    if (!prompt && !mediaPart) {
      await msg.reply("Please send a message or file to process.");
      return;
    }
    
    // Check if this is a quiz request
    const isQuizRequest = /(?:\bquiz\b|\btest\b|\bmcq\b|\bquestions\b)/i.test(prompt) || 
                         (mediaPart && /\bmcq\b/i.test(prompt));
    
    // Get chat history for context
    let history = chatHistory.get(chat.id._serialized) || [];
    
    let success = false;
    let attempts = 0;
    const maxAttempts = 3;
    
    while (!success && attempts < maxAttempts) {
      attempts++;
      
      try {
        const model = getModel();
        let responseText = "";
        
        if (isQuizRequest) {
          // Quiz generation prompt
          const finalPrompt = `Generate a quiz with these specifications:
- Topic: "${topic}" (STRICTLY stick to this topic)
- Difficulty: ${difficulty}
- Number of questions: ${questionLimit}
- Format: Multiple choice with 4 options
- User request: "${prompt}"

OUTPUT ONLY JSON, no other text.`;
          
          const content = mediaPart ? [finalPrompt, mediaPart] : [finalPrompt];
          const result = await callWithTimeout(
            model.generateContent(content),
            45000, // 45 second timeout for quiz generation
            'Quiz generation timeout'
          );
          
          responseText = result.response?.text() || String(result);
          
        } else {
          // Normal chat
          const chatSession = model.startChat({ 
            history: history.slice(-6) // Last 3 exchanges
          });
          
          const result = await callWithTimeout(
            chatSession.sendMessage(prompt),
            30000, // 30 second timeout for chat
            'Chat response timeout'
          );
          
          responseText = result.response?.text() || String(result);
          updateHistory(chat.id._serialized, "user", prompt);
          updateHistory(chat.id._serialized, "model", responseText);
        }
        
        // Extract JSON if quiz request
        if (isQuizRequest) {
          const jsonCandidate = extractJSON(responseText);
          
          if (jsonCandidate) {
            try {
              const data = JSON.parse(jsonCandidate);
              let questions = [];
              
              if (data.quizzes && Array.isArray(data.quizzes)) {
                questions = data.quizzes;
              } else if (data.questions && Array.isArray(data.questions)) {
                questions = data.questions.map(q => ({
                  question: q.questionText || q.question,
                  options: q.options || q.choices,
                  correct_index: typeof q.correctAnswer === 'string' 
                    ? (q.options || q.choices).findIndex(opt => opt.trim() === q.correctAnswer.trim())
                    : (q.correctAnswer || q.correct_index || 0),
                  answer_explanation: q.explanation || q.answer_explanation || "No explanation provided."
                }));
              }
              
              if (questions.length > 0) {
                questions = questions.slice(0, questionLimit);
                
                await msg.reply(
                  `🎉 **Quiz Loaded Successfully!**\n\n` +
                  `📚 *Topic:* ${data.topic || topic}\n` +
                  `❓ *Questions:* ${questions.length}\n` +
                  `⏱️ *Timer:* ${timerSeconds} seconds per question\n\n` +
                  `Get ready! The quiz starts in 3 seconds...`
                );
                
                quizSessions.set(chat.id._serialized, {
                  questions: questions,
                  index: 0,
                  timer: timerSeconds,
                  active: true,
                  scores: new Map(),
                  creditedVotes: new Set(),
                  lastActivity: Date.now(),
                  topic: data.topic || topic
                });
                
                // Start quiz after delay
                setTimeout(() => {
                  runQuizStep(chat, chat.id._serialized);
                }, 3000);
                
              } else {
                await msg.reply("⚠️ Could not generate questions on this topic. Try a different topic or simplify your request.");
              }
              
            } catch (parseError) {
              console.error('JSON parse error:', parseError.message);
              
              if (attempts >= maxAttempts) {
                await msg.reply("⚠️ Error processing quiz request. The AI couldn't generate valid quiz data. Try rephrasing.");
              } else {
                continue; // Retry
              }
            }
          } else {
            // No JSON found in response
            if (attempts >= maxAttempts) {
              await msg.reply("⚠️ Could not generate quiz in the required format. Try asking like: 'Give me 5 polity MCQs'");
            } else {
              continue; // Retry
            }
          }
          
        } else {
          // Normal text response
          await msg.reply(responseText || "🤖 (No response generated)");
        }
        
        success = true;
        
      } catch (error) {
        console.error(`Attempt ${attempts} failed:`, error.message);
        
        const errMsg = String(error.message || error);
        
        if (/429|rate limit|quota/i.test(errMsg)) {
          disableCurrentKeyTemporary(10);
          
          if (attempts >= maxAttempts) {
            await msg.reply("⚠️ API rate limit reached. Please try again in a few minutes.");
          }
          
        } else if (/timeout/i.test(errMsg)) {
          if (attempts >= maxAttempts) {
            await msg.reply("⚠️ Request timed out. The AI is taking too long to respond. Please try again.");
          }
          
        } else {
          if (attempts >= maxAttempts) {
            await msg.reply("⚠️ Something went wrong while processing your request. Please try again later.");
          }
        }
        
        // Wait before retry
        if (!success && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }
    }
    
  } catch (err) {
    console.error('Message handling error:', err.message);
    try {
      await msg.reply("⚠️ An unexpected error occurred. Please try again.");
    } catch (e) {
      console.error('Failed to send error message:', e.message);
    }
  }
}

// ==================== UTILITY FUNCTIONS ====================

// Timeout wrapper for API calls
async function callWithTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Improved JSON extraction
function extractJSON(text) {
  if (!text) return null;
  
  // Try parsing the entire text first
  try {
    JSON.parse(text);
    return text;
  } catch (e) {
    // Not valid JSON, continue
  }
  
  // Try to find JSON in code blocks
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const codeBlockMatch = text.match(codeBlockRegex);
  
  if (codeBlockMatch) {
    try {
      const candidate = codeBlockMatch[1].trim();
      JSON.parse(candidate);
      return candidate;
    } catch (e) {
      // Not valid JSON in code block
    }
  }
  
  // Try to find JSON object with balanced braces
  const jsonRegex = /({[\s\S]*})/g;
  let match;
  const candidates = [];
  
  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      JSON.parse(match[1]);
      candidates.push(match[1]);
    } catch (e) {
      // Not valid JSON
    }
  }
  
  // Return the longest valid JSON candidate
  if (candidates.length > 0) {
    return candidates.reduce((a, b) => a.length > b.length ? a : b);
  }
  
  return null;
}

// ==================== GRACEFUL SHUTDOWN ====================
async function gracefulExit(signal) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  
  // 1. Stop all intervals
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  
  // 2. Save history
  console.log('💾 Saving chat history...');
  saveHistory();
  
  // 3. Destroy WhatsApp client
  if (client && typeof client.destroy === 'function') {
    console.log('👋 Disconnecting WhatsApp client...');
    try {
      await client.destroy();
      console.log('✅ WhatsApp client disconnected');
    } catch (e) {
      console.error('Error destroying client:', e.message);
    }
  }
  
  // 4. Close HTTP server
  console.log('🔒 Closing HTTP server...');
  server.close(() => {
    console.log('✅ Server closed. Goodbye!');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.log('⚠️ Forcing exit after timeout');
    process.exit(1);
  }, 10000);
}

// Signal handlers
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

// Error handlers
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message, err.stack);
  saveHistory(); // Try to save data
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Auto-save history every 5 minutes
setInterval(() => {
  if (chatHistory.size > 0) {
    saveHistory();
  }
}, 5 * 60 * 1000);

// Initialization complete
console.log('\n==========================================');
console.log('🤖 Siddhartha\'s AI Assistant');
console.log('📚 UPSC Quiz Companion Bot');
console.log('🔐 History: ' + (HISTORY_SECRET ? 'Encrypted' : 'Plain Text'));
console.log('🔑 Gemini Keys: ' + rawKeys.length);
console.log('🚀 Ready for deployment on Render');
console.log('==========================================\n');
