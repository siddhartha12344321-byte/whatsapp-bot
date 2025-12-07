// Enhanced Logging Setup
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

const getTimestamp = () => new Date().toISOString().split('T')[1].split('.')[0];
console.log = function(...args) {
    originalLog(`[${getTimestamp()}]`, ...args);
};
console.error = function(...args) {
    originalError(`[${getTimestamp()}]`, ...args);
};
console.warn = function(...args) {
    originalWarn(`[${getTimestamp()}]`, ...args);
};

const { Client, LocalAuth, RemoteAuth, Poll, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const qrcode = require('qrcode-terminal');
const QRCodeImage = require('qrcode');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const express = require('express');
const fs = require('fs');
const sanitizeHtml = require('sanitize-html');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const pdfParse = require('pdf-parse');
const mongoose = require('mongoose');
const { Pinecone } = require('@pinecone-database/pinecone');
const googleTTS = require('google-tts-api');
const QuizEngine = require('./quiz-engine');

const indexName = 'whatsapp-bot';

// --- CONFIGURATION ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://amurag12344321_db_user:78mbO8WPw69AeTpt@siddharthawhatsappbot.wfbdgjf.mongodb.net/?appName=SiddharthaWhatsappBot";
const PINECONE_API_KEY = process.env.PINECONE_API_KEY || 'pcsk_4YGs7G_FB4bw1RbEejhHeiwEeL8wrU2vS1vQfFS2TcdhxJjsrehCHMyeFtHw4cHJkWPZvc';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-ea2ebc0b968a4c959f24340beeda43a3';

// Validate API Keys on startup
console.log("🔑 Checking required API keys...");
if (!GROQ_API_KEY) {
    console.warn("⚠️ GROQ_API_KEY not set in environment - some features may not work");
}
if (!PINECONE_API_KEY) {
    console.warn("⚠️ PINECONE_API_KEY not set in environment - some features may not work");
}
if (!DEEPSEEK_API_KEY) {
    console.warn("⚠️ DEEPSEEK_API_KEY not set - image analysis will not work. Add it to Render environment.");
}

// --- CONNECTIONS ---
// 1. MongoDB (Initialized in startClient)

// 2. Pinecone
let pc = null;
try {
    pc = new Pinecone({ apiKey: PINECONE_API_KEY });
    console.log("✅ Pinecone client initialized");
} catch (err) {
    console.error("⚠️ Pinecone initialization failed:", err.message);
}

// 3. Groq (Replaces Gemini)
const quizEngine = new QuizEngine(GROQ_API_KEY);
console.log("✅ Quiz engine initialized");

// Legacy Gemini Keys (Restored for safety of legacy functions)
const rawKeys = [
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY
].filter(Boolean);
let currentKeyIndex = 0;
let genAI = null; // Deprecated but defined

function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % rawKeys.length;
    genAI = new GoogleGenerativeAI(rawKeys[currentKeyIndex]);
    console.log(`🔑 Rotated to API Key Index: ${currentKeyIndex}`);
}

function getModel() {
    if (!genAI) rotateKey();
    return genAI.getGenerativeModel({
        model: "gemini-2.5-flash", // Latest stable flash model (fast and efficient)
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
    });
}

// Helper function to extract retry delay from error
function extractRetryDelay(error) {
    try {
        if (error.errorDetails) {
            for (const detail of error.errorDetails) {
                if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && detail.retryDelay) {
                    const delay = parseFloat(detail.retryDelay);
                    return isNaN(delay) ? 30 : Math.ceil(delay);
                }
            }
        }
        // Try to parse from error message
        const match = error.message?.match(/Please retry in ([\d.]+)s/);
        if (match) {
            return Math.ceil(parseFloat(match[1]));
        }
    } catch (e) {
        // Ignore parsing errors
    }
    return 30; // Default 30 seconds
}

// Check if error is a quota/quota exhaustion error
function isQuotaError(error) {
    if (!error) return false;
    const message = error.message || '';
    const status = error.status || '';
    return status === 429 ||
        message.includes('429') ||
        message.includes('quota') ||
        message.includes('Quota exceeded') ||
        message.includes('rate limit');
}

// Check if error is a 404 (model not found)
function isModelNotFoundError(error) {
    if (!error) return false;
    const status = error.status || '';
    const message = error.message || '';
    return status === 404 || message.includes('404') || message.includes('not found');
}

// --- DATA SCHEMAS ---
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    name: String,
    highScore: { type: Number, default: 0 },
    lastTopic: { type: String, default: 'General' },
    joined: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Chat History Schema for persistent memory
const chatHistorySchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    userId: { type: String, required: true },
    role: { type: String, required: true, enum: ['user', 'model'] },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

// Compound indexes for efficient queries (removed individual indexes to avoid duplicates)
chatHistorySchema.index({ chatId: 1, timestamp: -1 });
chatHistorySchema.index({ userId: 1, timestamp: -1 });
chatHistorySchema.index({ chatId: 1 }); // For quick chat lookup
chatHistorySchema.index({ userId: 1 }); // For user lookup

const ChatHistory = mongoose.model('ChatHistory', chatHistorySchema);

// Memory Summary Schema - stores important facts about users
const memorySchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    userId: { type: String, required: true },
    key: { type: String, required: true }, // e.g., "name", "preference", "goal"
    value: { type: String, required: true },
    context: { type: String }, // Additional context
    timestamp: { type: Date, default: Date.now },
    importance: { type: Number, default: 1 } // 1-10, higher = more important
}, { timestamps: true });

// Indexes (removed individual indexes from schema to avoid duplicates)
memorySchema.index({ chatId: 1, key: 1 }); // Compound index for chat+key lookup
memorySchema.index({ userId: 1 }); // For user memory lookup
memorySchema.index({ chatId: 1 }); // For chat memory lookup

const Memory = mongoose.model('Memory', memorySchema);

// --- MEMORY ---
const chatHistory = new Map(); // In-memory cache for current session
const rateLimit = new Map();

// Enhanced memory function - saves to MongoDB AND Pinecone
async function updateHistory(chatId, role, text, userId = null) {
    // Validate inputs
    if (!chatId || !role || !text || typeof text !== 'string') {
        console.warn("⚠️ Invalid updateHistory call:", { chatId, role, text: typeof text, textLength: text?.length });
        return; // Skip if invalid
    }

    // Clean and validate text
    const cleanText = String(text).trim();
    if (cleanText.length === 0) {
        console.warn("⚠️ Empty text in updateHistory, skipping save");
        return; // Don't save empty messages
    }

    // Update in-memory cache (for immediate use) - Use Groq-compatible format
    if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
    const history = chatHistory.get(chatId);
    // Store in Groq format: { role, content } instead of { role, parts }
    history.push({ role, content: cleanText });
    if (history.length > 20) history.shift(); // Keep last 20 turns in memory

    // Save to MongoDB for persistence (async, don't wait)
    if ((userId || chatId) && cleanText.length > 0) {
        const userIdValue = userId || chatId.split('@')[0] || 'unknown';
        const textToSave = cleanText.substring(0, 5000); // Limit text length

        ChatHistory.create({
            chatId: String(chatId),
            userId: String(userIdValue),
            role: String(role),
            text: textToSave,
            timestamp: new Date()
        }).catch(err => {
            console.error("Error saving chat history:", err.message || err);
        });
    }

    // Save important conversations to Pinecone for semantic search
    // Only save user messages and important model responses
    if (cleanText.length > 0 && (role === 'user' || (role === 'model' && cleanText.length > 100))) {
        const memoryId = `chat_${chatId}_${Date.now()}`;
        const memoryText = role === 'user'
            ? `User said: ${cleanText}`
            : `Bot responded: ${cleanText}`;

        // Save to Pinecone asynchronously (don't block)
        upsertToPinecone(memoryText, memoryId).catch(err =>
            console.error("Error saving to Pinecone:", err.message || err)
        );
    }
}

// Helper: Ensure messages are in Groq format (not Gemini parts format)
function normalizeMessagesForGroq(messages) {
    return messages.map(msg => {
        // If message has 'parts' property (old Gemini format), convert it
        if (msg.parts && !msg.content) {
            const partText = msg.parts.map(p => p.text || p.content || '').join('\n');
            return {
                role: msg.role,
                content: partText
            };
        }
        // If message is already in correct format, return as is
        return {
            role: msg.role,
            content: msg.content || ''
        };
    }).filter(m => m.content && m.content.trim().length > 0); // Remove empty messages
}

