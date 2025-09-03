/* src/main.js
   Brokerage Trade Agent — robust JSON-or-text handling
   - Shows status chips: Loading state…, Generating plan…, Non-JSON reply
   - Falls back to raw text if JSON parsing fails
   - Preserves formatting; saves last plan in localStorage
*/

(function () {
  // ---- DOM helpers ---------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);

  // Expect these IDs to exist in index.html. If not, create them.
  const ensureEl = (id, tag = "div") => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement(tag);
      el.id = id;
      document.body.appendChild(el);
    }
    return el;
  };

  const btnRun = ensureEl("run-btn", "button");
  btnRun.textContent ||= "Run Trade Agent";
  btnRun.classList.add("btn-run");

  const statusWrap = ensureEl("status-wrap");
  statusWrap.classList.add("status-wrap");

  const output = ensureEl("output");
  output.classList.add("output");

  // ---- Status chip API -----------------------------------------------------
  const chipIds = {
    loadingState: "chip-loading-state",
    generating: "chip-generating",
    nonJson: "chip-non-json",
    error: "chip-error",
  };

  const makeChip = (id, text, extraClass = "") => {
    let chip = document.getElementById(id);
    if (!chip) {
      chip = document.createElement("div");
      chip.id = id;
      chip.className = `chip ${extraClass}`.trim();
      chip.textContent = text;
      statusWrap.appendChild(chip);
    }
    chip.style.display = "inline-flex";
    return chip;
  };

  const hideChip = (id) => {
    const chip = document.getElementById(id);
    if (chip) chip.style.display = "none";
  };

  const hideAllChips = () => {
    Object.values(chipIds).forEach(hideChip);
  };

  // ---- Fetch helpers -------------------------------------------------------
  async function getState() {
    const url = "/.netlify/functions/tradeState";
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) throw new Error(`tradeState GET failed: ${resp.status}`);
    const json = await resp.json();
    if (!json?.ok) throw new Error("tradeState returned not ok");
    return json.state || {};
  }

  async function callAgent(state) {
    const url = "/.netlify/functions/agentChat";
    const payload = {
      state,
      // Give the backend a strong hint, but we’ll still be defensive:
      output_contract: {
        type: "object",
        properties: { plan: { type: "string" } },
        required: ["plan"],
      },
      // You can read this on the server to tighten prompts if desired:
      prefer_json: true,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // We intentionally read as text first — could be JSON or plain text.
    return await resp.text();
  }

  // ---- Parsing utilities ---------------------------------------------------
  function extractFencedJson(text) {
    // ```json ... ``` or ``` ... ```
    const fenceJson = text.match(/```json\s*([\s\S]*?)```/i);
    if (fenceJson) return fenceJson[1].trim();

    const fenceAny = text.match(/```\s*([\s\S]*?)```/);
    if (fenceAny) return fenceAny[1].trim();

    return null;
  }

  function looseJsonParse(text) {
    // Try plain parse
    try {
      return JSON.parse(text);
    } catch (_) {
      // Try fenced block
      const inner = extractFencedJson(text);
      if (inner) {
        try {
          return JSON.parse(inner);
        } catch (_) {}
      }
      // Try extracting first {...} block (very loose heuristic)
      const objMatch = text.match(/\{[\s\S]*\}$/m);
      if (objMatch) {
        try {
          return JSON.parse(objMatch[0]);
        } catch (_) {}
      }
      return null;
    }
  }

  // ---- Rendering -----------------------------------------------------------
  function sanitize(text) {
    // Minimal sanitization to avoid accidental HTML injection.
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function renderPlan(planText) {
    if (!planText || typeof planText !== "string") {
      planText = "No plan content returned.";
    }

    // Preserve formatting; allow markdown-looking output to be readable.
    output.innerHTML = `<pre class="plan-pre">${sanitize(planText)}</pre>`;

    // Persist last result so the screen isn’t blank on reload.
    try {
      localStorage.setItem("lastPlan", planText);
    } catch (_) {}
  }

  function renderError(err) {
    console.error(err);
    makeChip(chipIds.error, "Error", "chip-warn");
    output.innerHTML = `
      <div class="error-box">
        <div class="error-title">Something went wrong</div>
        <pre class="error-pre">${sanitize(String(err?.message || err))}</pre>
      </div>
    `;
  }

  // ---- Main flow -----------------------------------------------------------
  async function run() {
    hideAllChips();
    output.innerHTML = "";

    try {
      makeChip(chipIds.loadingState, "Loading state…");
      const state = await getState();
      hideChip(chipIds.loadingState);

      makeChip(chipIds.generating, "Generating plan…");
      const raw = await callAgent(state);
      hideChip(chipIds.generating);

      // Try to parse JSON; fall back to raw text.
      let planText = null;
      const parsed = looseJsonParse(raw);
      if (parsed && typeof parsed === "object") {
        planText =
          typeof parsed.plan === "string"
            ? parsed.plan
            : // If server sent a structured object, render a compact summary as text:
              JSON.stringify(parsed, null, 2);
      } else {
        // Not JSON — still render, but surface the chip to make it clear.
        makeChip(chipIds.nonJson, "Non-JSON reply", "chip-warn");
        planText = raw;
      }

      renderPlan(planText);
    } catch (err) {
      hideAllChips();
      renderError(err);
    }
  }

  // ---- Wire up UI ----------------------------------------------------------
  btnRun.addEventListener("click", run);

  // Restore last plan on load, so UI isn’t empty.
  (function boot() {
    const last = localStorage.getItem("lastPlan");
    if (last) {
      renderPlan(last);
    } else {
      output.innerHTML =
        '<div class="muted">Tap <strong>Run Trade Agent</strong> to generate today’s plan in your exact format.</div>';
    }
  })();
})();


