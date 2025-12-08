// Quiz Engine for Baileys WhatsApp Bot (ESM)
import pdfParse from 'pdf-parse';
import { promisify } from 'util';
const sleep = promisify(setTimeout);

// Enhanced Logging for quiz-engine
const getTimestamp = () => new Date().toISOString().split('T')[1].split('.')[0];
const log = (msg) => console.log(`[${getTimestamp()}] [QuizEngine] ${msg}`);
const error = (msg) => console.error(`[${getTimestamp()}] [QuizEngine] ${msg}`);
const warn = (msg) => console.warn(`[${getTimestamp()}] [QuizEngine] ${msg}`);

// --- GROQ CLIENT IMPLEMENTATION (Fetch Base) ---
// We use fetch directly to avoid npm dependency issues
class GroqClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = "https://api.groq.com/openai/v1/chat/completions";
    }

    async chat(messages, model = "llama-3.3-70b-versatile", temperature = 0.7) {
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
                // console.error(`❌ Groq API Error [${model}]: ${response.status} - ${errText}`);
                throw new Error(`Groq API Error (${response.status}): ${errText}`);
            }

            const data = await response.json();
            return data.choices[0].message.content;
        } catch (e) {
            // console.error(`❌ Groq Request Failed [${model}]:`, e.message);
            throw e;
        }
    }
}

export default class QuizEngine {
    constructor(apiKey) {
        if (!apiKey) {
            warn("Groq API Key not provided - Quiz features may not work!");
        }
        this.apiKey = apiKey;
        this.groq = new GroqClient(this.apiKey);

        // 🔥 BAILEYS-COMPATIBLE DATA STRUCTURES
        this.quizSessions = new Map();          // chatId → session data
        this.activePolls = new Map();          // pollMessageId → quiz data
        this.userVotes = new Map();            // userChatKey → vote data
        this.questionTimers = new Map();       // chatId → timeout
        this.quizStatus = new Map();           // chatId → status

        // Groq Models Configuration (Primary)
        this.GROQ_MODELS = [
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "gemma2-9b-it"
        ];

        // Gemini API Key for fallback
        this.geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2;

        log("✅ QuizEngine initialized for Baileys");
    }

    // ==================== BAILEYS POLL VOTE HANDLING ====================

    // 🎯 CORRECTED: Handle Baileys poll vote updates
    handleVote(voteData) {
        try {
            // console.log("🗳️ Received vote data:", JSON.stringify(voteData, null, 2));

            const { pollMessageId, voter, selectedOptionIndex, selectedOptions } = voteData;

            // Allow flexibility in voteData input (index or options array)
            let derivedIndex = selectedOptionIndex;

            // Get poll info first to help with index derivation
            const pollMessageKey = voteData.parentMessage?.id?.id || pollMessageId;
            const pollInfo = this.activePolls.get(pollMessageKey);

            if (!pollMessageKey || !voter) {
                // console.warn("⚠️ Invalid vote data - missing ID or voter");
                return;
            }

            if (!pollInfo) {
                // console.log(`❌ No active poll found for message ${pollMessageKey}`);
                return;
            }

            // If we have selectedOptions (name) but no index, try to find the index
            if (derivedIndex === undefined || derivedIndex === -1) {
                if (selectedOptions && selectedOptions.length > 0 && pollInfo.options) {
                    const optName = selectedOptions[0].name;
                    derivedIndex = pollInfo.options.findIndex(opt =>
                        opt === optName || opt.toLowerCase() === optName.toLowerCase()
                    );
                }
            }

            const { chatId, questionIndex, correctIndex } = pollInfo;

            // Get quiz session
            const session = this.quizSessions.get(chatId);
            if (!session || !session.active) {
                // console.log(`❌ No active session for ${chatId}`);
                return;
            }

            // Check if still on same question
            if (questionIndex !== session.currentQuestionIndex) {
                // console.log(`⏭️ Question index mismatch: ${questionIndex} vs ${session.currentQuestionIndex}`);
                return;
            }

            // Create unique key for this vote
            const voteKey = `${chatId}_${voter}_${questionIndex}`;

            // Prevent duplicate votes
            if (this.userVotes.has(voteKey)) {
                // console.log(`⚠️ Duplicate vote from ${voter}`);
                return;
            }

            // Store vote
            this.userVotes.set(voteKey, {
                voter,
                selectedIndex: derivedIndex,
                isCorrect: derivedIndex === correctIndex,
                timestamp: Date.now()
            });

            // Update score if correct
            if (derivedIndex === correctIndex) {
                if (!session.scores.has(voter)) {
                    session.scores.set(voter, 0);
                }
                session.scores.set(voter, session.scores.get(voter) + 1);
                console.log(`✅ ${voter} answered correctly! Score: ${session.scores.get(voter)}`);
            } else {
                console.log(`❌ ${voter} selected option ${derivedIndex}, correct was ${correctIndex}`);
            }

            // Update vote count
            if (!session.voteCounts.has(questionIndex)) {
                session.voteCounts.set(questionIndex, new Map());
            }
            const questionVotes = session.voteCounts.get(questionIndex);
            questionVotes.set(voter, derivedIndex);

            // console.log(`📊 Vote recorded: ${voter} → Option ${derivedIndex}`);

        } catch (error) {
            console.error("❌ Error in handleVote:", error);
        }
    }