// Helper: Analyze image using DeepSeek-VL
async function analyzeImageWithDeepSeek(media) {
    if (!DEEPSEEK_API_KEY) {
        throw new Error("DeepSeek API key not configured");
    }

    try {
        // Convert media data to base64 if not already
        const base64Image = typeof media.data === 'string' ? media.data : Buffer.from(media.data).toString('base64');
        const mimeType = media.mimetype || 'image/jpeg';

        console.log("📡 Sending image to DeepSeek-VL for analysis...");

        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-vl',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'Please analyze this image and describe its contents in detail. If it contains math problems, text, or diagrams, describe them clearly.'
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${mimeType};base64,${base64Image}`
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error("DeepSeek API error:", errorData);
            throw new Error(`DeepSeek API error: ${response.status} - ${errorData?.error?.message || 'Unknown error'}`);
        }

        const data = await response.json();
        const description = data.choices?.[0]?.message?.content;

        if (!description) {
            throw new Error("No image description received from DeepSeek");
        }

        console.log("✅ Image analysis successful");
        return description;
    } catch (err) {
        console.error("❌ DeepSeek image analysis failed:", err.message);
        throw err;
    }
}

// Load chat history from MongoDB
async function loadChatHistory(chatId, limit = 20) {
    try {
        const history = await ChatHistory.find({ chatId: chatId })
            .sort({ timestamp: -1 })
            .limit(limit)
            .lean();

        // Convert to format expected by Gemini
        // Convert to format expected by Groq (OpenAI Compatible)
        const formattedHistory = history.reverse().map(h => ({
            role: h.role === 'user' ? 'user' : 'assistant', // Groq uses 'assistant'
            content: h.text
        }));

        // Update in-memory cache
        if (formattedHistory.length > 0) {
            chatHistory.set(chatId, formattedHistory);
        }

        return formattedHistory;
    } catch (err) {
        console.error("Error loading chat history:", err);
        return [];
    }
}

// Get relevant memories from Pinecone based on current conversation
async function getRelevantMemories(query, chatId = null, limit = 5) {
    try {
        const index = pc.index(indexName);
        const vector = await getEmbedding(query);
        if (!vector) return [];

        // Build filter for this chat if provided
        const filter = chatId ? { chatId: { $eq: chatId } } : {};

        const queryResponse = await index.query({
            vector: vector,
            topK: limit,
            includeMetadata: true,
            filter: Object.keys(filter).length > 0 ? filter : undefined
        });

        if (queryResponse.matches && queryResponse.matches.length > 0) {
            return queryResponse.matches
                .filter(m => m.score > 0.6) // Higher threshold for memories
                .map(m => m.metadata.text || m.metadata)
                .filter(Boolean);
        }
    } catch (e) {
        console.error("Error querying memories:", e);
    }
    return [];
}

// Extract and save important facts about user
async function extractAndSaveMemory(chatId, userId, conversation) {
    try {
        // Look for important information patterns
        const patterns = [
            { key: 'name', regex: /(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i },
            { key: 'goal', regex: /(?:goal|target|want to|preparing for)\s+(.+?)(?:\.|$)/i },
            { key: 'preference', regex: /(?:prefer|like|favorite|favourite)\s+(.+?)(?:\.|$)/i },
            { key: 'weakness', regex: /(?:weak|struggle|difficult|hard for me)\s+(.+?)(?:\.|$)/i },
            { key: 'strength', regex: /(?:good at|strong in|excel at)\s+(.+?)(?:\.|$)/i }
        ];

        for (const pattern of patterns) {
            const match = conversation.match(pattern.regex);
            if (match && match[1]) {
                const value = match[1].trim();
                if (value.length > 2 && value.length < 200) {
                    // Check if memory already exists
                    const existing = await Memory.findOne({ chatId, userId, key: pattern.key });
                    if (existing) {
                        existing.value = value;
                        existing.timestamp = new Date();
                        await existing.save();
                    } else {
                        await Memory.create({
                            chatId,
                            userId,
                            key: pattern.key,
                            value: value,
                            importance: pattern.key === 'name' ? 10 : 5
                        });
                    }
                }
            }
        }
    } catch (err) {
        console.error("Error extracting memory:", err);
    }
}

// Get user memories
async function getUserMemories(chatId, userId) {
    try {
        const memories = await Memory.find({
            $or: [{ chatId }, { userId }]
        })
            .sort({ importance: -1, timestamp: -1 })
            .limit(10)
            .lean();

        if (memories.length > 0) {
            return memories.map(m => `${m.key}: ${m.value}`).join('\n');
        }
    } catch (err) {
        console.error("Error getting user memories:", err);
    }
    return '';
}

function checkRateLimit(chatId) {
    const now = Date.now();
    const last = rateLimit.get(chatId) || 0;
    if (now - last < 1000) return false; // 1s cooldown
    rateLimit.set(chatId, now);
    return true;
}

// --- EXPRESS SERVER (HEALTH CHECK) ---
const app = express();
const port = process.env.PORT || 3000;
let qrCodeData = "";
let client; // Forward declaration

app.get('/', (req, res) => {
    let status = 'Initializing...';
    let color = 'orange';
    if (client && client.info && client.info.wid) {
        status = '✅ WhatsApp Connected (' + client.info.pushname + ')';
        color = 'green';
    } else if (qrCodeData) {
        status = '⚠️ Disconnected. <a href="/qr">Scan QR Code Now</a>';
        color = 'red';
    }
    res.send(`<html><head><meta http-equiv="refresh" content="10"></head><body style="font-family: sans-serif; text-align: center; padding-top: 50px;"><h1>🤖 Bot Status</h1><h2 style="color: ${color};">${status}</h2><p>Uptime: ${process.uptime().toFixed(0)} seconds</p><small>Auto-refreshes every 10s</small></body></html>`);
});
app.get('/qr', async (req, res) => {
    if (!qrCodeData) return res.send('<h2 style="color:orange;">⏳ Generating QR... Check back in 10s.</h2>');
    try {
        const url = await QRCodeImage.toDataURL(qrCodeData);
        res.send(`<div style="display:flex;flex-direction:column;justify-content:center;align-items:center;"><h1>Scan QR</h1><img src="${url}" style="border:5px solid #000; width:300px;"></div>`);
    } catch { res.send('Error generating QR.'); }
});
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- HELPER FUNCTIONS ---
async function updateUserProfile(userId, name, topic, scoreToAdd = 0) {
    try {
        let user = await User.findOne({ userId });
        if (!user) user = new User({ userId, name: name || 'Friend' });
        if (name) user.name = name;
        if (topic) user.lastTopic = topic;
        if (scoreToAdd > 0 && scoreToAdd > (user.highScore || 0)) user.highScore = scoreToAdd;
        await user.save();
        return user;
    } catch (e) { console.error("DB Error:", e); return { name: name || 'Friend', highScore: 0 }; }
}

const util = require('util');
const sleep = util.promisify(setTimeout);

// Updated model list with official model names (prioritized by stability and performance)
const MODELS = [
    "gemini-2.5-flash",                    // Priority 1: Latest stable flash (fastest, most efficient)
    "gemini-2.5-pro",                      // Priority 2: Latest stable pro (highest intelligence)
    "gemini-2.0-flash",                    // Priority 3: Previous stable flash version
    "gemini-flash-latest",                 // Priority 4: Latest flash alias (auto-updates)
    "gemini-pro-latest",                   // Priority 5: Latest pro alias (auto-updates)
    "gemini-2.0-flash-001",                // Priority 6: Specific flash version
    "gemini-2.5-flash-lite",               // Priority 7: Lite version (lower resource usage)
    "gemini-2.0-flash-lite"                // Priority 8: Previous lite version
];

async function callWithFallback(fnGenerator) {
    let lastError = null;
    let quotaExhausted = false;

    for (const modelName of MODELS) {
        try {
            // fnGenerator takes a modelName and returns a Promise
            return await fnGenerator(modelName);
        } catch (e) {
            lastError = e;
            const errorMsg = e.message || '';
            const errorStatus = e.status || '';

            console.warn(`⚠️ Model ${modelName} Failed: ${errorMsg.substring(0, 100)}`);

            // If it's a 404 (model not found), skip to next model immediately
            if (isModelNotFoundError(e)) {
                console.log(`⏭️  Model ${modelName} not available, trying next...`);
                continue;
            }

            // If it's a quota error, try rotating key and wait
            if (isQuotaError(e)) {
                console.log(`⏳ Quota error for ${modelName}, rotating key and waiting...`);
                rotateKey();
                const retryDelay = extractRetryDelay(e);
                console.log(`⏰ Waiting ${retryDelay}s before trying next model...`);
                await sleep(retryDelay * 1000);
                quotaExhausted = true;
                continue; // Try next model
            }

            // For other errors (400, 500, etc.), continue to next model
            if (modelName === MODELS[MODELS.length - 1]) {
                // Last model failed
                break;
            }
        }
    }

    // If we get here, all models failed
    if (quotaExhausted) {
        throw new Error("All API keys have exceeded quota. Please wait or upgrade your plan.");
    }
    throw lastError || new Error("All models failed");
}

// Keep simple retry for Embeddings as they have only 1 model
// Track failed embedding attempts to avoid spam
let embeddingFailCount = 0;
let lastEmbeddingErrorTime = 0;
const EMBEDDING_ERROR_COOLDOWN = 30000; // 30 seconds

async function callWithRetry(fn, retries = 0) { // Default 0 retries to avoid lag
    try {
        embeddingFailCount = 0; // Reset on success
        return await fn();
    } catch (e) {
        embeddingFailCount++;
        const now = Date.now();
        
        // Only log embedding errors once per cooldown period to avoid spam
        if (now - lastEmbeddingErrorTime > EMBEDDING_ERROR_COOLDOWN) {
            if (e.message?.includes('429') || e.message?.includes('quota')) {
                console.warn("⚠️ Gemini API Quota Exceeded - Bot continuing without embeddings");
            } else {
                console.warn("⚠️ Embedding Error (Fast Fail):", e.message?.substring(0, 80));
            }
            lastEmbeddingErrorTime = now;
        }
        throw e;
    }
}

async function getEmbedding(text) {
    // Disable embeddings if Gemini quota is exhausted
    if (embeddingFailCount > 3) {
        return null; // Return null instead of trying, avoids spam
    }
    
    try {
        return await callWithRetry(async () => {
            if (!genAI) rotateKey();
            const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const result = await model.embedContent(text);
            return result.embedding.values;
        });
    } catch (e) {
        // Silent fail on quota exceeded - don't spam logs
        if (!e.message?.includes('429')) {
            console.error("⚠️ Embedding Error (will retry later):", e.message?.substring(0, 80));
        }
        return null; // Fail gracefully without throwing
    }
}

async function upsertToPinecone(text, id) {
    // Skip if Pinecone not available
    if (!pc) return;
    
    try {
        const vector = await getEmbedding(text);
        if (!vector) return; // Silently skip if embedding failed
        
        const index = pc.index(indexName);
        await index.upsert([{ id: id, values: vector, metadata: { text: text.substring(0, 2000) } }]);
    } catch (e) { 
        // Only log Pinecone errors occasionally to avoid spam
        if (Math.random() < 0.1) { // Log 10% of errors
            console.warn("⚠️ Memory store error - continuing without persistence");
        }
    }
}

async function queryPinecone(queryText) {
    // Skip if Pinecone not available
    if (!pc) return null;
    
    try {
        const vector = await getEmbedding(queryText);
        if (!vector) return null; // Embedding failed, skip gracefully

        const index = pc.index(indexName);
        const queryResponse = await index.query({ vector: vector, topK: 3, includeMetadata: true });
        if (queryResponse.matches.length > 0) {
            return queryResponse.matches.filter(m => m.score > 0.5).map(m => m.metadata.text).join("\n\n");
        }
    } catch (e) { 
        // Silently fail - embeddings/Pinecone optional
        if (Math.random() < 0.05) { // Log only 5% to avoid spam
            console.warn("⚠️ Memory retrieval skipped - continuing without context");
        }
    }
    return null;
}
// Enhanced function to extract text from PDF for topic filtering
async function extractPdfText(pdfBuffer) {
    try {
        const data = await pdfParse(pdfBuffer);
        return data.text || '';
    } catch (e) {
        console.error("PDF Text Extraction Error:", e);
        return '';
    }
}

async function generateQuizFromPdfBuffer({ pdfBuffer, topic = 'General', qty = 10, difficulty = 'medium' }) {
    if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("PDF Buffer empty");

    // Extract PDF text first to help with topic filtering and validation
    let pdfText = '';
    let pdfTopics = [];
    try {
        pdfText = await extractPdfText(pdfBuffer);
        console.log(`📄 Extracted ${pdfText.length} characters from PDF`);

        // Check if PDF contains the requested topic (basic keyword matching)
        if (topic && topic !== 'General' && topic !== 'PDF Content' && pdfText.length > 0) {
            const topicLower = topic.toLowerCase();
            const pdfLower = pdfText.toLowerCase();
            const topicWords = topicLower.split(/\s+/);
            const foundMatches = topicWords.filter(word => word.length > 3 && pdfLower.includes(word));

            if (foundMatches.length === 0) {
                console.warn(`⚠️ Topic "${topic}" may not be found in PDF. Proceeding anyway...`);
            } else {
                console.log(`✅ Found topic keywords in PDF: ${foundMatches.join(', ')}`);
            }
        }
    } catch (e) {
        console.warn("Could not extract PDF text for topic filtering:", e.message);
        // Continue anyway - AI model can still process the PDF
    }

    // Enhanced prompt with explicit topic filtering instructions
    const topicFilter = topic && topic !== 'General' && topic !== 'PDF Content'
        ? `🚨 CRITICAL INSTRUCTIONS - READ CAREFULLY:

This PDF contains multiple topics. Your task:
1. Read the ENTIRE PDF from start to finish
2. Search for ALL questions related to: "${topic}"
3. Extract ONLY questions about "${topic}" - ignore all other topics
4. If you find questions about "${topic}", generate exactly ${qty} questions
5. If NO questions about "${topic}" exist in the PDF, return: {"quizzes": []}
6. DO NOT make up questions - only extract what exists in the PDF
7. DO NOT use questions from other topics

Topic to filter: "${topic}"
You MUST access and read the entire PDF content to find this topic.`
        : `Read the ENTIRE PDF carefully from start to finish. Extract questions from all topics in the PDF.`;

    const finalPrompt = `You are a quiz generator. ${topicFilter}

Generate exactly ${qty} multiple-choice questions from the PDF.
Difficulty level: ${difficulty}

REQUIREMENTS:
- Each question must have exactly 4 options (A, B, C, D)
- Provide clear, unambiguous correct answers
- Include brief explanations for each answer
- Questions MUST be relevant to topic: "${topic}"
- Read the PDF completely before generating questions

Output STRICT JSON format (no markdown, no code blocks):
{
  "type": "quiz_batch",
  "topic": "${topic}",
  "quizzes": [
    {
      "question": "Your question text here",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct_index": 0,
      "answer_explanation": "Brief explanation"
    }
  ]
}`;

    // Ensure PDF buffer is valid before sending
    if (!pdfBuffer || pdfBuffer.length === 0) {
        throw new Error("PDF buffer is empty or invalid");
    }

    // Validate PDF buffer size (max 20MB for Gemini API)
    const maxSize = 20 * 1024 * 1024; // 20MB
    if (pdfBuffer.length > maxSize) {
        throw new Error(`PDF is too large (${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB). Maximum size is 20MB.`);
    }

    // Convert PDF to base64
    let pdfBase64;
    try {
        pdfBase64 = pdfBuffer.toString('base64');
        if (!pdfBase64 || pdfBase64.length === 0) {
            throw new Error("Failed to convert PDF to base64");
        }
    } catch (e) {
        throw new Error(`PDF encoding error: ${e.message}`);
    }

    const contentParts = [
        { text: finalPrompt },
        { inlineData: { data: pdfBase64, mimeType: 'application/pdf' } }
    ];

    console.log(`📤 Sending PDF to AI (${pdfBuffer.length} bytes, ${(pdfBuffer.length / 1024).toFixed(2)}KB) with topic filter: "${topic}"`);
    let result;
    try {
        await callWithFallback(async (modelName) => {
            if (!genAI) rotateKey();
            const model = genAI.getGenerativeModel({ model: modelName });
            result = await model.generateContent(contentParts);
        });
    } catch (e) {
        const errorMsg = e.message || '';
        if (errorMsg.includes("quota") || errorMsg.includes("429")) {
            throw new Error("AI quota exceeded during quiz generation. Please try again later.");
        }
        throw new Error("AI service error during quiz generation: " + errorMsg.substring(0, 100));
    }

    // Enhanced JSON extraction with multiple attempts
    let jsonText = result.response.text();

    // Remove markdown code blocks if present
    jsonText = jsonText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    // Try to find JSON object
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        console.error("No JSON found in response:", jsonText.substring(0, 200));
        throw new Error("No valid JSON found in AI response");
    }

    let data;
    try {
        data = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
        console.error("JSON Parse Error:", parseError);
        console.error("Attempted to parse:", jsonMatch[0].substring(0, 200));
        throw new Error("Failed to parse quiz JSON from AI response");
    }

    let questions = data.quizzes || data.questions || [];

    if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error(`No questions generated for topic "${topic}". The PDF may not contain relevant content.`);
    }

    // Validate and normalize questions
    const validatedQuestions = questions.map((q, idx) => {
        let options = q.options || ["True", "False"];

        // Ensure exactly 4 options
        if (options.length !== 4) {
            console.warn(`Question ${idx + 1} has ${options.length} options, expected 4. Padding or trimming.`);
            while (options.length < 4) {
                options.push(`Option ${String.fromCharCode(68 + options.length)}`);
            }
            options = options.slice(0, 4);
        }

        let cIndex = -1;
        if (typeof q.correctAnswer === 'number') cIndex = q.correctAnswer;
        if (cIndex === -1 && typeof q.correctAnswer === 'string') {
            cIndex = options.findIndex(opt => opt.trim() === q.correctAnswer.trim());
        }
        if (cIndex === -1 && typeof q.correctAnswer === 'string' && q.correctAnswer.length === 1) {
            cIndex = q.correctAnswer.toUpperCase().charCodeAt(0) - 65;
        }
        if (cIndex === -1 && typeof q.correctAnswer === 'string') {
            cIndex = options.findIndex(opt => opt.toLowerCase().includes(q.correctAnswer.toLowerCase()));
        }
        if (cIndex < 0 || cIndex >= options.length) {
            console.warn(`Question ${idx + 1}: Invalid correct_index, defaulting to 0`);
            cIndex = 0;
        }

        return {
            question: (q.questionText || q.question || `Question ${idx + 1}`).trim(),
            options: options.map(opt => String(opt).trim()),
            correct_index: cIndex,
            answer_explanation: (q.explanation || q.answer_explanation || "No explanation provided").trim()
        };
    }).filter(q => q.question && q.question.length > 0); // Remove empty questions

    if (validatedQuestions.length === 0) {
        throw new Error(`No valid questions generated for topic "${topic}".`);
    }

    return validatedQuestions.slice(0, qty);
}

// --- CORE HANDLERS ---
async function handleVote(vote) {
    try {
        const msgId = vote.parentMessage.id.id;
        if (!activePolls.has(msgId)) return;
        const { correctIndex, chatId, questionIndex, originalOptions } = activePolls.get(msgId); // Deep Memory
        if (!quizSessions.has(chatId)) return;
        const session = quizSessions.get(chatId);
        if (questionIndex !== session.index) return;

        const uniqueVoteKey = `${session.index}_${vote.voter}`;
        if (session.creditedVotes.has(uniqueVoteKey)) return;
        session.creditedVotes.add(uniqueVoteKey);
        if (!session.scores.has(vote.voter)) session.scores.set(vote.voter, 0);

        try {
            // Options Check
            const options = originalOptions || session.questions[session.index].options;
            const normalize = (str) => (str ? String(str).trim().toLowerCase() : "");
            const correctText = normalize(options[correctIndex]);

            const isCorrect = vote.selectedOptions.some(opt => {
                const voteText = normalize(opt.name);
                return voteText === correctText || (voteText.length > 2 && correctText.includes(voteText)) || (correctText.length > 2 && voteText.includes(correctText));
            });

            console.log(`🗳️ Vote: ${vote.voter} | Expect: ${correctText} | Correct: ${isCorrect}`);
            if (isCorrect) session.scores.set(vote.voter, session.scores.get(vote.voter) + 1);
        } catch (e) { console.error("Vote Logic Error:", e); }
    } catch (e) { console.error("Fatal Vote Error:", e); }
}

async function sendMockTestSummaryWithAnswers(chat, chatId) {
    const session = quizSessions.get(chatId);
    if (!session) return;
    let template = `📘 *DETAILED SOLUTIONS* 📘\n*Topic:* ${session.topic}\n──────────────────\n\n`;
    session.questions.forEach((q, idx) => {
        template += `*Q${idx + 1}.* ${q.question}\n✅ ${q.options[q.correct_index]}\n💡 ${q.answer_explanation || ""}\n──────────────────\n\n`;
    });
    if (template.length > 2000) {
        const chunks = template.match(/.{1,2000}/g);
        for (const chunk of chunks) await chat.sendMessage(chunk);
    } else await chat.sendMessage(template);
}

async function runQuizStep(chat, chatId) {
    const session = quizSessions.get(chatId);
    if (!session || !session.active) return;

    if (session.index >= session.questions.length) {
        let report = `🏆 *RANK LIST* 🏆\n*Subject:* ${session.topic}\n──────────────────\n`;
        const sorted = [...session.scores.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) report += "No votes.";
        else sorted.forEach(([id, sc], i) => {
            report += `${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} @${id.split('@')[0]} : ${sc}/${session.questions.length}\n`;
        });
        report += `──────────────────`;
        await chat.sendMessage(report, { mentions: sorted.map(s => s[0]) });
        await sendMockTestSummaryWithAnswers(chat, chatId);

        // Cleanup: Clear all timeouts before deleting session
        if (session.timeoutIds) {
            session.timeoutIds.forEach(id => clearTimeout(id));
        }
        quizSessions.delete(chatId);
        return;
    }

    // Record the exact time when we start sending the question
    const questionStartTime = Date.now();

    const q = session.questions[session.index];
    const poll = new Poll(`Q${session.index + 1}: ${q.question}`, q.options, { allowMultipleAnswers: false });
    const sentMsg = await chat.sendMessage(poll);
    activePolls.set(sentMsg.id.id, { correctIndex: q.correct_index, chatId, questionIndex: session.index, originalOptions: q.options });

    // Calculate how long it took to send the message
    const messageSendTime = Date.now() - questionStartTime;

    // Calculate precise delay: timer duration minus time already spent
    // Ensure minimum 100ms delay to prevent issues
    const preciseDelay = Math.max(100, (session.timer * 1000) - messageSendTime);

    // Store timeout ID for potential cancellation
    const timeoutId = setTimeout(() => {
        if (!quizSessions.has(chatId)) return;
        activePolls.delete(sentMsg.id.id);
        session.index++;

        // Immediately proceed to next question without additional delay
        // This ensures precise timing
        runQuizStep(chat, chatId).catch(err => {
            console.error("Error in runQuizStep:", err);
        });
    }, preciseDelay);

    // Store timeout ID in session for potential cleanup
    if (!session.timeoutIds) session.timeoutIds = [];
    session.timeoutIds.push(timeoutId);
}

async function handleImageGeneration(msg, prompt) {
    await msg.reply("🎨 Drawing...").catch(() => {});
    try {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?nologo=true`;
        const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
        await msg.reply(media).catch(() => {});
    } catch (e) { console.error(e); await msg.reply("❌ Image Gen Failed").catch(() => {}); }
}

async function handleWebSearch(msg, query) {
    if (!process.env.TAVILY_API_KEY) return "No API Key";
    await msg.reply("🕵️‍♂️ Searching...").catch(() => {});
    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, search_depth: "basic", include_answer: true, max_results: 3 })
        });
        const data = await response.json();
        let txt = data.answer ? `📝 ${data.answer}\n` : "";
        if (data.results) data.results.forEach(r => txt += `- [${r.title}](${r.url})\n`);
        await msg.reply(txt || "No results").catch(() => {});
        return txt;
    } catch (e) { return null; }
}

