// --- CONFIGURATION ---
const OPENROUTER_API_KEY = "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";
const CUSTOM_API_KEY = "sk-IAI-infinite-key";

// The 10 chat models you talk with, looping continuously from 1 to 10 and back to 1
const CHAT_MODEL_POOL = [
    "meta-llama/llama-3.3-70b-instruct:free",     // AI 1
    "google/gemma-4-31b-it:free",                // AI 2
    "deepseek/deepseek-chat:free",               // AI 3
    "qwen/qwen-2.5-72b-instruct:free",           // AI 4
    "mistralai/mistral-large:free",              // AI 5
    "cohere/command-r-plus:free",                // AI 6
    "microsoft/phi-3-medium-128k-instruct:free", // AI 7
    "anthropic/claude-3-haiku:free",             // AI 8
    "openai/gpt-4o-mini:free",                   // AI 9
    "nvidia/nemotron-3-nano-30b-a3b:free"        // AI 10
];

// The 3 dedicated sniper models for background compression
const SNIPER_POOL = [
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "google/gemma-4-31b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free"
];

let chat_model_index = 0;
let sniper_index = 0;
let active_session_log = [];

// --- OPENROUTER API CALLER WITH RELIABLE CORS PROXY FALLBACK ---
async function call_openrouter(model_name, messages) {
    const targetUrl = "https://openrouter.ai/api/v1/chat/completions";
    // Uses corsproxy.io wrapper to prevent "Failed to fetch" browser CORS errors
    const url = "https://corsproxy.io/?" + encodeURIComponent(targetUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout guard

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": window.location.origin,
                "X-Title": "IAI Chat"
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
            throw new Error(`OpenRouter Error (${response.status}): ${errorText}`);
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
            content: "You are a context sniper. Compress the chat transcript into a high-density System Briefing keeping all rules, code, and variables intact." 
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
        // Fallback to next sniper model if first attempt fails
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
        content: "You are IAI (Infinite Artificial Intelligence), an advanced AI created by your developer, William. Speak naturally, engage directly in conversation, and answer thoroughly. Never output system safety logs, metadata, moderation flags, or status texts under any circumstances."
    };

    active_session_log.push(latest_user_message);

    let response_data = null;
    let attempts = 0;

    while (attempts < CHAT_MODEL_POOL.length) {
        const current_chat_model = CHAT_MODEL_POOL[chat_model_index];
        const full_messages = [system_instruction, ...active_session_log];

        try {
            response_data = await call_openrouter(current_chat_model, full_messages);
            break; // Success!
        } catch (e) {
            // If model fails or times out, trigger sniper compression and move to next model
            if (active_session_log.length > 0) {
                const failed_msg = active_session_log.pop();
                try {
                    const compressed_briefing = await run_sniper_compression(active_session_log);
                    active_session_log = [
                        { role: "system", content: `SYSTEM CONTEXT BRIEFING:\n${compressed_briefing}` },
                        failed_msg
                    ];
                } catch (sniperError) {
                    active_session_log.push(failed_msg);
                }
            }

            chat_model_index = (chat_model_index + 1) % CHAT_MODEL_POOL.length;
            attempts++;
        }
    }

    if (!response_data) {
        throw new Error("All chat models in the pool failed to respond. Check network connection or API key status.");
    }

    let clean_content = response_data.choices[0].message.content;
    clean_content = clean_content.replace(/^User Safety:.*$/gmi, '').trim();
    if (!clean_content) clean_content = "Hello William! How can I help you with your project today?";

    response_data.choices[0].message.content = clean_content;
    active_session_log.push(response_data.choices[0].message);

    return { status: 200, data: response_data };
}

