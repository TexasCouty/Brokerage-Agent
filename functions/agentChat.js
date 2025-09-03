// functions/agentChat.js
// Netlify Function (v1). Pro plan friendly (25s). Strict JSON { plan }.
// Sections: Market Pulse, Cash Deployment Tracker, and Portfolio Snapshot — Owned Positions ONLY.
// Includes post-validate + one-shot corrective rewrite if the model deviates.

const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const REQ_TIMEOUT_MS = 25000; // ~25s (under Netlify Pro 26s cap)
const RETRIES = 1;
const MAX_REWRITES = 1;

exports.handler = async (event) => {
  const rid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
  const t0 = Date.now();
  const T = () => Date.now() - t0;
  const log = (stage, extra = {}) =>
    console.log(JSON.stringify({ fn: "agentChat", rid, t: T(), stage, ...extra }));

  try {
    if (event.httpMethod !== "POST") {
      return j(405, { ok: false, error: "Method Not Allowed. Use POST." }, rid);
    }

    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch (e) { log("json-parse-error", { message: e.message }); return j(400, { ok:false, error:"Invalid JSON body" }, rid); }

    if (payload.ping === "test") { log("probe-ok"); return j(200, { ok:true, echo: payload }, rid); }

    const state = payload.state;
    if (!state || typeof state !== "object") {
      log("no-state");
      return j(400, { ok:false, error:"Missing 'state' in request body" }, rid);
    }
    if (!process.env.OPENAI_API_KEY) {
      log("no-openai");
      return j(500, { ok:false, error:"Server not configured (missing OPENAI_API_KEY)" }, rid);
    }

    const prompt = buildUserPromptOwnedOnly(state);
    log("prompt-built", { promptLen: prompt.length });

    // ---- First attempt
    const first = await callOpenAIJSON({ prompt, timeoutMs: REQ_TIMEOUT_MS, rid, log });
    if (first.ok) {
      const plan = extractPlan(first.data);
      if (plan && isPlanValid(plan)) {
        log("done", { attempt: 0, planLen: plan.length });
        return j(200, { ok: true, plan, meta: { rid, usage: first.data?.usage } }, rid);
      }
    }

    // ---- Corrective rewrite (at most once)
    for (let rewrite = 1; rewrite <= MAX_REWRITES; rewrite++) {
      const prevPlan = first.ok ? extractPlan(first.data) : "";
      const critique = validateCritique(prevPlan);
      const fixPrompt = buildFixPromptOwnedOnly(state, critique, prevPlan);
      const second = await callOpenAIJSON({ prompt: fixPrompt, timeoutMs: REQ_TIMEOUT_MS, rid, log });

      if (second.ok) {
        const fixed = extractPlan(second.data);
        if (fixed && isPlanValid(fixed)) {
          log("done", { attempt: rewrite, planLen: fixed.length });
          return j(200, { ok: true, plan: fixed, meta: { rid, usage: second.data?.usage, rewrite } }, rid);
        }
      }
    }

    // If we got here, either OpenAI was slow or validation failed.
    const errMsg = first.error || "Validation failed";
    log("returning-error", { message: errMsg });
    return j(502, { ok: false, error: errMsg, meta: { rid } }, rid);

  } catch (err) {
    console.error("[agentChat] unhandled", err);
    return j(500, { ok:false, error:"Server error", meta:{ rid } }, rid);
  }
};

/* ---------------------------- helpers ---------------------------- */

function j(statusCode, body, rid) {
  return { statusCode, headers: { "content-type": "application/json", "x-rid": rid }, body: JSON.stringify(body) };
}

function sanitizeStateForPrompt(state) {
  return {
    cash: state.cash ?? null,
    benchmarks: state.benchmarks ?? null,
    positions: Array.isArray(state.positions) ? state.positions : [],
  };
}

