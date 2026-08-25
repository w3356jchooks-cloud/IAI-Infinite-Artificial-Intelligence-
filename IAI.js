// Environment / Config variables
const OPENROUTER_API_KEY = "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";
const CUSTOM_API_KEY = "sk-IAI-infinite-key";

const MAIN_MODEL = "openrouter/free";
const SNIPER_MODELS = [
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "google/gemma-4-31b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free"
];

let sniper_index = 0;
let active_session_log = [];

// Exact match: call_openrouter
async function call_openrouter(model_name, messages) {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    const headers = {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
    };
    const payload = {
        model: model_name,
        messages: messages
    };

    const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
    });

    if (response.status !== 200) {
        const errorText = await response.text();
        throw new Error(`OpenRouter Error (${response.status}): ${errorText}`);
    }

    return await response.json();
}

// Exact match: run_sniper_compression (with index rotation on error + recursive try)
async function run_sniper_compression(chat_history) {
    const selected_sniper = SNIPER_MODELS[sniper_index];
    
    const sniper_payload = [
        {
            role: "system", 
            content: "You are a context sniper. Compress the chat transcript into a high-density System Briefing keeping all rules, code, and variables."
        },
        {
            role: "user", 
            content: `TRANSCRIPT:\n${JSON.stringify(chat_history, null, 2)}`
        }
    ];

    try {
        const res = await call_openrouter(selected_sniper, sniper_payload);
        const summary = res.choices[0].message.content;
        sniper_index = (sniper_index + 1) % SNIPER_MODELS.length;
        return summary;
    } catch (e) {
        sniper_index = (sniper_index + 1) % SNIPER_MODELS.length;
        return await run_sniper_compression(chat_history);
    }
}

// Exact match: Health Check (/ , /health , /healthz)
function health_check() {
    return { status: "IAI (Infinite Artificial Intelligence) Gateway Active" };
}

// Exact match: handle_chat (POST /v1/chat/completions logic)
async function handle_chat(payload, authorizationHeader) {
    // Check Authorization Header
    if (!authorizationHeader || authorizationHeader !== `Bearer ${CUSTOM_API_KEY}`) {
        return { status: 401, data: { detail: "Unauthorized" } };
    }

    const incoming_messages = payload.messages || [];
    
    // Check empty payload
    if (incoming_messages.length === 0) {
        return { status: 400, data: { detail: "Empty payload" } };
    }

    const latest_user_message = incoming_messages[incoming_messages.length - 1];
    active_session_log.push(latest_user_message);

    try {
        const response_data = await call_openrouter(MAIN_MODEL, active_session_log);
        const ai_reply = response_data.choices[0].message;
        active_session_log.push(ai_reply);
        return { status: 200, data: response_data };

    } catch (e) {
        if (active_session_log.length > 0) {
            active_session_log.pop();
        }

        const briefing = await run_sniper_compression(active_session_log);

        active_session_log = [
            { role: "system", content: `SYSTEM CONTEXT BRIEFING:\n${briefing}` },
            latest_user_message
        ];

        const response_data = await call_openrouter(MAIN_MODEL, active_session_log);
        const ai_reply = response_data.choices[0].message;
        active_session_log.push(ai_reply);
        return { status: 200, data: response_data };
    }
}

