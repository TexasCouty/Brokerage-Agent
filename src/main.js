// src/main.js — minimal UI: title + yellow button + result

(function () {
  const $ = (s) => document.querySelector(s);
  const byId = (id) => document.getElementById(id);

  function sanitize(s = "") {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  // Ensure an output container exists (empty at first)
  function ensureOutput() {
    let out = byId("output");
    if (!out) {
      out = document.createElement("div");
      out.id = "output";
      (document.querySelector(".chat") || document.body).appendChild(out);
    }
    return out;
  }

  function setButtonBusy(btn, busy) {
    const label = btn.querySelector(".btn-label") || btn;
    let spin = btn.querySelector(".btn-spinner");
    if (busy) {
      btn.disabled = true;
      if (!spin) {
        spin = document.createElement("span");
        spin.className = "btn-spinner";
        label.insertAdjacentElement("afterend", spin);
      }
      spin.style.display = "inline-block";
      label.textContent = "Running…";
    } else {
      btn.disabled = false;
      if (spin) spin.style.display = "none";
      label.textContent = "Run Trade Agent";
    }
  }

  function renderPlan(text) {
    const out = ensureOutput();
    out.innerHTML = `<pre class="bubble markdown">${sanitize(String(text || ""))}</pre>`;
  }

  function renderError(message) {
    const out = ensureOutput();
    out.innerHTML = `
      <div class="bubble">
        <div style="font-weight:700;margin-bottom:6px">Something went wrong</div>
        <pre class="code" style="white-space:pre-wrap">${sanitize(String(message))}</pre>
      </div>`;
  }

  async function getState() {
    const r = await fetch("/.netlify/functions/tradeState");
    const t = await r.text();
    if (!r.ok) throw new Error(`tradeState ${r.status}\n${t.slice(0,400)}`);
    const j = JSON.parse(t);
    return j.state || {};
  }

  async function callAgent(state) {
    const r = await fetch("/.netlify/functions/agentChat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, prefer_json: true }),
    });
    const t = await r.text();

    if (!r.ok) {
      try {
        const j = JSON.parse(t);
        const msg = `agentChat error ${r.status}` + (j?.error ? ` — ${j.error}` : "");
        throw new Error(msg + (j?.meta?.bodyPreview ? `\n\npreview:\n${j.meta.bodyPreview}` : ""));
      } catch {
        throw new Error(`agentChat error ${r.status}\n${t.slice(0,400)}`);
      }
    }

    // Prefer JSON { plan }, but gracefully accept text
    try {
      const j = JSON.parse(t);
      if (typeof j.plan === "string") return j.plan;
      return JSON.stringify(j, null, 2);
    } catch {
      return t;
    }
  }

  async function run() {
    const btn = byId("run-btn") || document.querySelector(".primary");
    if (!btn) return console.error("Run button not found");

    // Minimal UI: clear output area (keep title + button)
    ensureOutput().innerHTML = "";
    setButtonBusy(btn, true);

    try {
      const state = await getState();
      const plan = await callAgent(state);
      renderPlan(plan);
      try { localStorage.setItem("lastPlan", plan); } catch {}
    } catch (err) {
      renderError(err?.message || err);
    } finally {
      setButtonBusy(btn, false);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = byId("run-btn") || document.querySelector(".primary");
    if (btn) btn.addEventListener("click", run, { passive: true });

    // Optional: show last plan on load (or keep empty)
    const last = localStorage.getItem("lastPlan");
    if (last) renderPlan(last);

    // Hide any old helper banners if present
    const helper = document.querySelector(".helper, .tip, .card, .status-wrap");
    if (helper) helper.remove();
  });
})();