/** Build the primary prompt — OWNED POSITIONS ONLY. */
function buildUserPromptOwnedOnly(state) {
  return `
Return ONLY a JSON object: {"plan":"<string>"}.
The "plan" string MUST contain exactly these sections and nothing else:

📊 Market Pulse (Summary)

(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)

Write ONE line per OWNED ticker from STATE.positions.
After each ticker line, insert a hard Markdown line break (two spaces then newline).  
Example (structure only):
AMZN (QQQ) 🟡 — in line with QQQ, modest gain.  
NVDA (SOXX) 🟢 — outperforming SOXX, stable above $X.  

Summary: 🟢 X outperforming · 🟡 Y in line · 🔴 Z lagging

💵 Cash Deployment Tracker

Brokerage sleeve total value: ≈ <from STATE.cash.sleeve_value if present, else estimate>
Cash available: <STATE.cash.cash_available> (<percent of sleeve_value>)
Invested (stocks): <STATE.cash.invested or sleeve_value - cash_available> (<percent>)
Active triggers today (strict): <None or short list derived ONLY from owned tickers>
Playbook: 1–2 short sentences, concise.

1) Portfolio Snapshot — Owned Positions

For EACH OWNED ticker in STATE.positions, include exactly this bullet block:
TICKER — 🟢/🟡/🔴 $<price or “n/a”> | Sentiment: <Bullish/Neutral/Bearish> [⏸️ HOLD or ✅ BUY or ⚠️ TRIM]
• Position: <qty> @ <avg> | P/L <calc or “n/a”>
• Flow: <one short line; if unknown, Neutral>
• Resistance: <range or “n/a”>
• Breakout watch: ><level> → <targets> (if applicable)
• Idea: One short actionable line.

HARD CONSTRAINTS:
- Do NOT include watchlist or research sections or any other sections.
- Do NOT mention tickers not in STATE.positions.
- Use percentages like "(38%)" — do NOT use "~".
- Keep sections separated by a single blank line.
- Output ONLY the JSON object {"plan":"..."} with NO code fences.

STATE:
${JSON.stringify(sanitizeStateForPrompt(state))}
`.trim();
}

/** Build corrective prompt when the first output drifted. */
function buildFixPromptOwnedOnly(state, critique, previousPlan) {
  return `
Previous attempt did not follow the required format.

Critique:
${critique}

Rewrite the plan to FIX all issues.
Return ONLY a JSON object: {"plan":"<string>"}.
Follow the same constraints as before (owned positions only, exact three sections, no extras).

STATE:
${JSON.stringify(sanitizeStateForPrompt(state))}

Previous plan (for reference only):
${JSON.stringify(previousPlan || "")}
`.trim();
}

/** Call OpenAI with JSON response_format and a timeout. */
async function callOpenAIJSON({ prompt, timeoutMs, rid, log }) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
`You are a Brokerage Trade Agent.
You MUST output a single JSON object with EXACTLY one key: "plan".
Do not include code fences or extra keys. The "plan" must match the required three sections.`,
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_tokens: 1200,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const text = await upstream.text();
    log("openai-response", { status: upstream.status, bodyLen: text.length });

    if (!upstream.ok) {
      return { ok: false, error: `OpenAI error ${upstream.status}`, text };
    }

    // With response_format=json_object, the assistant message content is JSON text.
    const data = JSON.parse(text);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "OpenAI request timed out" : e.message };
  }
}

/** Extract {"plan": "..."} from the OpenAI JSON response. */
function extractPlan(openaiJSON) {
  try {
    const content = openaiJSON?.choices?.[0]?.message?.content;
    if (!content) return null;
    if (typeof content === "string") {
      const obj = JSON.parse(content);
      return typeof obj?.plan === "string" ? obj.plan : null;
    }
    if (typeof content === "object" && typeof content.plan === "string") {
      return content.plan;
    }
    return null;
  } catch {
    return null;
  }
}

/** Validate that the plan has ONLY the required sections and no forbidden ones. */
function isPlanValid(plan) {
  if (typeof plan !== "string") return false;
  const mustHave = [
    "📊 Market Pulse (Summary)",
    "💵 Cash Deployment Tracker",
    "1) Portfolio Snapshot — Owned Positions",
  ];
  const forbidden = [
    "2) Entry Radar",
    "3) Research",
    "TODAY’S PLAN",
    "TODAY'S PLAN",
  ];
  const hasAll = mustHave.every(s => plan.includes(s));
  const hasForbidden = forbidden.some(s => plan.includes(s));
  return hasAll && !hasForbidden;
}

/** Produce a human-readable critique for the corrective prompt. */
function validateCritique(plan) {
  if (!plan) return "- No plan returned.\n";
  const lines = [];
  if (!plan.includes("📊 Market Pulse (Summary)")) lines.push("- Missing '📊 Market Pulse (Summary)'.");
  if (!plan.includes("💵 Cash Deployment Tracker")) lines.push("- Missing '💵 Cash Deployment Tracker'.");
  if (!plan.includes("1) Portfolio Snapshot — Owned Positions")) lines.push("- Missing '1) Portfolio Snapshot — Owned Positions'.");
  if (/\b2\)\s*Entry Radar\b/.test(plan)) lines.push("- Contains forbidden '2) Entry Radar' section.");
  if (/\b3\)\s*Research\b/.test(plan)) lines.push("- Contains forbidden '3) Research' section.");
  if (/TODAY[’']S PLAN/i.test(plan)) lines.push("- Contains forbidden 'TODAY’S PLAN' header.");
  return lines.length ? lines.join("\n") : "- Structure present but not exact (ensure headings/emojis/blank lines).";
}