// Function to extract poll/question content from quoted message
async function extractPollOrQuestionContent(msg) {
    try {
        // Check if message is a reply to another message
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            console.log("📋 Quoted message type:", quotedMsg.type);
            console.log("📋 Quoted message hasPoll:", quotedMsg.hasPoll);

            // Check if quoted message is a poll
            if (quotedMsg.hasPoll) {
                const poll = quotedMsg.poll;
                let pollContent = `Question: ${poll.name || 'No question text'}\n\nOptions:\n`;
                if (poll.options && poll.options.length > 0) {
                    poll.options.forEach((opt, idx) => {
                        pollContent += `${String.fromCharCode(65 + idx)}) ${opt.name || opt}\n`;
                    });
                }
                console.log("✅ Extracted poll content:", pollContent.substring(0, 100));
                return pollContent;
            }

            // Check if quoted message contains a question (MCQ format)
            const quotedBody = quotedMsg.body || '';
            console.log("📋 Quoted message body:", quotedBody.substring(0, 100));

            // Check for various question formats
            if (quotedBody.match(/^[Qq]\d*[.:]\s*.+\?/)) {
                return quotedBody;
            }

            // Check for MCQ format with options
            if (quotedBody.match(/[A-D][).]\s*.+/)) {
                return quotedBody;
            }

            // Return quoted message body if it looks like a question
            if (quotedBody.includes('?') && quotedBody.length > 10) {
                return quotedBody;
            }

            // Try to get poll from message metadata
            try {
                const quotedData = quotedMsg._data;
                if (quotedData && quotedData.poll) {
                    const poll = quotedData.poll;
                    let pollContent = `Question: ${poll.pollName || poll.name || 'No question text'}\n\nOptions:\n`;
                    if (poll.pollOptions && poll.pollOptions.length > 0) {
                        poll.pollOptions.forEach((opt, idx) => {
                            const optName = opt.optionName || opt.name || opt;
                            pollContent += `${String.fromCharCode(65 + idx)}) ${optName}\n`;
                        });
                    }
                    console.log("✅ Extracted poll from metadata:", pollContent.substring(0, 100));
                    return pollContent;
                }
            } catch (metaError) {
                console.log("⚠️ Could not extract poll from metadata:", metaError.message);
            }
        }

        // Check if current message itself is a poll
        if (msg.hasPoll) {
            const poll = msg.poll;
            let pollContent = `Question: ${poll.name || 'No question text'}\n\nOptions:\n`;
            if (poll.options && poll.options.length > 0) {
                poll.options.forEach((opt, idx) => {
                    pollContent += `${String.fromCharCode(65 + idx)}) ${opt.name || opt}\n`;
                });
            }
            return pollContent;
        }

        return null;
    } catch (e) {
        console.error("Error extracting poll/question:", e);
        return null;
    }
}