    // ==================== QUIZ SESSION MANAGEMENT ====================

    // Start quiz with questions
    async startQuiz(chat, chatId, questions, topic = "General", timer = 30) {
        try {
            console.log(`🎮 Starting quiz for ${chatId}: ${questions.length} questions, ${timer}s timer`);

            // Clean up any existing session
            this.stopQuiz(chatId);

            // Create new session
            const session = {
                chatId,
                topic,
                questions: questions || [],
                currentQuestionIndex: 0,
                scores: new Map(),
                voteCounts: new Map(), // questionIndex -> Map(voter -> optionIndex)
                startTime: Date.now(),
                active: true,
                timer: timer,
                timeoutIds: []
            };

            this.quizSessions.set(chatId, session);
            this.quizStatus.set(chatId, 'active');

            // Send welcome message
            const welcomeMsg = `📚 *QUIZ STARTED!* 📚\n\n` +
                `📝 *Topic:* ${topic}\n` +
                `❓ *Questions:* ${questions.length}\n` +
                `⏱️ *Timer:* ${timer} seconds per question\n\n` +
                `🎯 *Instructions:*\n` +
                `• Tap to vote on poll\n` +
                `• Auto-proceeds after ${timer}s\n` +
                `• Results after each question\n\n` +
                `🚀 *Let's begin!*`;

            try {
                await chat.sendMessage(welcomeMsg);
            } catch (sendError) {
                console.warn("⚠️ Welcome message send error:", sendError.message);
            }

            // Start first question
            setTimeout(() => {
                this.sendNextQuestion(chat, chatId);
            }, 2000);

            return true;

        } catch (error) {
            console.error("❌ Error starting quiz:", error);
            return false;
        }
    }

    // Send question to group
    async sendNextQuestion(chat, chatId) {
        const session = this.quizSessions.get(chatId);
        if (!session || !session.active) return;

        // Check if quiz complete
        if (session.currentQuestionIndex >= session.questions.length) {
            await this.endQuiz(chat, chatId);
            return;
        }

        const question = session.questions[session.currentQuestionIndex];

        // Format question with emojis
        const questionNumber = session.currentQuestionIndex + 1;
        const totalQuestions = session.questions.length;

        const questionText =
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 *Question ${questionNumber}/${totalQuestions}*\n` +
            `📚 Topic: ${session.topic}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `${question.question}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎯 *Options:*\n`;

        // Create poll with options
        const pollOptions = question.options.map((opt, idx) => {
            const letter = String.fromCharCode(65 + idx); // A, B, C, D
            return `${letter}) ${opt}`;
        });

        try {
            // Send the question text first (optional, but good for context if poll truncates)
            // await chat.sendMessage(questionText);

            // Create poll
            // Use Baileys friendly poll name
            const pollName = `Q${questionNumber}: ${question.question.substring(0, 150)}`;
            const pollMessage = {
                poll: {
                    name: pollName,
                    values: pollOptions,
                    selectableCount: 1, // Single choice
                }
            };

            // Send poll and store message ID
            const sentMsg = await chat.sendMessage(pollMessage);

            if (sentMsg && sentMsg.key && sentMsg.key.id) {
                // Store poll info for vote tracking
                this.activePolls.set(sentMsg.key.id, {
                    chatId,
                    questionIndex: session.currentQuestionIndex,
                    correctIndex: question.correct_index,
                    options: pollOptions, // Store options as sent in poll
                    originalOptions: question.options,
                    pollMessageId: sentMsg.key.id
                });

                console.log(`📊 Poll sent: ${sentMsg.key.id} for Q${questionNumber}`);
            }

            // Set timer for next question
            const timerId = setTimeout(async () => {
                await this.showQuestionResults(chat, chatId);
            }, session.timer * 1000);

            session.timeoutIds.push(timerId);

        } catch (error) {
            console.error("❌ Error sending question:", error);
            // Try to continue anyway
            setTimeout(() => {
                session.currentQuestionIndex++;
                this.sendNextQuestion(chat, chatId);
            }, 2000);
        }
    }

