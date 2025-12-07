// Debug script to test bot initialization
const fs = require('fs');
const path = require('path');

console.log("🔍 Diagnostic Check for WhatsApp Bot\n");

// Check for session files
console.log("📁 Checking for existing sessions...");
const sessionDir = path.join(__dirname, '.wwebjs_auth');
const localAuthDir = path.join(__dirname, '.wwebjs_cache');

if (fs.existsSync(sessionDir)) {
    console.log("✅ Found session directory:", sessionDir);
    const files = fs.readdirSync(sessionDir);
    console.log("   Files:", files.length > 0 ? files.join(', ') : "empty");
} else {
    console.log("❌ No session directory found - Will need QR code on first run");
}

if (fs.existsSync(localAuthDir)) {
    console.log("✅ Found local auth cache:", localAuthDir);
} else {
    console.log("ℹ️  No local auth cache");
}

// Check environment variables
console.log("\n🔑 Checking API Keys...");
const keys = ['GROQ_API_KEY', 'PINECONE_API_KEY', 'MONGODB_URI', 'GEMINI_API_KEY'];
keys.forEach(key => {
    const value = process.env[key];
    if (value) {
        const masked = value.substring(0, 5) + '...' + value.substring(value.length - 5);
        console.log(`✅ ${key}: ${masked}`);
    } else {
        console.log(`⚠️  ${key}: NOT SET`);
    }
});

// Check dependencies
console.log("\n📦 Checking Dependencies...");
const requiredPackages = [
    'whatsapp-web.js',
    'mongoose',
    '@pinecone-database/pinecone',
    'express'
];

requiredPackages.forEach(pkg => {
    try {
        require.resolve(pkg);
        console.log(`✅ ${pkg}: installed`);
    } catch (e) {
        console.log(`❌ ${pkg}: NOT installed - Run: npm install ${pkg}`);
    }
});

console.log("\n✅ Diagnostic complete!");
console.log("\n💡 Next steps:");
console.log("1. Run: node index.js");
console.log("2. If QR code appears, scan it from WhatsApp");
console.log("3. Wait for 'BOT IS READY' message");
console.log("4. Open http://localhost:3000 to see status");