// Function to format exam tutor response - Attractive, concise, easy to read
function formatExamTutorResponse(questionContent, explanation, isPoll = false) {
    // Extract the correct answer (usually first line or marked)
    let correctAnswer = "";
    let mainExplanation = "";
    let keyPoints = [];

    // Parse explanation to extract structured parts
    const lines = explanation.split('\n').filter(line => line.trim().length > 0);

    // Find correct answer
    for (let i = 0; i < Math.min(5, lines.length); i++) {
        if (lines[i].match(/correct|answer|option [A-D]/i) || lines[i].match(/^[A-D][).]/)) {
            correctAnswer = lines[i].replace(/correct|answer|option/i, '').trim();
            if (correctAnswer.length > 100) correctAnswer = correctAnswer.substring(0, 100) + '...';
            break;
        }
    }
    if (!correctAnswer && lines.length > 0) {
        correctAnswer = lines[0].substring(0, 80);
    }

    // Extract main explanation (2-3 sentences, max 150 words)
    const sentences = explanation.split(/[.!?]+/).filter(s => s.trim().length > 15);
    mainExplanation = sentences.slice(0, 3).join('. ').trim();
    if (mainExplanation.length > 200) {
        mainExplanation = mainExplanation.substring(0, 200) + '...';
    }

    // Extract key points (bullet points or numbered)
    keyPoints = lines.filter(line =>
        line.trim().match(/^[•\-\*]/) ||
        line.trim().match(/^[0-9]+[.)]/) ||
        line.toLowerCase().includes('key') ||
        line.toLowerCase().includes('important')
    ).slice(0, 3);

    // Build attractive, concise response
    let response = `╔═══════════════════════════╗\n`;
    response += `║  🎓 *EXAM EXPLANATION*  ║\n`;
    response += `╚═══════════════════════════╝\n\n`;

    if (isPoll && questionContent) {
        response += `📋 *Question:*\n`;
        response += `\`\`\`${questionContent.substring(0, 150)}\`\`\`\n\n`;
    }

    response += `✅ *ANSWER:*\n`;
    response += `\`\`\`${correctAnswer || "See explanation below"}\`\`\`\n\n`;

    response += `💡 *EXPLANATION:*\n`;
    response += `${mainExplanation || explanation.substring(0, 200)}\n\n`;

    if (keyPoints.length > 0) {
        response += `🔑 *KEY POINTS:*\n`;
        keyPoints.forEach((point, idx) => {
            const cleanPoint = point.replace(/^[•\-\*\d+[.)]\s*/, '').trim();
            if (cleanPoint.length > 0 && cleanPoint.length < 80) {
                response += `  ${idx + 1}. ${cleanPoint}\n`;
            }
        });
        response += `\n`;
    }

    response += `━━━━━━━━━━━━━━━━━━━━\n`;
    response += `💪 *Keep practicing!* You've got this! 🚀`;

    return response;
}

