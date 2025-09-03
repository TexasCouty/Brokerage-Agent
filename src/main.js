/* src/main.js — Diagnostic build (non-invasive)
   - Keeps existing UI intact
   - Adds robust button binding + detailed logging
   - No inline styles, relies on your style.css
*/

(function () {
  // ---------- lightweight debug console on screen ----------
  let dbgOpen = false;
  const dbg = document.createElement("details");
  dbg.style.margin = "12px 16px";
  dbg.style.border = "1px solid var(--border)";
  dbg.style.borderRadius = "8px";
  dbg.style.background = "var(--bubble)";
  dbg.style.padding = "8px 10px";
  dbg.innerHTML = `<summary style="cursor:pointer">Debug Log</summary><pre id="dbg-pre" class="code" style="white-space:pre-wrap;margin:8px 0 0 0;max-height:240px;overflow:auto;"></pre>`;
  const dbgPre = dbg.querySelector("#dbg-pre");
  const addLog = (o) => {
    try {
      const line = typeof o === "string" ? o : JSON.stringify(o, null, 2);
      dbgPre.textContent += (dbgPre.textContent ? "\n" : "") + line;
    } catch {
      dbgPre.textContent += "\n[log stringify error]";
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    // append near top so it's easy to find
    const chat = document.querySelector(".chat") || document.body;
    chat.prepend(dbg);
  });

  // ---------- helpers ----------
  const byId = (id) => document.getElementById(id);

  // Find the run button *without* changing your HTML.
  function findRunButton() {
    const candidates = [
      "#run-btn",
      "#run",
      "[data-run]",
      ".primary",
      "button",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && /run.*trade.*agent/i.test(el.textContent || el.value || "")) {
        return el;
      }
    }
    // fallback: first button
    return document.querySelector("button");
  }

  function showChip(id, text) {
    let wrap = byId("status-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "status-wrap";
      wrap.style.display = "flex";
      wrap.style.gap = "8px";
      wrap.style.margin = "12px 0";
      const chat = document.querySelector(".chat") || document.body;
      chat.prepend(wrap);
    }
    let chip = byId(id);
    if (!chip) {
      chip = document.createElement("div");
      chip.id = id;
      chip.className = "chip";
      wrap.appendChild(chip);
    }
    chip.textContent = text;
    chip.style.display = "inline-flex";
    return chip;
  }
  function hideChip(id) { const el = byId(id); if (el) el.style.display = "none"; }
  function hideAllChips() {
    ["chip-loading-state","chip-generating","chip-non-json","chip-error"].forEach(hideChip);
  }

  function renderPlan(text) {
    const out = byId("output") || (function () {
      const el = document.createElement("div");
      el.id = "output";
      const chat = document.querySelector(".chat") || document.body;
      chat.appendChild(el);
      return el;
    })();
    const safe = (text || "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    out.innerHTML = `<pre class="bubble markdown">${safe}</pre>`;
  }

  function renderError(err) {
    showChip("chip-error", "Error");
    const out = byId("output") || document.body;
    const safe = (String(err && err.message || err || "Unknown")).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    out.innerHTML = `<div class="bubble"><div style="font-weight:700;margin-bottom:6px">Something went wrong</div><pre class="code" style="white-space:pre-wrap">${safe}</pre></div>`;
  }

  // ---------- network with diagnostics ----------
  async function getState() {
    const url = "/.netlify/functions/tradeState";
    const resp = await fetch(url, { method: "GET" });
    const text = await resp.text();
    addLog({ step: "tradeState GET", status: resp.status, headers: Object.fromEntries(resp.headers.entries()), preview: text.slice(0, 600) });
    if (!resp.ok) throw new Error(`tradeState GET failed: ${resp.status}`);
    try { return JSON.parse(text).state || {}; }
    catch (e) {
      addLog({ parse: "tradeState JSON parse error", message: e.message });
      throw new Error("tradeState returned non-JSON");
    }
  }

  async function callAgent(state) {
    const url = "/.netlify/functions/agentChat";
    const body = JSON.stringify({ state, prefer_json: true });
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    const text = await resp.text();
    addLog({ step: "agentChat POST", status: resp.status, headers: Object.fromEntries(resp.headers.entries()), preview: text.slice(0, 600) });

 +  if (!resp.ok) {
+    let msg = `agentChat error ${resp.status}`;
+    try {
+      const j = JSON.parse(text);
+      if (j?.error) msg += ` — ${j.error}`;
+      if (j?.meta?.bodyPreview) msg += `\n\npreview:\n${j.meta.bodyPreview}`;
+    } catch {}
+    throw new Error(msg);
+  }
    // Try to parse JSON first; if it fails, we’ll surface chip + render raw.
    try {
      const json = JSON.parse(text);
      if (json && json.plan) return { json, raw: text };
      // No plan field—treat as raw
      addLog({ note: "agentChat JSON ok but missing plan", keys: Object.keys(json || {}) });
      return { json, raw: text };
    } catch (e) {
      addLog({ parse: "agentChat JSON parse error", message: e.message });
      return { json: null, raw: text };
    }
  }

  // ---------- main flow ----------
  async function run() {
    hideAllChips();
    const btn = findRunButton();
    if (!btn) {
      addLog("[run] ERROR: Could not find the Run Trade Agent button.");
      renderError("Run button not found in DOM");
      return;
    }

    try {
      showChip("chip-loading-state", "Loading state…");
      const state = await getState();
      hideChip("chip-loading-state");

      showChip("chip-generating", "Generating plan…");
      const { json, raw } = await callAgent(state);
      hideChip("chip-generating");

      if (json && typeof json === "object") {
        if (typeof json.plan === "string") {
          renderPlan(json.plan);
          return;
        }
        // Fallback: render whole JSON (so we can see shape)
        renderPlan(JSON.stringify(json, null, 2));
        return;
      }

      // Non-JSON reply
      showChip("chip-non-json", "Non-JSON reply");
      renderPlan(raw);
    } catch (err) {
      renderError(err);
    }
  }

  // ---------- bind button once DOM is ready ----------
  document.addEventListener("DOMContentLoaded", () => {
    const btn = findRunButton();
    if (!btn) {
      addLog("[bind] WARNING: No suitable Run button found.");
      return;
    }
    btn.addEventListener("click", () => {
      addLog({ click: "Run Trade Agent", ts: new Date().toISOString(), boundTo: btn.outerHTML.slice(0, 120) + "…" });
      run();
    }, { passive: true });
    addLog({ bind: "Attached click handler to Run button", selectorGuess: btn.className || btn.id || btn.tagName });
  });

  // Optional: show something when page loads
  document.addEventListener("DOMContentLoaded", () => {
    const out = byId("output");
    if (!out) return;
    if (!out.textContent?.trim()) {
      out.innerHTML = `<div class="bubble">Tap <strong>Run Trade Agent</strong> to generate today's plan.</div>`;
    }
  });
})();
