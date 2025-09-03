// src/main.js — minimal UI, no persistence; clears output on load

(function () {
  const byId = (id) => document.getElementById(id);

  function sanitize(s = "") {
    return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  }

  function ensureOutput() {
    let out = byId("output");
    if (!out) {
      out = document.createElement("div");
      out.id = "output";
      (document.querySelector(".chat") || document.body).appendChild(out);
    }
    return out;
  }

  function setButtonBusy(b, busy) {
    const label = b.querySelector(".btn-label") || b;
    let spin = b.querySelector(".btn-spinner");
    if (busy) {
      b.disabled = true;
      if (!spin) {
        spin = document.createElement("span");
        spin.className = "btn-spinner";
        label.insertAdjacentElement("afterend", spin);
      }
      spin.style.display = "inline-block";
      label.textContent = "Running…";
    } else {
      b.disabled = false;
      if (spin) spin.style.display = "none";
      label.textContent = "Run Trade Agent";
    }
  }

  function renderPlan(text) {
    ensureOutput().innerHTML = `<pre class="bubble markdown">${sanitize(String(text || ""))}</pre>`;
  }

  function renderError(message) {
    ensureOutput().innerHTML =
      `<div class="bubble"><div style="font-weight:700;margin-bottom:6px">Something went wrong</div>
        <pre class="code" style="white-space:pre-wrap">${sanitize(String(message))}</pre></div>`;
  }

  async function getState() {
    const r = await fetch("/.netlify/functions/tradeState");
    const t = await r.text();
    if (!r.ok) throw new Error(`tradeState ${r.status}\n${t.slice(0,400)}`);
    return (JSON.parse(t).state) || {};
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
      } catch { throw new Error(`agentChat error ${r.status}\n${t.slice(0,400)}`); }
    }
    try {
      const j = JSON.parse(t);
      return typeof j.plan === "string" ? j.plan : JSON.stringify(j, null, 2);
    } catch { return t; }
  }

  async function run() {
    const btn = byId("run-btn") || document.querySelector(".primary");
    if (!btn) return console.error("Run button not found");

    // Clear output before every run
    ensureOutput().innerHTML = "";
    setButtonBusy(btn, true);
    try {
      const state = await getState();
      const plan = await callAgent(state);
      renderPlan(plan);
    } catch (err) {
      renderError(err?.message || err);
    } finally {
      setButtonBusy(btn, false);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    // Clear output on hard refresh (no lastPlan restore)
    const out = byId("output"); if (out) out.innerHTML = "";

    const btn = byId("run-btn") || document.querySelector(".primary");
    if (btn) btn.addEventListener("click", run, { passive: true });

    // remove any helper banners if present
    document.querySelectorAll(".helper,.tip,.card,.status-wrap").forEach(n => n.remove());
  });
})();