async function handleMessage(msg) {
    try {
        console.log(`📩 RECEIVED: ${msg.body} from ${msg.from}`);
        const chat = await msg.getChat();

        // Check if user is replying to a poll/question
        let pollContent = null;
        try {
            pollContent = await extractPollOrQuestionContent(msg);
        } catch (pollErr) {
            console.warn("⚠️ Poll extraction error (continuing):", pollErr.message?.substring(0, 50));
        }
        const isPollReply = pollContent !== null;

        // STRICT GATEKEEPER
        if (chat.isGroup) {
            const isTagged = msg.mentionedIds.includes(client.info.wid._serialized) || msg.body.includes("@");
            const hasSession = quizEngine.isQuizActive(chat.id._serialized);

            // Allow poll replies even if not tagged
            if (!isTagged && !isPollReply) {
                if (!hasSession) {
                    console.log("⛔ Gatekeeper: Ignore Group msg (No Tag/Session/Poll)");
                    return;
                }
                if (!msg.body.trim().match(/^[a-dA-D1-4]$/) && !msg.body.toLowerCase().includes("stop")) {
                    console.log("⛔ Gatekeeper: Ignore Group msg (Invalid Input)");
                    return;
                }
            }
        }
        console.log("✅ Gatekeeper Passed");

        let prompt = sanitizeHtml(msg.body.replace(/@\S+/g, "").trim());
        const user = await updateUserProfile(msg.from, msg._data.notifyName);

        // Handle poll/question explanation request
        if (isPollReply || prompt.toLowerCase().includes("explain") || prompt.toLowerCase().includes("solution") || prompt.toLowerCase().includes("answer")) {
            await msg.reply("⚡ Quick analysis...").catch(() => {});

            // Combine poll content with user's request
            const fullPrompt = pollContent
                ? `You are an expert exam tutor. Explain this MCQ in MAX 100 words - be SUPER CONCISE:

${pollContent}

User request: ${prompt || "explain"}

Format (BE BRIEF):
✅ Answer: [Option and 1 sentence]
💡 Explanation: [2-3 short sentences max]
🔑 Key Point: [1 important concept]

Keep it SHORT, CLEAR, EASY TO READ. No long paragraphs!`
                : `As exam tutor, explain this in MAX 100 words - be CONCISE: ${prompt}`;

            // Get explanation from AI
            let explanation = "";
            try {
                const context = await queryPinecone(fullPrompt);

                try {
                    const messagesArray = [
                        {
                            role: "system",
                            content: `You are an exam tutor. CRITICAL RULES:
1. MAX 100 WORDS per response - BE CONCISE!
2. Use simple, clear language
3. Structure: Answer → Brief explanation → 1 key point
4. No long paragraphs - use short sentences
5. Be encouraging but brief
6. Focus on what matters most

Format:
✅ Answer: [Option + 1 sentence]
💡 Why: [2-3 short sentences]
🔑 Key: [1 important concept]

Keep it SHORT, CLEAR, ATTRACTIVE. Students want quick understanding, not essays!`
                        },
                        {
                            role: "user",
                            content: context ? `Relevant context from study materials:\n${context}\n\n${fullPrompt}` : fullPrompt
                        },
                        ...normalizeMessagesForGroq(chatHistory.get(chat.id._serialized) || [])
                    ];

                    const chatSession = await quizEngine.chat(messagesArray);

                    explanation = chatSession.response.text();
                } catch (e) { console.error("Groq Explainer Error:", e); throw e; }

                // Format the response as exam tutor explanation
                const formattedResponse = formatExamTutorResponse(pollContent, explanation, isPollReply);
                await msg.reply(formattedResponse).catch(() => {});

                // Extract and save memories
                const fullConversation = `${fullPrompt}\n${explanation}`;
                extractAndSaveMemory(
                    chat.id._serialized,
                    user.userId || chat.id._serialized.split('@')[0],
                    fullConversation
                ).catch(err => console.error("Memory extraction error:", err));

                await updateHistory(chat.id._serialized, "user", fullPrompt, user.userId || chat.id._serialized.split('@')[0]);
                await updateHistory(chat.id._serialized, "model", explanation, user.userId || chat.id._serialized.split('@')[0]);
                return;
            } catch (err) {
                console.error("Error generating explanation:", err);
                await msg.reply("⚠️ Could not generate explanation at the moment. Please try again in a moment.").catch(() => {});
                return;
            }
        }

        if (prompt.toLowerCase().startsWith("draw ")) return await handleImageGeneration(msg, prompt.replace("draw ", ""));
        if (prompt.toLowerCase().startsWith("search ")) return await handleWebSearch(msg, prompt.replace("search ", ""));

        // Priority 1: Topic Quiz Generation (Text-based)
        if (prompt.match(/\b(create|generate|make|start)\s+(?:a\s+)?(?:mock\s+)?(?:test|quiz|poll)/i) && !msg.hasMedia) {
            await msg.reply("🧠 Analyzing request and generating quiz...").catch(() => {});

            // 1. Parse Timer
            let timer = 30; // default 30 seconds
            const timePatterns = [
                /every\s+(\d+)\s*(second|sec|s|minute|min|m)/i,
                /timer\s*[:=]\s*(\d+)\s*(second|sec|s|minute|min|m)/i,
                /(\d+)\s*(second|sec|s|minute|min|m)\s*(?:timer|interval|per\s+question)/i,
                /(\d+)\s*(?:s|sec|second|seconds)/i,
                /(\d+)\s*(?:m|min|minute|minutes)/i
            ];
            for (const pattern of timePatterns) {
                const match = prompt.match(pattern);
                if (match) {
                    const value = parseInt(match[1]);
                    const unit = (match[2] || match[0]).toLowerCase();
                    if (unit.includes('m') || unit.includes('min')) timer = value * 60;
                    else timer = value;
                    timer = Math.max(5, Math.min(300, timer));
                    break;
                }
            }

            // 2. Parse Quantity
            let qty = 10; // default
            const qtyMatch = prompt.match(/(\d+)\s*(?:questions?|q|qty|quantity)/i);
            if (qtyMatch) qty = Math.max(1, Math.min(50, parseInt(qtyMatch[1])));

            // 3. Parse Difficulty
            let difficulty = 'medium';
            if (prompt.match(/\b(easy|simple|beginner)\b/i)) difficulty = 'easy';
            else if (prompt.match(/\b(hard|difficult|advanced|expert)\b/i)) difficulty = 'hard';

            // 4. Extract Topic
            let topic = "General Knowledge";
            const topicPatterns = [
                /topic\s+["']?([^"'\n]+)["']?/i,
                /on\s+["']?([^"'\n]+)["']?/i,
                /about\s+["']?([^"'\n]+)["']?/i,
                /quiz\s+(?:on|about|for)\s+["']?([^"'\n]+)["']?/i
            ];
            for (const pattern of topicPatterns) {
                const match = prompt.match(pattern);
                if (match && match[1]) {
                    topic = match[1].trim();
                    // Clean up the extracted topic if it accidentally grabbed the "with 3 questions" part
                    topic = topic.split(/\s+with\s+|\s+ensure\s+|\s+every\s+/i)[0].trim();
                    break;
                }
            }

            console.log(`🧠 Generating Topic Quiz: Topic="${topic}", Qty=${qty}, Timer=${timer}s`);

            try {
                const questions = await quizEngine.generateQuizFromTopic({
                    topic,
                    qty,
                    difficulty
                });

                if (questions.length === 0) {
                    await msg.reply(`❌ Could not generate questions for "${topic}". Please try a simpler topic.`).catch(() => {});
                    return;
                }

                await msg.reply(`✅ Generated ${questions.length} questions on "${topic}"\n⏱️ Timer: ${timer}s per question\n\n🎯 Starting quiz now!`).catch(() => {});
                try {
                    quizEngine.startQuiz(chat, chat.id._serialized, questions, topic, timer);
                } catch (quizErr) {
                    console.error("⚠️ Quiz start error:", quizErr.message?.substring(0, 80));
                    await msg.reply("⚠️ Quiz starting... please wait.").catch(() => {});
                }
            } catch (e) {
                console.error("Topic Quiz Error:", e);
                await msg.reply(`❌ Quiz Generation Error: ${e.message}`).catch(() => {});
            }
            return;
        }

        // Handle media files (PDF, images, etc.)
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            console.log(`📎 Media received: ${media.mimetype}, prompt: ${prompt.substring(0, 50)}`);

            // Handle images - describe them since Groq doesn't support vision
            if (media.mimetype.startsWith('image/')) {
                console.log("🖼️ Image detected - analyzing with DeepSeek-VL...");
                try {
                    const imageDescription = await analyzeImageWithDeepSeek(media);
                    console.log("📸 Image analysis complete");
                    
                    // Use the image description as additional context
                    const enhancedPrompt = `Image content: ${imageDescription}\n\nUser request: ${prompt}`;
                    
                    // Send to AI with enhanced context
                    try {
                        const response = await quizEngine.chat(enhancedPrompt, normalizeMessagesForGroq(chatHistory.get(chatId) || []));
                        if (response) {
                            updateHistory(chatId, 'user', enhancedPrompt);
                            updateHistory(chatId, 'assistant', response);
                            await msg.reply(response).catch(replyErr => {
                                console.warn("⚠️ Could not send reply:", replyErr.message?.substring(0, 50));
                            });
                        }
                    } catch (groqErr) {
                        console.error("❌ Groq error:", groqErr.message?.substring(0, 80));
                        await msg.reply("⚠️ Thinking... please wait a moment.").catch(() => {});
                    }
                    return;
                } catch (err) {
                    console.error("❌ Image analysis error:", err.message?.substring(0, 80));
                    await msg.reply("📷 Image received. Please describe what you need.").catch(() => {});
                    return;
                }
            }

            // Priority 1: PDF Quiz Generation
            if (media.mimetype === 'application/pdf' && (
                prompt.toLowerCase().includes("quiz") ||
                prompt.toLowerCase().includes("test") ||
                prompt.toLowerCase().includes("mock") ||
                prompt.toLowerCase().includes("question") ||
                prompt.toLowerCase().includes("generate")
            )) {
                await msg.reply("📄 Analyzing PDF and generating quiz...");
                const pdfBuffer = Buffer.from(media.data, 'base64');

                // Enhanced timer parsing - supports multiple formats
                let timer = 30; // default 30 seconds
                const timePatterns = [
                    /every\s+(\d+)\s*(second|sec|s|minute|min|m)/i,
                    /timer\s*[:=]\s*(\d+)\s*(second|sec|s|minute|min|m)/i,
                    /(\d+)\s*(second|sec|s|minute|min|m)\s*(?:timer|interval|per\s+question)/i,
                    /(\d+)\s*(?:s|sec|second|seconds)/i,
                    /(\d+)\s*(?:m|min|minute|minutes)/i
                ];

                for (const pattern of timePatterns) {
                    const match = prompt.match(pattern);
                    if (match) {
                        const value = parseInt(match[1]);
                        const unit = (match[2] || match[0]).toLowerCase();
                        if (unit.includes('m') || unit.includes('min')) {
                            timer = value * 60;
                        } else {
                            timer = value;
                        }
                        // Ensure minimum 5 seconds and maximum 300 seconds (5 minutes)
                        timer = Math.max(5, Math.min(300, timer));
                        break;
                    }
                }

                // Enhanced topic extraction - look for topic keywords
                let topic = "PDF Content"; // default
                const topicPatterns = [
                    /topic\s*[:=]\s*["']?([^"'\n]+)["']?/i,
                    /about\s+["']?([^"'\n]+)["']?/i,
                    /on\s+["']?([^"'\n]+)["']?/i,
                    /subject\s*[:=]\s*["']?([^"'\n]+)["']?/i,
                    /quiz\s+(?:on|about|for)\s+["']?([^"'\n]+)["']?/i
                ];

                for (const pattern of topicPatterns) {
                    const match = prompt.match(pattern);
                    if (match && match[1]) {
                        topic = match[1].trim();
                        // Remove common stop words
                        topic = topic.replace(/\b(quiz|on|about|for|the|a|an)\b/gi, '').trim();
                        if (topic.length > 0 && topic.length < 100) {
                            break;
                        }
                    }
                }

                // Extract quantity if specified
                let qty = 10; // default
                const qtyMatch = prompt.match(/(\d+)\s*(?:questions?|q|qty|quantity)/i);
                if (qtyMatch) {
                    qty = Math.max(1, Math.min(50, parseInt(qtyMatch[1])));
                }

                // Extract difficulty if specified
                let difficulty = 'medium';
                if (prompt.match(/\b(easy|simple|beginner)\b/i)) difficulty = 'easy';
                else if (prompt.match(/\b(hard|difficult|advanced|expert)\b/i)) difficulty = 'hard';

                // Validate PDF buffer before processing
                if (!pdfBuffer || pdfBuffer.length === 0) {
                    await msg.reply("❌ PDF file is empty or corrupted. Please send a valid PDF file.");
                    return;
                }

                console.log(`📄 Processing PDF: ${(pdfBuffer.length / 1024).toFixed(2)}KB, Topic: "${topic}", Timer: ${timer}s, Qty: ${qty}`);

                try {
                    await msg.reply(`🔍 Reading PDF and searching for "${topic}" questions...`);

                    const questions = await quizEngine.generateQuizFromPdfBuffer({
                        pdfBuffer,
                        topic: topic,
                        qty: qty,
                        difficulty: difficulty
                    });

                    if (questions.length === 0) {
                        await msg.reply(`❌ No questions found for topic "${topic}" in the PDF.\n\n💡 Try:\n• Different topic name\n• Check if PDF contains "${topic}" content\n• Use "PDF Content" for general quiz`);
                        return;
                    }

                    await msg.reply(`✅ Generated ${questions.length} questions on "${topic}"\n⏱️ Timer: ${timer}s per question\n\n🎯 Starting quiz now!`);
                    quizEngine.startQuiz(chat, chat.id._serialized, questions, topic, timer);
                } catch (e) {
                    console.error("PDF Quiz Generation Error:", e);
                    const errorMsg = e.message || 'Unknown error';

                    if (errorMsg.includes("empty") || errorMsg.includes("invalid")) {
                        await msg.reply(`❌ PDF Error: ${errorMsg}\n\nPlease send a valid PDF file.`);
                    } else if (errorMsg.includes("quota") || errorMsg.includes("429")) {
                        await msg.reply(`⚠️ API quota exceeded. Please wait a few minutes and try again.`);
                    } else if (errorMsg.includes("No questions")) {
                        await msg.reply(`❌ ${errorMsg}\n\n💡 Suggestions:\n• Try a different topic\n• Check if PDF contains the topic\n• Use general "PDF Content" topic`);
                    } else {
                        await msg.reply(`❌ Error: ${errorMsg}\n\nPlease check:\n• PDF is valid and readable\n• Topic exists in PDF\n• Try again in a moment`);
                    }
                }
                return;
            }

            // Priority 2: PDF Learning (save to Pinecone)
            if (media.mimetype === 'application/pdf' && prompt.toLowerCase().includes("learn")) {
                await msg.reply("🧠 Processing PDF for learning...");
                try {
                    const pdfBuffer = Buffer.from(media.data, 'base64');
                    const pdfText = await extractPdfText(pdfBuffer);
                    if (pdfText && pdfText.length > 0) {
                        // Split large PDFs into chunks for better storage
                        const chunks = pdfText.match(/.{1,2000}/g) || [pdfText];
                        for (let i = 0; i < Math.min(chunks.length, 10); i++) {
                            await upsertToPinecone(chunks[i], `PDF_Learn_${Date.now()}_${i}`);
                        }
                        await msg.reply(`✅ PDF content memorized! (${chunks.length} chunks saved)\n\nYou can now ask questions about this PDF content.`);
                    } else {
                        await msg.reply("❌ Could not extract text from PDF. Please ensure the PDF contains readable text (not just images).");
                    }
                } catch (e) {
                    console.error("PDF Learning Error:", e);
                    await msg.reply(`❌ Error processing PDF: ${e.message}`);
                }
                return;
            }

            // Handle other media types (text files, etc.)
            if (prompt.toLowerCase().includes("learn")) {
                await msg.reply("🧠 Memorizing...");
                try {
                    let text = "";
                    if (media.mimetype === 'text/plain') {
                        text = Buffer.from(media.data, 'base64').toString('utf-8');
                    }
                    if (text) {
                        await upsertToPinecone(text, "UserUpload_" + Date.now());
                        await msg.reply("✅ Memorized.");
                    } else {
                        await msg.reply("❌ Unsupported file type. Please send PDF or text files.");
                    }
                } catch (e) {
                    await msg.reply(`❌ Error: ${e.message}`);
                }
                return;
            }
        }

        // Handle manual quiz creation with custom questions
        if (prompt.toLowerCase().includes("create quiz") || prompt.toLowerCase().includes("manual quiz")) {
            if (quizEngine.isQuizActive(chat.id._serialized)) {
                await msg.reply("⚠️ Quiz already active. Type 'stop quiz' to end it first.");
                return;
            }

            // Parse timer from command
            let timer = 30;
            const timePatterns = [
                /timer\s*[:=]\s*(\d+)\s*(second|sec|s|minute|min|m)/i,
                /every\s+(\d+)\s*(second|sec|s|minute|min|m)/i,
                /(\d+)\s*(second|sec|s|minute|min|m)\s*(?:timer|interval)/i
            ];

            for (const pattern of timePatterns) {
                const match = prompt.match(pattern);
                if (match) {
                    const value = parseInt(match[1]);
                    const unit = match[2].toLowerCase();
                    timer = (unit.includes('m') || unit.includes('min')) ? value * 60 : value;
                    timer = Math.max(5, Math.min(300, timer));
                    break;
                }
            }

            await msg.reply(`📝 Please send your questions in the following format:\n\nQ1. Question text?\nA) Option 1\nB) Option 2\nC) Option 3\nD) Option 4\nCorrect: A\n\nOr send multiple questions separated by "---". Timer: ${timer}s per question.\n\nType "done" when finished, or "cancel" to cancel.`);

            // Store pending quiz creation state
            if (!chat.pendingQuiz) chat.pendingQuiz = { timer, questions: [], waitingForInput: true };
            return;
        }

        // Handle quiz cancellation
        // Handle quiz cancellation
        if (prompt.toLowerCase().includes("cancel quiz") || prompt.toLowerCase().includes("stop quiz")) {
            if (quizEngine.stopQuiz(chat.id._serialized)) {
                await msg.reply("✅ Quiz stopped.");
            } else {
                await msg.reply("ℹ️ No active quiz to stop.");
            }
            return;
        }

        // Handle general quiz requests - ONLY if explicitly requested
        const quizKeywords = ["daily polls", "start quiz", "general quiz", "quick quiz", "mock test"];
        const isExplicitQuizRequest = quizKeywords.some(keyword => prompt.toLowerCase().includes(keyword));

        if (isExplicitQuizRequest && !msg.hasMedia && !prompt.toLowerCase().includes("create") && !prompt.toLowerCase().includes("manual") && !prompt.toLowerCase().includes("pdf")) {
            if (quizEngine.isQuizActive(chat.id._serialized)) {
                await msg.reply("⚠️ Quiz already active. Type 'stop quiz' to end it first.").catch(() => {});
                return;
            }
            await msg.reply("🎲 Starting General Quiz...").catch(() => {});
            const questions = [
                { question: "What is the capital of India?", options: ["Mumbai", "Delhi", "Chennai", "Kolkata"], correct_index: 1, answer_explanation: "New Delhi is the capital." },
                { question: "2 + 2 = ?", options: ["3", "4", "5", "6"], correct_index: 1, answer_explanation: "Basic arithmetic." }
            ];
            try {
                quizEngine.startQuiz(chat, chat.id._serialized, questions, "General", 30);
            } catch (quizErr) {
                console.error("⚠️ General quiz start error:", quizErr.message?.substring(0, 80));
                await msg.reply("⚠️ Quiz starting... please wait.").catch(() => {});
            }
            return;
        }

        const isVoice = msg.type === 'ptt' || msg.type === 'audio' || prompt.includes("speak");

        console.log("🔍 Starting memory retrieval...");

        // Get multiple types of context with timeout (1s max)
        let ragContext = null, userMemories = null;
        try {
            const contextPromise = (async () => {
                const [pineconeCtx, userMem] = await Promise.all([
                    queryPinecone(prompt).catch(() => null),
                    getUserMemories(chat.id._serialized, user.userId || chat.id._serialized.split('@')[0]).catch(() => null)
                ]);
                return { pineconeCtx, userMem };
            })();

            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ pineconeCtx: null, userMem: null }), 1000));

            const result = await Promise.race([contextPromise, timeoutPromise]);
            ragContext = result.pineconeCtx;
            userMemories = result.userMem;
        } catch (err) {
            console.warn("⚠️ Memory retrieval timeout/error, continuing without context:", err.message);
        }

        // Combine all context
        let contextParts = [];
        if (ragContext) contextParts.push(`📚 Study Materials:\n${ragContext}`);
        if (userMemories) contextParts.push(`👤 User Information:\n${userMemories}`);

        const context = contextParts.length > 0 ? contextParts.join('\n\n') : null;
        console.log("📚 Memory context retrieved. Starting AI response...");

        let responseText = "";

        // Detect if it's an MCQ/poll question (needs UPSC formatting)
        const isMCQ = prompt.match(/\?/) && (
            prompt.match(/^[A-D][).]\s*.+/) ||
            prompt.match(/option [A-D]/i) ||
            prompt.match(/choose|select|which.*correct/i) ||
            isPollReply
        );

        try {
            console.log(`🤖 Using Groq (Llama 3) for response...`);

            // Enhance prompt based on question type
            let enhancedPrompt = prompt;
            if (isMCQ) {
                enhancedPrompt = `As an exam tutor, explain this MCQ/poll in MAX 100 words:\n${prompt}`;
            }

            const memoryContext = userMemories ? `\n\nRemember about this user: ${userMemories}` : '';

            const systemPrompt = isMCQ
                ? `You are an exam tutor for UPSC/SSC/government exams. For MCQs/polls, provide structured explanation in MAX 100 words:

Format for MCQs/Polls:
✅ Answer: [Option + 1 sentence]
💡 Explanation: [2-3 short sentences]
🔑 Key Point: [1 concept]

Be concise, clear, and exam-focused.${memoryContext}`
                : `You are a helpful AI assistant. Be natural, conversational, and dynamic. 
                
Guidelines:
- Answer naturally based on the question type
- For general questions: Be friendly and helpful
- For exam questions: Provide clear, structured answers
- Keep responses concise but comprehensive
- Be engaging and human-like
- Remember past conversations${memoryContext}

Don't force a rigid format - adapt to the question type naturally.`;

            const messagesArray = [
                { role: "system", content: systemPrompt },
                { role: "user", content: context ? `Relevant context:\n${context}\n\nUser's question: ${enhancedPrompt}` : enhancedPrompt },
                ...normalizeMessagesForGroq(chatHistory.get(chat.id._serialized) || [])
            ];

            const chatSession = await quizEngine.chat(messagesArray);

            responseText = chatSession.response.text();
            console.log(`✅ Groq response generated successfully`);
        } catch (err) {
            console.error("🔥 All Models Failed:", err);
            const errorMsg = err.message || '';

            // Provide user-friendly error messages
            if (errorMsg.includes("quota") || errorMsg.includes("Quota exceeded")) {
                await msg.reply("⚠️ API quota exceeded. Please wait a few minutes or contact the administrator.");
            } else if (errorMsg.includes("429")) {
                await msg.reply("⚠️ Rate limit reached. Please wait a moment and try again.");
            } else {
                await msg.reply("⚠️ AI service temporarily unavailable. Please try again in a moment.");
            }
            return;
        }

        console.log("📤 Sending Reply...");

        // Extract and save important memories from conversation
        const fullConversation = `${prompt}\n${responseText}`;
        extractAndSaveMemory(
            chat.id._serialized,
            user.userId || chat.id._serialized.split('@')[0],
            fullConversation
        ).catch(err => console.error("Memory extraction error:", err));

        // Save to persistent memory
        await updateHistory(chat.id._serialized, "user", prompt, user.userId || chat.id._serialized.split('@')[0]);
        await updateHistory(chat.id._serialized, "model", responseText, user.userId || chat.id._serialized.split('@')[0]);

        // Only format MCQs/polls in UPSC style, send others as-is
        if (isMCQ || isPollReply) {
            const formattedResponse = formatExamTutorResponse(null, responseText, isPollReply);
            try {
                await msg.reply(formattedResponse);
            } catch (sendErr) {
                console.error("⚠️ Failed to send formatted reply:", sendErr.message?.substring(0, 80));
                try {
                    await msg.reply("✅ Analysis complete (reply format failed)");
                } catch (fallbackErr) {
                    console.error("⚠️ Fallback reply also failed - browser connection may be unstable");
                }
            }
        } else {
            // Send natural response for general questions
            if (isVoice) {
                try {
                    const url = googleTTS.getAudioUrl(responseText, { lang: 'en', slow: false });
                    const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
                    await client.sendMessage(msg.from, media, { sendAudioAsVoice: true });
                } catch (voiceErr) { 
                    try {
                        await msg.reply(responseText);
                    } catch (textErr) {
                        console.error("⚠️ Failed to send voice and text reply - connection unstable");
                    }
                }
            } else {
                try {
                    await msg.reply(responseText);
                } catch (sendErr) {
                    console.error("⚠️ Failed to send text reply:", sendErr.message?.substring(0, 80));
                    if (sendErr.message?.includes("Target closed")) {
                        console.log("⚠️ Browser connection lost - bot will recover on next message");
                    }
                }
            }
        }
        console.log("✅ Reply attempt completed.");

    } catch (e) {
        console.error("🔥 FATAL MSG ERROR:", e.message?.substring(0, 100));
        if (e.message?.includes("Target closed")) {
            console.warn("⚠️ Puppeteer browser crashed - will restart on next message");
        }
    }
}

