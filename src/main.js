// src/main.js — minimal, robust button binding + JSON-or-text handling

(function () {
  // ---- DOM helpers ----
  const $ = (sel) => document.querySelector(sel);
  const byId = (id) => document.getElementById(id);

  function ensure(elId, tag = "div") {
    let el = byId(elId);
    if (!el) {
      el = document.createElement(tag);
      el.id = elId;
      (document.querySelector(".chat") || document.body).appendChild(el);
    }
    return el;
  }

  const statusWrap = ensure("status-wrap");
  const output = ensure("output");

  // ---- chips ----
  function chip(id, text, warn = false) {
    let el = byId(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.className = "chip" + (warn ? " chip-warn" : "");
      statusWrap.appendChild(el);
    }
    el.textContent = text;
    el.style.display = "inline-flex";
  }
  function hide(id) { const el = byId(id); if (el) el.style.display = "none"; }
  function hideAll() {
    ["chip-loading-state", "chip-generating", "chip-non-json", "chip-error"].forEach(hide);
  }

  // ---- rendering ----
  function sanitize(s="") {
    return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  }
  function renderPlan(text) {
    output.innerHTML = `<pre class="bubble markdown">${sanitize(String(text || ""))}</pre>`;
  }
  function renderError(msg) {
    chip("chip-error", "Error", true);
    output.innerHTML = `<div class="bubble"><div style="font-weight:700;margin-bottom:6px">Something went wrong</div><pre class="code" style="white-space:pre-wrap">${sanitize(String(msg))}</pre></div>`;
  }

  // ---- network ----
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
      // function should return JSON on errors; show it if present
      try {
        const j = JSON.parse(t);
        const msg = `agentChat error ${r.status}` + (j?.error ? ` — ${j.error}` : "");
        throw new Error(msg + (j?.meta?.bodyPreview ? `\n\npreview:\n${j.meta.bodyPreview}` : ""));
      } catch {
        throw new Error(`agentChat error ${r.status}\n${t.slice(0,400)}`);
      }
    }

    // Try JSON first
    try {
      const j = JSON.parse(t);
      if (j && typeof j.plan === "string") return j.plan;
      return JSON.stringify(j, null, 2);
    } catch {
      chip("chip-non-json", "Non-JSON reply", true);
      return t;
    }
  }

  // ---- main flow ----
  async function run() {
    hideAll();
    try {
      chip("chip-loading-state", "Loading state…");
      const state = await getState();
      hide("chip-loading-state");

      chip("chip-generating", "Generating plan…");
      const plan = await callAgent(state);
      hide("chip-generating");

      renderPlan(plan);
      try { localStorage.setItem("lastPlan", plan); } catch {}
    } catch (err) {
      renderError(err?.message || err);
    }
  }

  // ---- bind button (simple & explicit) ----
  document.addEventListener("DOMContentLoaded", () => {
    // Prefer #run-btn; fallback to .primary (your gold button)
    const btn = byId("run-btn") || document.querySelector(".primary");
    if (!btn) {
      console.error("[main] Run Trade Agent button not found — add id='run-btn' to the button in index.html.");
      return;
    }
    btn.addEventListener("click", run, { passive: true });

    const last = localStorage.getItem("lastPlan");
    if (last && !output.textContent?.trim()) renderPlan(last);
    if (!last) output.innerHTML = `<div class="bubble">Tap <strong>Run Trade Agent</strong> to generate today's plan.</div>`;
  });
})();
