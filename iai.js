// --- CONFIGURATION ---
const OPENROUTER_API_KEY = "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";
const CUSTOM_API_KEY = "sk-IAI-infinite-key";

// Reliable 10-chat model pool
const CHAT_MODEL_POOL = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-2-9b-it:free",
    "qwen/qwen-2.5-coder-32b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
    "meta-llama/llama-3.1-8b-instruct:free",
    "google/gemma-2-27b-it:free",
    "qwen/qwen-2.5-7b-instruct:free",
    "deepseek/deepseek-r1:free",
    "gryphe/mythomax-l2-13b:free",
    "openchat/openchat-7b:free"
];

// Dedicated 3 sniper models for context compression
const SNIPER_POOL = [
    "meta-llama/llama-3.1-8b-instruct:free",
    "google/gemma-2-9b-it:free",
    "qwen/qwen-2.5-7b-instruct:free"
];

let chat_model_index = 0;
let sniper_index = 0;
let active_session_log = [];

// --- OPENROUTER API CALLER ---
async function call_openrouter(model_name, messages) {
    const url = "https://openrouter.ai/api/v1/chat/completions";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: model_name,
                messages: messages
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Status ${response.status}: ${errorText}`);
        }

        return await response.json();
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

// --- BACKGROUND SNIPER COMPRESSION ---
async function run_sniper_compression(chat_history) {
    const current_sniper = SNIPER_POOL[sniper_index];
    sniper_index = (sniper_index + 1) % SNIPER_POOL.length;

    const sniper_payload = [
        { 
            role: "system", 
            content: "You are a context sniper. Compress the transcript into a concise briefing keeping all rules, code, and key facts intact." 
        },
        { 
            role: "user", 
            content: `TRANSCRIPT:\n${JSON.stringify(chat_history, null, 2)}` 
        }
    ];

    try {
        const res = await call_openrouter(current_sniper, sniper_payload);
        return res.choices[0].message.content;
    } catch (e) {
        // Fallback to next sniper if first fails
        sniper_index = (sniper_index + 1) % SNIPER_POOL.length;
        const backup_sniper = SNIPER_POOL[sniper_index];
        const res = await call_openrouter(backup_sniper, sniper_payload);
        return res.choices[0].message.content;
    }
}

// --- MAIN CHAT HANDLER ---
async function handle_chat(payload, authorizationHeader) {
    if (!authorizationHeader || authorizationHeader !== `Bearer ${CUSTOM_API_KEY}`) {
        return { status: 401, data: { detail: "Unauthorized" } };
    }

    const incoming_messages = payload.messages || [];
    if (incoming_messages.length === 0) {
        return { status: 400, data: { detail: "Empty payload" } };
    }

    const latest_user_message = incoming_messages[incoming_messages.length - 1];

    const system_instruction = {
        role: "system",
        content: "You are IAI (Infinite Artificial Intelligence), created by William. Speak naturally and directly."
    };

    active_session_log.push(latest_user_message);

    let response_data = null;
    let attempts = 0;
    let lastError = null;

    // Continuous loop through models until one responds
    while (attempts < CHAT_MODEL_POOL.length) {
        const current_chat_model = CHAT_MODEL_POOL[chat_model_index];
        const full_messages = [system_instruction, ...active_session_log];

        try {
            response_data = await call_openrouter(current_chat_model, full_messages);
            break; // Success! Exit loop.
        } catch (e) {
            console.warn(`Model ${current_chat_model} failed (${e.message}). Swapping to next model...`);
            lastError = e;
            
            // Advance model index without letting sniper errors break the retry loop
            chat_model_index = (chat_model_index + 1) % CHAT_MODEL_POOL.length;
            attempts++;
        }
    }

    // Optional: Compress history in background if conversation gets long (> 10 messages)
    if (active_session_log.length > 10) {
        try {
            const compressed = await run_sniper_compression(active_session_log);
            active_session_log = [
                { role: "system", content: `CONTEXT BRIEFING:\n${compressed}` }
            ];
        } catch (e) {
            console.warn("Background sniper compression skipped:", e);
        }
    }

    if (!response_data) {
        // If all fail, reset session log message push so user can retry safely
        active_session_log.pop();
        throw new Error(`API Error: ${lastError ? lastError.message : "Connection failed"}`);
    }

    let clean_content = response_data.choices[0].message.content;
    clean_content = clean_content.replace(/^User Safety:.*$/gmi, '').trim();
    if (!clean_content) clean_content = "Hello William! How can I help you today?";

    response_data.choices[0].message.content = clean_content;
    active_session_log.push(response_data.choices[0].message);

    return { status: 200, data: response_data };
}

