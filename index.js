const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Web Server to keep Render happy
app.get('/', (req, res) => res.send('<h1>🕵️‍♂️ Detective Mode Running... Check Logs!</h1>'));
app.listen(port, () => console.log(`Server running on port ${port}`));

// --- THE DETECTIVE TOOL ---
// This uses raw "fetch" to bypass the library completely
const API_KEY = process.env.GEMINI_API_KEY;

async function findMyModel() {
    console.log("\n\n==================================================");
    console.log("🕵️‍♂️ ASKING GOOGLE FOR YOUR MODEL NAMES...");
    console.log("==================================================\n");

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
        const data = await response.json();

        if (data.error) {
            console.error("❌ GOOGLE REFUSED:", JSON.stringify(data.error, null, 2));
        } else if (data.models) {
            console.log("✅ SUCCESS! HERE IS THE LIST OF MODELS YOU OWN:");
            console.log("------------------------------------------------");
            
            // Filter only models that can "generateContent" (Chat)
            const chatModels = data.models.filter(m => m.supportedGenerationMethods.includes("generateContent"));
            
            chatModels.forEach(m => {
                // We strip 'models/' from the name to make it easy to copy
                console.log(`👉 ${m.name.replace("models/", "")}`);
            });
            
            console.log("------------------------------------------------");
            console.log("📝 INSTRUCTION: Copy ONE name from above (e.g. gemini-1.5-flash-001) and save it!");
            console.log("==================================================\n\n");
        } else {
            console.log("⚠️ EMPTY RESPONSE:", data);
        }

    } catch (error) {
        console.error("❌ CONNECTION ERROR:", error.message);
    }
}

// Run the detective immediately
findMyModel();
