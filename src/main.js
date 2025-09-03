// src/main.js — start → background generate → poll → render

(function () {
  const byId = (id) => document.getElementById(id);
  const $ = (s) => document.querySelector(s);

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
  function setButtonBusy(b, busy, labelText) {
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
      label.textContent = labelText || "Running…";
    } else {
      b.disabled = false;
      if (spin) spin.style.display = "none";
      label.textContent = "Run Trade Agent";
    }
  }

  function renderPlan(text) {
    const safe = sanitize(String(text || "")).replace(/\n/g, "<br>");
    ensureOutput().innerHTML = `<div class="bubble markdown">${safe}</div>`;
  }
  function renderError(message, preview) {
    ensureOutput().innerHTML =
      `<div class="bubble"><div style="font-weight:700;margin-bottom:6px">Something went wrong</div>
        <pre class="code" style="white-space:pre-wrap">${sanitize(String(message))}${preview?`\n\n${sanitize(preview)}`:""}</pre></div>`;
  }
  function renderStatus(msg) {
    ensureOutput().innerHTML = `<div class="bubble"><div class="muted">${sanitize(msg)}</div></div>`;
  }

  // ---- API helpers ----
  async function getState() {
    const r = await fetch("/.netlify/functions/tradeState");
    const t = await r.text();
    if (!r.ok) throw new Error(`tradeState ${r.status}\n${t.slice(0,400)}`);
    return (JSON.parse(t).state) || {};
  }
  async function planStart(state) {
    const r = await fetch("/.netlify/functions/planStart", {
      method: "POST", headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ state })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `planStart ${r.status}`);
    return j; // {status, hash, data?}
  }
  async function planGenerate(hash, state) {
    // Background function: returns 202 immediately
    await fetch("/.netlify/functions/plan-generate", {
      method: "POST", headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ hash, state })
    });
  }
  async function planStatus(hash) {
    const r = await fetch(`/.netlify/functions/planStatus?hash=${encodeURIComponent(hash)}`);
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `planStatus ${r.status}`);
    return j; // {status, data?}
  }

  // ---- Renderer (DATA -> Markdown) ----
  function emojiFromSignal(sig) {
    if (sig === "outperform") return "🟢";
    if (sig === "lagging") return "🔴";
    return "🟡";
  }
  function statusBadge(status) {
    if (status === "BUY") return "✅ BUY";
    if (status === "TRIM") return "⚠️ TRIM";
    return "⏸️ HOLD";
  }
  function fmtNumber(n, dp = 2) {
    if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
    return Number(n).toFixed(dp);
  }
  function renderFromData(data) {
    let mpLines = "";
    const counts = { outperform:0, inline:0, lagging:0 };
    for (const row of (data.market_pulse || [])) {
      const s = row.signal || "inline";
      counts[s] = (counts[s] || 0) + 1;
      mpLines += `${row.ticker} (${row.benchmark || "QQQ"}) ${emojiFromSignal(s)} — ${row.note || ""}\n`;
    }
    const mpSummary = `Summary: 🟢 ${counts.outperform||0} outperforming · 🟡 ${counts.inline||0} in line · 🔴 ${counts.lagging||0} lagging`;

    const ct = data.cash_tracker || {};
    const sleeve = Number(ct.sleeve_value ?? 0);
    const cash = Number(ct.cash_available ?? 0);
    const invested = ct.invested != null ? Number(ct.invested) : (sleeve ? sleeve - cash : null);
    const pctCash = sleeve ? ((cash / sleeve) * 100) : null;
    const pctInv = sleeve && invested != null ? ((invested / sleeve) * 100) : null;

    const blocks = (data.portfolio_snapshot || []).map(p => {
      const price = p.price != null ? `$${fmtNumber(p.price,2)}` : "n/a";
      const pl = (p.pl_pct != null) ? `${fmtNumber(p.pl_pct,2)}%` : "n/a";
      const flow = p.flow || "Neutral";
      const res = p.resistance || "n/a";
      const bw = p.breakout_watch && p.breakout_watch.gt != null
        ? `>${p.breakout_watch.gt} → ${Array.isArray(p.breakout_watch.targets) ? p.breakout_watch.targets.join(", ") : ""}`
        : "n/a";
      const idea = p.idea || "—";
      const sent = p.sentiment || "Neutral";
      const badge = statusBadge(p.status || "HOLD");
      const pos = p.position || {};
      const qty = pos.qty != null ? pos.qty : "n/a";
      const avg = pos.avg != null ? pos.avg : "n/a";
      return [
        `${p.ticker} — ${emojiFromSignal("inline")} ${price} | Sentiment: ${sent} [${badge}]`,
        `• Position: ${qty} @ ${avg} | P/L ${pl}`,
        `• Flow: ${flow}`,
        `• Resistance: ${res}`,
        `• Breakout watch: ${bw}`,
        `• Idea: ${idea}`
      ].join("\n");
    });

    let md = "";
    md += `📊 Market Pulse (Summary)\n\n`;
    md += `(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)\n\n`;
    md += `${mpLines}\n${mpSummary}\n\n`;
    md += `💵 Cash Deployment Tracker\n\n`;
    md += `Brokerage sleeve total value: ≈ $${fmtNumber(sleeve,0)}\n`;
    md += `Cash available: $${fmtNumber(cash,0)}${pctCash!=null?` (${fmtNumber(pctCash,2)}%)`:""}\n`;
    md += `Invested (stocks): ${invested!=null?`≈ $${fmtNumber(invested,0)}`:"n/a"}${pctInv!=null?` (${fmtNumber(pctInv,2)}%)`:""}\n`;
    md += `Active triggers today (strict): ${(ct.active_triggers||[]).length ? (ct.active_triggers||[]).join("; ") : "None"}\n`;
    md += `Playbook: ${ct.playbook || "—"}\n\n`;
    md += `1) Portfolio Snapshot — Owned Positions\n\n`;
    md += (blocks.length ? blocks.join("\n\n") : "—");
    return md.trim();
  }

  // ---- main flow ----
  async function run() {
    const btn = byId("run-btn") || $(".primary");
    if (!btn) return console.error("Run button not found");

    ensureOutput().innerHTML = "";
    setButtonBusy(btn, true, "Starting…");
    try {
      const state = await getState();
      const start = await planStart(state);

      if (start.status === "ready" && start.data) {
        const md = renderFromData(start.data);
        renderPlan(md);
        return;
      }

      // not cached: kick background and poll
      const hash = start.hash;
      setButtonBusy(btn, true, "Generating…");
      renderStatus("Generating plan in background…");

      // fire-and-forget background
      await planGenerate(hash, state);

      // poll
      const maxTries = 90; // ~2 minutes @ 1.3s
      for (let i = 0; i < maxTries; i++) {
        await new Promise(r => setTimeout(r, 1300));
        const st = await planStatus(hash);
        if (st.status === "ready" && st.data) {
          const md = renderFromData(st.data);
          renderPlan(md);
          return;
        }
        if (st.status === "error") {
          renderError(st.error || "Generation failed", st.preview || "");
          return;
        }
        renderStatus(`Working… (${i+1}/${maxTries})`);
      }
      renderError("Timed out waiting for background job.");
    } catch (err) {
      renderError(err?.message || String(err));
    } finally {
      setButtonBusy(btn, false);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = byId("run-btn") || $(".primary");
    if (btn) btn.addEventListener("click", run, { passive: true });
    const out = byId("output");
    if (out) out.innerHTML = "";
  });
})();
