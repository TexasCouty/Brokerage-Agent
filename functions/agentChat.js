// functions/agentChat.js
// Netlify Function (v1). Pro plan friendly (25s). Strict JSON { plan }.
// ONLY three sections: Market Pulse, Cash Deployment Tracker, 1) Portfolio Snapshot — Owned Positions.
// Ultra-strict system prompt, deterministic settings, JSON-only response_format,
// server-side validation, and one corrective rewrite if the first reply drifts.

const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const REQ_TIMEOUT_MS = 25000; // ~25s (Netlify Pro cap ~26s)
const MAX_REWRITES = 1;

exports.handler = async (event) => {
  const rid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
  const start = Date.now();
  const T = () => Date.now() - start;
  const log = (stage, extra = {}) =>
    console.log(JSON.stringify({ fn: "agentChat", rid, t: T(), stage, ...extra }));

  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed. Use POST." }, rid);
    }

    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch (e) { log("bad-json", { msg: e.message }); return json(400, { ok:false, error:"Invalid JSON body" }, rid); }

    if (payload.ping === "test") return json(200, { ok:true, echo: payload }, rid);

    const state = payload.state;
    if (!state || typeof state !== "object") return json(400, { ok:false, error:"Missing 'state' in request body" }, rid);
    if (!process.env.OPENAI_API_KEY) return json(500, { ok:false, error:"Missing OPENAI_API_KEY" }, rid);

    const sanitized = sanitizeState(state);
    const userPrompt = buildUserPromptOwnedOnly(sanitized);

    // ---------- First attempt
    const first = await callOpenAIJSON({ prompt: userPrompt, rid, log });
    if (first.ok) {
      const plan = extractPlan(first.data);
      const critique = validatePlan(plan, sanitized);
      if (critique.ok) {
        log("ok-first", { planLen: plan.length });
        return json(200, { ok: true, plan, meta: { rid, usage: first.data?.usage } }, rid);
      }
      log("needs-fix", { reasons: critique.reasons });
      // ---------- Corrective rewrite (once)
      for (let i = 0; i < MAX_REWRITES; i++) {
        const fixPrompt = buildFixPrompt(sanitized, critique, plan);
        const second = await callOpenAIJSON({ prompt: fixPrompt, rid, log });
        if (second.ok) {
          const fixed = extractPlan(second.data);
          const reCrit = validatePlan(fixed, sanitized);
          if (reCrit.ok) {
            log("ok-rewrite", { planLen: fixed.length });
            return json(200, { ok: true, plan: fixed, meta: { rid, usage: second.data?.usage, rewrite: true } }, rid);
          } else {
            log("rewrite-still-bad", { reasons: reCrit.reasons });
          }
        }
      }
      return json(502, { ok:false, error:"Validation failed after rewrite", meta:{ rid, reasons: critique.reasons } }, rid);
    }

    // If we get here, upstream error or timeout
    log("openai-error", { error: first.error });
    return json(502, { ok:false, error:first.error || "Upstream error", meta:{ rid } }, rid);

  } catch (err) {
    console.error("[agentChat] fatal", err);
    return json(500, { ok:false, error:"Server error", meta:{ rid } }, rid);
  }
};

/* -------------------------- helpers -------------------------- */

function json(statusCode, body, rid) {
  return { statusCode, headers: { "content-type": "application/json", "x-rid": rid }, body: JSON.stringify(body) };
}

function sanitizeState(state) {
  return {
    cash: state.cash ?? null,
    benchmarks: state.benchmarks ?? null,
    positions: Array.isArray(state.positions) ? state.positions : [],
  };
}

function buildSystemMessage() {
  // Loud & explicit rules to reduce drift.
  return `YOU ARE A BROKERAGE TRADE AGENT.

FOLLOW THESE RULES EXACTLY:
1) Return ONLY a single JSON object with EXACTLY one key: {"plan":"<string>"}.
2) NO code fences, NO extra keys, NO preface or epilogue, NO markdown blocks outside the JSON.
3) The plan string must contain EXACTLY these three sections, in this order, with these exact headings:
   • 📊 Market Pulse (Summary)
   • 💵 Cash Deployment Tracker
   • 1) Portfolio Snapshot — Owned Positions
4) DO NOT include watchlist or research sections or any other sections.
5) ONLY reference tickers that appear in STATE.positions.
6) In Market Pulse: one line per owned ticker; AFTER EACH TICKER LINE INSERT TWO SPACES THEN A NEWLINE (hard Markdown line break).
7) Use concise, readable Markdown (bullets, short lines). Use percentages like "(38%)"; DO NOT use "~".
8) Separate sections with a single blank line.
9) Output must be deterministic and compact.`;
}