    // Show results for current question
    async showQuestionResults(chat, chatId) {
        const session = this.quizSessions.get(chatId);
        if (!session || !session.active) return;

        const questionIndex = session.currentQuestionIndex;
        const question = session.questions[questionIndex];

        if (!question) {
            console.error("❌ Question not found at index:", questionIndex);
            session.currentQuestionIndex++;
            this.sendNextQuestion(chat, chatId);
            return;
        }

        // Get vote counts for this question
        let correctVotes = 0;
        let totalVotes = 0;

        // Count votes from memory
        const votesForQ = session.voteCounts.get(questionIndex);
        if (votesForQ) {
            totalVotes = votesForQ.size;
            for (const [voter, selectedIndex] of votesForQ) {
                if (selectedIndex === question.correct_index) {
                    correctVotes++;
                }
            }
        }

        // Calculate percentages
        const accuracy = totalVotes > 0 ? Math.round((correctVotes / totalVotes) * 100) : 0;
        const correctLetter = String.fromCharCode(65 + question.correct_index);

        // Create results message
        const resultsMsg =
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📊 *RESULTS: Q${questionIndex + 1}*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `✅ *Correct Answer:* ${correctLetter}) ${question.options[question.correct_index]}\n\n` +
            `📈 *Statistics:*\n` +
            `• Total Votes: ${totalVotes}\n` +
            `• Correct: ${correctVotes}\n` +
            `• Accuracy: ${accuracy}%\n\n` +
            `💡 *Explanation:*\n` +
            `${question.answer_explanation || "No explanation provided."}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━`;

        try {
            await chat.sendMessage(resultsMsg);

            // Show current leaderboard every 3 questions
            if ((questionIndex + 1) % 3 === 0 || (questionIndex + 1) === session.questions.length) {
                await this.showLeaderboard(chat, chatId, false);
            }

        } catch (error) {
            console.warn("⚠️ Error sending results:", error.message);
        }

        // Move to next question after delay
        setTimeout(() => {
            session.currentQuestionIndex++;
            this.sendNextQuestion(chat, chatId);
        }, 3000);
    }

    // Show leaderboard
    async showLeaderboard(chat, chatId, isFinal = false) {
        const session = this.quizSessions.get(chatId);
        if (!session) return;

        const title = isFinal ? "🏆 *FINAL LEADERBOARD* 🏆" : "📈 *CURRENT STANDINGS*";
        const sortedScores = Array.from(session.scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10); // Top 10

        let leaderboard =
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${title}\n` +
            `📚 Topic: ${session.topic}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        if (sortedScores.length === 0) {
            leaderboard += "No votes recorded yet.\n";
        } else {
            sortedScores.forEach(([voter, score], index) => {
                const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                const username = voter.split('@')[0] || voter.substring(0, 8);
                const totalPossible = session.currentQuestionIndex + (isFinal ? 0 : 0);
                const percentage = totalPossible > 0 ? Math.round((score / totalPossible) * 100) : 0;

                leaderboard += `${rankEmoji} ${username}: ${score} pts\n`;
            });
        }

        leaderboard += `\n━━━━━━━━━━━━━━━━━━━━━━━`;

        try {
            await chat.sendMessage(leaderboard);
        } catch (error) {
            console.warn("⚠️ Leaderboard send error:", error.message);
        }
    }