// --- INITIALIZATION ---
async function startClient() {
    console.log('🔄 Starting bot initialization...');

    // Connect to MongoDB (don't block if it fails, but log error)
    console.log('🔄 Connecting to MongoDB...');
    mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 10000, // 10 second timeout
        socketTimeoutMS: 45000,
    }).then(() => {
        console.log('🍃 MongoDB Connected Successfully');
    }).catch((err) => {
        console.error('⚠️ MongoDB Connection Warning:', err.message);
        console.log('⚠️ Continuing without MongoDB - some features may be limited');
    });

    let store;
    try {
        store = new MongoStore({ mongoose: mongoose });
        console.log('💾 MongoStore initialized');
    } catch (err) {
        console.error('⚠️ MongoStore Error:', err.message);
        console.log('⚠️ Using LocalAuth as fallback');
        // Fallback to LocalAuth if MongoStore fails
    }

    let puppetConfig = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    };

    if (process.platform === 'win32') {
        puppetConfig.executablePath = `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`;
        puppetConfig.headless = false;
    } else {
        try {
            puppetConfig.executablePath = await chromium.executablePath();
        } catch (err) {
            console.error('⚠️ Chromium path error:', err.message);
        }
    }

    try {
        client = new Client({
            authStrategy: store ? new RemoteAuth({ store: store, backupSyncIntervalMs: 60000 }) : new LocalAuth(),
            puppeteer: puppetConfig,
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
            }
        });

        client.on('qr', (qr) => {
            qrCodeData = qr;
            qrcode.generate(qr, { small: true });
            console.log("⚡ SCAN QR CODE TO CONNECT - QR Code displayed in browser at /qr");
        });

        client.on('ready', () => {
            console.log("✅✅✅ BOT IS READY! ✅✅✅");
            console.log("✅ WhatsApp Connected Successfully");
            console.log(`✅ Bot Name: ${client.info?.pushname || 'Unknown'}`);
            qrCodeData = "";
        });

        client.on('authenticated', () => {
            console.log("🔐 Authentication successful - Session restored/created");
        });

        client.on('auth_failure', (msg) => {
            console.error("❌ Authentication failed:", msg);
        });

        client.on('disconnected', (reason) => {
            console.log("⚠️ Client disconnected:", reason);
            console.log("⚠️ Attempting to reconnect...");
        });

        client.on('vote_update', (vote) => quizEngine.handleVote(vote));
        client.on('message', handleMessage);
        client.on('remote_session_saved', () => console.log('💾 Session saved to database'));

        console.log('🔄 Initializing WhatsApp connection (this may take 30-60 seconds on first run)...');
        
        // Initialize with timeout for better UX
        const initPromise = client.initialize();
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Initialization timeout after 120 seconds')), 120000)
        );

        try {
            await Promise.race([initPromise, timeoutPromise]);
            console.log('✅ Client initialization complete - Bot is ready!');
        } catch (timeoutErr) {
            console.error('❌ Initialization timeout:', timeoutErr.message);
            throw timeoutErr;
        }
    } catch (err) {
        console.error('❌ Failed to initialize WhatsApp client:', err.message);
        if (err.message.includes('Timeout')) {
            console.error('💡 Possible causes: Browser/Network issue, Invalid auth session');
        }
        throw err;
    }
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

// Startup sequence
console.log("\n" + "=".repeat(50));
console.log("🤖 WhatsApp Bot Initialization Starting...");
console.log("=".repeat(50) + "\n");

console.log("📋 Startup Sequence:");
console.log("1️⃣  Checking API keys...");
console.log("2️⃣  Initializing services...");
console.log("3️⃣  Connecting to MongoDB...");
console.log("4️⃣  Starting Express server (port 3000)...");
console.log("5️⃣  Initializing WhatsApp client...");
console.log("6️⃣  Waiting for authentication...\n");

console.log("🚀 Starting bot...\n");

startClient().catch(err => {
    console.error("\n" + "=".repeat(50));
    console.error("❌ FATAL: Bot failed to start");
    console.error("=".repeat(50));
    console.error("Error:", err.message);
    console.error("\n💡 Troubleshooting:");
    console.error("- Check API keys in environment variables");
    console.error("- Verify MongoDB connection");
    console.error("- Try running: node debug.js");
    console.error("- Check network connectivity\n");
    process.exit(1);
});

