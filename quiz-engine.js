const { Poll } = require('whatsapp-web.js');
const pdfParse = require('pdf-parse');
const util = require('util');
const sleep = util.promisify(setTimeout);

// --- GROQ CLIENT IMPLEMENTATION (Fetch Base) ---
// We use fetch directly to avoid npm dependency issues
class GroqClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = "https://api.groq.com/openai/v1/chat/completions";
    }

    async chat(messages, model = "llama3-70b-8192", temperature = 0.7) {
        if (!this.apiKey) throw new Error("Groq API Key is missing");

        try {
            const response = await fetch(this.baseUrl, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    temperature: temperature,
                    response_format: { type: "json_object" } // Force JSON for stability
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error(`❌ Groq API Error [${model}]: ${response.status} - ${errText}`);
                throw new Error(`Groq API Error (${response.status}): ${errText}`);
            }

            const data = await response.json();
            return data.choices[0].message.content;
        } catch (e) {
            console.error(`❌ Groq Request Failed [${model}]:`, e.message);
            throw e;
        }
    }
}

class QuizEngine {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.groq = new GroqClient(this.apiKey);

        // State
        this.quizSessions = new Map();
        this.activePolls = new Map();

        // Models Configuration
        // Note: Groq is fast, so we mainly use the best model.
        // Updated to latest supported models (Dec 2025)
        this.MODELS = [
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "gemma2-9b-it"
        ];
    }

    async callWithFallback(fnGenerator) {
        let lastError = null;
        for (const modelName of this.MODELS) {
            try {
                return await fnGenerator(modelName);
            } catch (e) {
                lastError = e;
                console.warn(`⚠️ Model ${modelName} failed: ${e.message}. Retrying...`);
                if (e.message?.includes('429')) {
                    await sleep(1000); // Wait on rate limit
                    continue;
                }
                if (modelName === this.MODELS[this.MODELS.length - 1]) break;
            }
        }
        console.error("🚨 CRITICAL: All AI Models Failed. Last Error:", lastError);
        throw lastError || new Error("All models failed in QuizEngine");
    }

    // --- PDF HELPERS ---
    async extractPdfText(pdfBuffer) {
        try {
            const data = await pdfParse(pdfBuffer);
            return data.text || '';
        } catch (e) {
            console.error("PDF Text Extraction Error:", e);
            return '';
        }
    }

    // --- GENERAL CHAT (New) ---
    async chat(messages) {
        return await this.callWithFallback(async (modelName) => {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: messages,
                    temperature: 0.7
                    // No response_format for general chat to allow free text
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Chat API Error (${response.status}): ${errText}`);
            }

            const data = await response.json();
            return { response: { text: () => data.choices[0].message.content } }; // Mock Gemini interface
        });
    }

    async generateQuizFromPdfBuffer({ pdfBuffer, topic = 'General', qty = 10, difficulty = 'medium' }) {
        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("PDF Buffer empty");

        // Extract text (Groq cannot read PDF files directly)
        let pdfText = await this.extractPdfText(pdfBuffer);
        // Truncate if too huge (Groq window is ~8k-32k tokens depending on model)
        // 32k tokens is roughly 120k characters. safe limit 100k
        if (pdfText.length > 100000) {
            console.warn("PDF too large, truncating to 100k chars for Groq");
            pdfText = pdfText.substring(0, 100000) + "...[truncated]";
        }

        const topicFilter = topic && topic !== 'General' && topic !== 'PDF Content'
            ? `🚨 CRITICAL: Extract ONLY questions about "${topic}". If none, return empty JSON.`
            : `Extract questions from all topics.`;

        const systemPrompt = `You are a quiz generator. Output strictly JSON.`;
        const userPrompt = `Context:
${pdfText}

Instructions:
${topicFilter}
Generate exactly ${qty} multiple-choice questions.
Difficulty: ${difficulty}

Format:
{
  "type": "quiz_batch",
  "topic": "${topic}",
  "quizzes": [
    {
      "question": "Question",
      "options": ["A", "B", "C", "D"],
      "correct_index": 0,
      "answer_explanation": "Explanation"
    }
  ]
}`;

        return await this._generateAndParse(systemPrompt, userPrompt, topic);
    }

    async generateQuizFromTopic({ topic, qty = 10, difficulty = 'medium' }) {
        if (!topic) throw new Error("Topic is required");

        const systemPrompt = `You are a quiz generator. Output strictly JSON.`;
        const userPrompt = `Instructions:
Create a quiz about "${topic}".
Generate exactly ${qty} multiple-choice questions.
Difficulty: ${difficulty}

Format:
{
  "type": "quiz_batch",
  "topic": "${topic}",
  "quizzes": [
    {
      "question": "Question",
      "options": ["A", "B", "C", "D"],
      "correct_index": 0,
      "answer_explanation": "Explanation"
    }
  ]
}`;

        return await this._generateAndParse(systemPrompt, userPrompt, topic);
    }

    async _generateAndParse(systemPrompt, userPrompt, topic) {
        let resultText;
        try {
            await this.callWithFallback(async (modelName) => {
                const response = await this.groq.chat([
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ], modelName);
                resultText = response;
            });
        } catch (e) {
            throw new Error("AI Service Error: " + e.message);
        }

        const jsonText = resultText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No valid JSON found in AI response");

        const data = JSON.parse(jsonMatch[0]);
        let questions = data.quizzes || data.questions || [];

        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error(`No questions generated for topic "${topic}".`);
        }

        // Normalize questions (Logic copied from index.js)
        return questions.map((q, idx) => {
            let options = q.options || ["True", "False"];
            while (options.length < 4) options.push(`Option ${String.fromCharCode(68 + options.length)}`);
            options = options.slice(0, 4);

            let cIndex = -1;
            if (typeof q.correctAnswer === 'number') cIndex = q.correctAnswer;
            if (cIndex === -1 && typeof q.correctAnswer === 'string') cIndex = options.findIndex(opt => opt.trim() === q.correctAnswer.trim());
            if (cIndex === -1 && typeof q.correctAnswer === 'string' && q.correctAnswer.length === 1) cIndex = q.correctAnswer.toUpperCase().charCodeAt(0) - 65;
            if (cIndex === -1 && typeof q.correctAnswer === 'string') cIndex = options.findIndex(opt => opt.toLowerCase().includes(q.correctAnswer.toLowerCase()));
            if (cIndex < 0 || cIndex >= options.length) cIndex = 0;

            return {
                question: (q.questionText || q.question || `Question ${idx + 1}`).trim(),
                options: options.map(opt => String(opt).trim()),
                correct_index: cIndex,
                answer_explanation: (q.explanation || q.answer_explanation || "No explanation provided").trim()
            };
        });
    }

    async handleVote(vote) {
        try {
            const msgId = vote.parentMessage.id.id;
            if (!this.activePolls.has(msgId)) return;
            const { correctIndex, chatId, questionIndex, originalOptions } = this.activePolls.get(msgId); // Deep Memory
            if (!this.quizSessions.has(chatId)) return;
            const session = this.quizSessions.get(chatId);
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

    async sendMockTestSummaryWithAnswers(chat, chatId) {
        const session = this.quizSessions.get(chatId);
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

    async runQuizStep(chat, chatId) {
        const session = this.quizSessions.get(chatId);
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
            await this.sendMockTestSummaryWithAnswers(chat, chatId);

            // Cleanup
            if (session.timeoutIds) session.timeoutIds.forEach(id => clearTimeout(id));
            this.quizSessions.delete(chatId);
            return;
        }

        const questionStartTime = Date.now();
        const q = session.questions[session.index];
        const poll = new Poll(`Q${session.index + 1}: ${q.question}`, q.options, { allowMultipleAnswers: false });
        // NOTE: chat.sendMessage might fail if chat is not valid, but we assume it's passed correctly
        const sentMsg = await chat.sendMessage(poll);
        this.activePolls.set(sentMsg.id.id, { correctIndex: q.correct_index, chatId, questionIndex: session.index, originalOptions: q.options });

        const messageSendTime = Date.now() - questionStartTime;
        const preciseDelay = Math.max(100, (session.timer * 1000) - messageSendTime);

        const timeoutId = setTimeout(() => {
            if (!this.quizSessions.has(chatId)) return;
            this.activePolls.delete(sentMsg.id.id);
            session.index++;

            // Recursive call for next step
            this.runQuizStep(chat, chatId).catch(err => console.error("Error in runQuizStep:", err));
        }, preciseDelay);

        if (!session.timeoutIds) session.timeoutIds = [];
        session.timeoutIds.push(timeoutId);
    }

    // --- INTERFACE ---

    startQuiz(chat, chatId, questions, topic = "General", timer = 30) {
        if (this.quizSessions.has(chatId)) {
            return false; // Already active
        }

        this.quizSessions.set(chatId, {
            questions,
            index: 0,
            timer,
            active: true,
            scores: new Map(),
            creditedVotes: new Set(),
            topic: topic,
            timeoutIds: []
        });

        this.runQuizStep(chat, chatId);
        return true;
    }

    stopQuiz(chatId) {
        if (this.quizSessions.has(chatId)) {
            const session = this.quizSessions.get(chatId);
            if (session.timeoutIds) session.timeoutIds.forEach(id => clearTimeout(id));
            session.active = false;
            this.quizSessions.delete(chatId);
            return true;
        }
        return false;
    }

    isQuizActive(chatId) {
        return this.quizSessions.has(chatId);
    }
}

module.exports = QuizEngine;
