// --- CONFIGURATION ---
const OPENROUTER_API_KEY = "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";
const CUSTOM_API_KEY = "sk-IAI-infinite-key";

// Switch to a specific reliable model to avoid raw safety outputs from openrouter/free
const MAIN_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

const SNIPER_MODELS = [
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "google/gemma-4-31b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free"
];

let sniper_index = 0;
let active_session_log = [];

// --- OPENROUTER API CALLER ---
async function call_openrouter(model_name, messages) {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    const headers = {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
    };
    const payload = { model: model_name, messages: messages };

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

// --- CONTEXT SNIPER COMPRESSION ---
async function run_sniper_compression(chat_history) {
    const selected_sniper = SNIPER_MODELS[sniper_index];
    const sniper_payload = [
        { 
            role: "system", 
            content: "You are a context sniper. Compress the chat transcript into a high-density System Briefing keeping all key rules, context, and data." 
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

    // Identity prompt to set persona and block metadata text
    const system_instruction = {
        role: "system",
        content: "You are IAI (Infinite Artificial Intelligence), an advanced AI created by your developer, William. Speak naturally, engage directly in conversation, and answer thoroughly. Never output system safety logs, metadata, moderation flags, or status texts under any circumstances."
    };

    const full_messages = [system_instruction, ...active_session_log, latest_user_message];

    try {
        const response_data = await call_openrouter(MAIN_MODEL, full_messages);
        
        let clean_content = response_data.choices[0].message.content;
        
        // Strip out raw safety headers if an upstream provider still prepends them
        clean_content = clean_content.replace(/^User Safety:.*$/gmi, '').trim();

        if (!clean_content) {
            clean_content = "Hello! How can I help you today?";
        }

        response_data.choices[0].message.content = clean_content;
        
        active_session_log.push(latest_user_message);
        active_session_log.push(response_data.choices[0].message);

        return { status: 200, data: response_data };
    } catch (e) {
        if (active_session_log.length > 0) active_session_log.pop();

        const briefing = await run_sniper_compression(active_session_log);
        active_session_log = [
            system_instruction,
            { role: "system", content: `SYSTEM CONTEXT BRIEFING:\n${briefing}` },
            latest_user_message
        ];

        const response_data = await call_openrouter(MAIN_MODEL, active_session_log);
        
        let clean_content = response_data.choices[0].message.content;
        clean_content = clean_content.replace(/^User Safety:.*$/gmi, '').trim();
        response_data.choices[0].message.content = clean_content;

        active_session_log.push(response_data.choices[0].message);
        return { status: 200, data: response_data };
    }
}