function buildUserPromptOwnedOnly(state) {
  return `
STATE (owned positions only):
${JSON.stringify(state)}

CONSTRUCT {"plan":"..."} where "plan" contains the three required sections only.

FORMAT GUIDANCE (copy headings & spacing exactly):
📊 Market Pulse (Summary)

(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)

Write ONE line per OWNED ticker; after EACH line add two spaces then newline.
Example (structure only):
AMZN (QQQ) 🟡 — in line with QQQ, modest gain.  
NVDA (SOXX) 🟢 — outperforming SOXX, holding above $X.  

Summary: 🟢 X outperforming · 🟡 Y in line · 🔴 Z lagging

💵 Cash Deployment Tracker

Brokerage sleeve total value: ≈ <STATE.cash.sleeve_value or estimate>
Cash available: <STATE.cash.cash_available> (<percent of sleeve_value>)
Invested (stocks): <STATE.cash.invested or (sleeve_value - cash_available)> (<percent>)
Active triggers today (strict): <None or short list based ONLY on owned tickers>
Playbook: 1–2 sentences, concise, actionable.

1) Portfolio Snapshot — Owned Positions

For EACH OWNED ticker include this bullet block:
TICKER — 🟢/🟡/🔴 $<price or “n/a”> | Sentiment: <Bullish/Neutral/Bearish> [⏸️ HOLD or ✅ BUY or ⚠️ TRIM]
• Position: <qty> @ <avg> | P/L <calc or “n/a”>
• Flow: <one short line; if unknown, Neutral>
• Resistance: <range or “n/a”>
• Breakout watch: ><level> → <targets> (if applicable)
• Idea: One short actionable line.
`.trim();
}

function buildFixPrompt(state, critique, previousPlan) {
  return `
Your previous output violated these rules:
${critique.reasons.join("\n")}

Rewrite the plan to FULLY satisfy all rules.
Return ONLY a single JSON object: {"plan":"<fixed string>"} with the three sections EXACTLY as required.
Do not include any other keys or text.

STATE:
${JSON.stringify(state)}

Previous plan (for reference only):
${JSON.stringify(previousPlan || "")}
`.trim();
}

async function callOpenAIJSON({ prompt, rid, log }) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);

    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: buildSystemMessage() },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        top_p: 0.1,
        response_format: { type: "json_object" },
        max_tokens: 1200,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const text = await upstream.text();
    log("openai-response", { status: upstream.status, bodyLen: text.length });

    if (!upstream.ok) return { ok: false, error: `OpenAI error ${upstream.status}`, text };

    const data = JSON.parse(text);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "OpenAI request timed out" : e.message };
  }
}

function extractPlan(openaiJSON) {
  try {
    const content = openaiJSON?.choices?.[0]?.message?.content;
    if (!content) return null;
    // With response_format=json_object, content is either JSON string or object {"plan": "..."}
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

// ---- Validation that enforces: 3 sections only; no extras; proper line breaks in Market Pulse
function validatePlan(plan, state) {
  const reasons = [];
  if (typeof plan !== "string" || !plan.trim()) {
    reasons.push("- Plan string missing/empty.");
    return { ok: false, reasons };
  }

  const must = [
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

  // Has required headers?
  must.forEach(h => { if (!plan.includes(h)) reasons.push(`- Missing required section header: "${h}".`); });

  // No forbidden content?
  forbidden.forEach(f => { if (plan.includes(f)) reasons.push(`- Forbidden content present: "${f}".`); });

  // Market Pulse hard line breaks: require at least one owned ticker line with "two spaces + newline"
  const ownedTickers = (state.positions || []).map(p => String(p.ticker || "").trim()).filter(Boolean);
  if (ownedTickers.length) {
    const pulseStart = plan.indexOf("📊 Market Pulse (Summary)");
    const cashStart = plan.indexOf("💵 Cash Deployment Tracker");
    if (pulseStart >= 0 && cashStart > pulseStart) {
      const pulseBody = plan.slice(pulseStart, cashStart);
      const hasHardBreak = /  \n/.test(pulseBody);
      if (!hasHardBreak) reasons.push("- Market Pulse lines must end with TWO SPACES then a newline for hard Markdown line breaks.");
      // also require at least one owned ticker symbol to appear in pulse
      const anyTickerInPulse = ownedTickers.some(t => pulseBody.toUpperCase().includes(t.toUpperCase()));
      if (!anyTickerInPulse) reasons.push("- Market Pulse must include lines for OWNED tickers.");
    }
  }

  return { ok: reasons.length === 0, reasons };
}