    // End quiz and show final results
    async endQuiz(chat, chatId) {
        const session = this.quizSessions.get(chatId);
        if (!session) return;

        session.active = false;
        this.quizStatus.set(chatId, 'completed');

        // Clear all timeouts
        session.timeoutIds.forEach(id => clearTimeout(id));

        // Show final leaderboard
        await this.showLeaderboard(chat, chatId, true);

        // Send detailed solutions
        // await this.sendDetailedSolutions(chat, chatId);

        // Cleanup
        this.cleanupSession(chatId);

        const endMsg =
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎉 *QUIZ COMPLETED!* 🎉\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📚 Topic: ${session.topic}\n` +
            `⏱️ Duration: ${Math.round((Date.now() - session.startTime) / 1000)}s\n` +
            `❓ Questions: ${session.questions.length}\n` +
            `👥 Participants: ${session.scores.size}\n\n` +
            `Thank you for participating! 🎯`;

        try {
            await chat.sendMessage(endMsg);
        } catch (error) {
            console.warn("⚠️ End message error:", error.message);
        }
    }

    // Send detailed solutions
    async sendDetailedSolutions(chat, chatId) {
        const session = this.quizSessions.get(chatId);
        if (!session) return;

        let solutions =
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📘 *DETAILED SOLUTIONS* 📘\n` +
            `📚 Topic: ${session.topic}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        session.questions.forEach((q, index) => {
            const correctLetter = String.fromCharCode(65 + q.correct_index);
            solutions +=
                `*Q${index + 1}.* ${q.question}\n` +
                `✅ ${correctLetter}) ${q.options[q.correct_index]}\n` +
                `💡 ${q.answer_explanation || "No explanation"}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        });

        // Split long messages
        const chunks = this.splitMessage(solutions, 2000);
        for (const chunk of chunks) {
            try {
                await chat.sendMessage(chunk);
            } catch (error) {
                console.warn("⚠️ Solutions chunk error:", error.message);
            }
        }
    }

    // Stop quiz
    stopQuiz(chatId) {
        const session = this.quizSessions.get(chatId);
        if (session) {
            session.active = false;
            session.timeoutIds.forEach(id => clearTimeout(id));
            this.cleanupSession(chatId);
            console.log(`🛑 Quiz stopped for ${chatId}`);
            return true;
        }
        return false;
    }

    // Cleanup session
    cleanupSession(chatId) {
        const session = this.quizSessions.get(chatId);
        if (session) {
            session.timeoutIds.forEach(id => clearTimeout(id));
        }
        this.quizSessions.delete(chatId);
        this.quizStatus.delete(chatId);

        // Clean active polls for this chat
        for (const [pollId, pollInfo] of this.activePolls) {
            if (pollInfo.chatId === chatId) {
                this.activePolls.delete(pollId);
            }
        }
    }

    // Check if quiz active
    isQuizActive(chatId) {
        const session = this.quizSessions.get(chatId);
        return !!(session && session.active);
    }

    // ==================== AI METHODS ====================

    // Try Groq first, then fallback to Gemini
    async callWithFallback(fnGenerator) {
        let lastError = null;

        // 1. Try Groq Models
        for (const model of this.GROQ_MODELS) {
            try {
                // console.log(`🔄 Trying Groq Model: ${model}`);
                return await fnGenerator(model, 'groq');
            } catch (e) {
                // console.warn(`⚠️ Groq ${model} Failed:`, e.message);
                lastError = e;
            }
        }

        // 2. Fallback to Google Gemini
        if (this.geminiKey) {
            try {
                // console.log(`🔄 Switching to Gemini 1.5 Flash...`);
                return await fnGenerator("gemini-1.5-flash", 'gemini');
            } catch (e) {
                // console.error(`❌ Gemini Fallback Failed:`, e.message);
                lastError = e;
            }
        }

        throw new Error("All AI models failed. Please try again later.");
    }

    // Unified chat interface
    async chat(messagesArray) {
        return this.callWithFallback(async (model, provider) => {
            if (provider === 'gemini') {
                // Simple Gemini Implementation for chat
                // Note: messagesArray is OpenAI format, might need conversion for Gemini if strictly typed
                // For now assuming the groq wrapper is primarily used or Gemini client handles similar structure
                // But since we don't have a Gemini definitions here, we might need one or reuse existing logic
                // For simplicity, we stick to Groq primarily, and basic Gemini fallback if feasible
                // This function mimics the unified interface
                throw new Error("Gemini Chat not fully implemented in this block");
            }
            return {
                response: {
                    text: async () => await this.groq.chat(messagesArray, model)
                }
            }
        });
    }

    // Generate Quiz from Topic
    async generateQuizFromTopic({ topic, qty = 10, difficulty = 'medium' }) {
        return this.callWithFallback(async (model, provider) => {
            const prompt = `Generate ${qty} multiple-choice questions on the topic: "${topic}".
            Difficulty: ${difficulty}.
            Each question must have exactly 4 options.
            Provide the correct answer index (0-3) and a brief explanation.

            Format each question as JSON:
            {
                "question": "Question text?",
                "options": ["Option A", "Option B", "Option C", "Option D"],
                "correct_index": 0,
                "answer_explanation": "Brief explanation"
            }

            Return as a JSON array.`;

            let text = "";
            if (provider === 'groq') {
                const messages = [
                    { role: 'system', content: 'You are a quiz generator for competitive exams like UPSC, SSC, Banking. Output valid JSON only.' },
                    { role: 'user', content: prompt }
                ];
                text = await this.groq.chat(messages, model);
            } else {
                // Gemini Fallback logic would go here
                throw new Error("Gemini generation skipped");
            }

            // Extract JSON from response
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                throw new Error('No valid JSON found in response');
            }

            const questions = JSON.parse(jsonMatch[0]);

            // Validate questions
            const validatedQuestions = questions.map((q, idx) => ({
                question: q.question || `Question ${idx + 1}`,
                options: q.options || ["Option A", "Option B", "Option C", "Option D"],
                correct_index: Math.min(3, Math.max(0, q.correct_index || 0)),
                answer_explanation: q.answer_explanation || "No explanation provided"
            }));

            console.log(`✅ Generated ${validatedQuestions.length} questions`);
            return validatedQuestions.slice(0, qty);
        });
    }

    async generateQuizFromPdfBuffer({ pdfBuffer, topic = 'PDF Content', qty = 10, difficulty = 'medium' }) {
        try {
            console.log(`📄 Generating quiz from PDF (${pdfBuffer.length} bytes)`);
            const data = await pdfParse(pdfBuffer);
            const text = data.text.substring(0, 15000); // Limit context

            const promptContext = `Context from PDF:\n${text}\n\nTask: Generate quiz based on this content.`;

            return await this.generateQuizFromTopic({ topic: promptContext, qty, difficulty });

        } catch (error) {
            console.error("❌ PDF quiz generation error:", error);
            return [];
        }
    }

    // ==================== UTILITY METHODS ====================

    splitMessage(text, maxLength) {
        const chunks = [];
        let start = 0;

        while (start < text.length) {
            let end = start + maxLength;

            if (end < text.length) {
                // Try to break at a newline
                const lastNewline = text.lastIndexOf('\n', end);
                if (lastNewline > start + (maxLength * 0.7)) {
                    end = lastNewline + 1;
                }
            }

            chunks.push(text.substring(start, end));
            start = end;
        }

        return chunks;
    }

    // Get quiz statistics
    getQuizStats(chatId) {
        const session = this.quizSessions.get(chatId);
        if (!session) return null;

        return {
            topic: session.topic,
            currentQuestion: session.currentQuestionIndex + 1,
            totalQuestions: session.questions.length,
            active: session.active,
            participants: session.scores.size,
            startTime: session.startTime,
            timer: session.timer
        };
    }

    // Get user scores
    getUserScores(chatId) {
        const session = this.quizSessions.get(chatId);
        if (!session) return [];

        return Array.from(session.scores.entries())
            .map(([voter, score]) => ({
                voter,
                score,
                username: voter.split('@')[0]
            }))
            .sort((a, b) => b.score - a.score);
    }
}
