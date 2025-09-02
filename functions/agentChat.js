// functions/agentChat.js
// CORS preflight
if (event.httpMethod === 'OPTIONS') {
return {
statusCode: 204,
headers: corsHeaders(),
body: ''
};
}


if (event.httpMethod !== 'POST') {
return json(405, { error: 'Method Not Allowed' });
}


try {
const { messages, system, temperature = 0.2, max_tokens = 1000 } = JSON.parse(event.body || '{}');
if (!Array.isArray(messages) || messages.length === 0) {
return json(400, { error: 'Provide messages[] in body' });
}


// Upstream config (OpenAI by default)
const upstreamUrl = process.env.UPSTREAM_URL || 'https://api.openai.com/v1/chat/completions';
const apiKey = process.env.OPENAI_API_KEY || process.env.AGENT_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';


if (!apiKey) {
return json(500, { error: 'Missing API key on server (OPENAI_API_KEY or AGENT_API_KEY)' });
}


// Compose messages with our guardrails/system prompt (keeps your agent formatting consistent)
const sys = system || 'You are Brokerage Agent. Keep output sections consistent with existing agent formatting. Never remove existing data fields; only add new sections when asked.';


const payload = {
model,
temperature,
max_tokens,
messages: [
{ role: 'system', content: sys },
...messages
]
};


const upstreamRes = await fetch(upstreamUrl, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${apiKey}`
},
body: JSON.stringify(payload)
});


const raw = await upstreamRes.json();
if (!upstreamRes.ok) {
console.error(`[agentChat] upstream error`, { requestId, status: upstreamRes.status, raw });
return json(502, { error: 'Upstream LLM error', details: raw?.error || raw });
}


// OpenAI Chat Completions shape
const reply = raw?.choices?.[0]?.message?.content || '';
const usage = raw?.usage || null;


const dt = Date.now() - t0;
console.log(`[agentChat] ok`, { requestId, model, dt, chars: reply.length });


return json(200, { reply, usage, model, requestId });
} catch (err) {
console.error(`[agentChat] exception`, { requestId, err: String(err) });
return json(500, { error: 'Server error' });
}
}


// Helpers
function corsHeaders() {
return {
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Methods': 'POST, OPTIONS',
'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
}


function json(statusCode, obj) {
return {
statusCode,
headers: { 'Content-Type': 'application/json', ...corsHeaders() },
body: JSON.stringify(obj)
};
}