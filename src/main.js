// src/main.js — minimal UI: title + yellow button + result.
// DATA-FIRST: renders Markdown on the client from { data }.
// No localStorage; blank on refresh until you click Run.

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

  // ----------- API -----------
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
      body: JSON.stringify({ state, mode: "data" }),
    });
    const t = await r.text();
    if (!r.ok) {
      try {
        const j = JSON.parse(t);
        const msg = `agentChat error ${r.status}` + (j?.error ? ` — ${j.error}` : "");
        throw new Error(msg);
      } catch {
        throw new Error(`agentChat error ${r.status}\n${t.slice(0,400)}`);
      }
    }
    try { return JSON.parse(t); } catch { return { plan: t }; }
  }

  // ----------- Renderer (DATA -> Markdown) -----------

  function emojiFromSignal(sig) {
    if (sig === "outperform") return "🟢";
    if (sig === "lagging") return "🔴";
    return "🟡"; // inline
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
    // 1) Market Pulse (Summary)
    let mpLines = "";
    let counts = { outperform: 0, inline: 0, lagging: 0 };
    for (const row of (data.market_pulse || [])) {
      const s = (row.signal || "inline");
      counts[s] = (counts[s] || 0) + 1;
      const emoji = emojiFromSignal(s);
      const ticker = row.ticker || "?";
      const bench = row.benchmark || "QQQ";
      const note = row.note || "";
      mpLines += `${ticker} (${bench}) ${emoji} — ${note}  \n`; // hard line break
    }
    const mpSummary = `Summary: 🟢 ${counts.outperform||0} outperforming · 🟡 ${counts.inline||0} in line · 🔴 ${counts.lagging||0} lagging`;

    // 2) Cash Deployment Tracker
    const ct = data.cash_tracker || {};
    const sleeve = Number(ct.sleeve_value ?? 0);
    const cash = Number(ct.cash_available ?? 0);
    const invested = ct.invested != null ? Number(ct.invested) : (sleeve ? sleeve - cash : null);
    const pctCash = sleeve ? ((cash / sleeve) * 100) : null;
    const pctInv = sleeve && invested != null ? ((invested / sleeve) * 100) : null;
    const triggers = Array.isArray(ct.active_triggers) ? ct.active_triggers : [];

    // 3) Portfolio Snapshot — Owned Positions
    const blocks = (data.portfolio_snapshot || []).map(p => {
      const price = p.price != null ? `$${fmtNumber(p.price, 2)}` : "n/a";
      const pl = (p.pl_pct != null) ? `${fmtNumber(p.pl_pct, 2)}%` : "n/a";
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

    // Compose final Markdown
    let md = "";
    md += `📊 Market Pulse (Summary)\n\n`;
    md += `(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)\n\n`;
    md += mpLines || "";
    md += `\n${mpSummary}\n\n`;

    md += `💵 Cash Deployment Tracker\n\n`;
    md += `Brokerage sleeve total value: ≈ $${fmtNumber(sleeve, 0)}\n`;
    md += `Cash available: $${fmtNumber(cash, 0)}${pctCash!=null?` (${fmtNumber(pctCash,2)}%)`:""}\n`;
    md += `Invested (stocks): ${invested!=null?`≈ $${fmtNumber(invested,0)}`:"n/a"}${pctInv!=null?` (${fmtNumber(pctInv,2)}%)`:""}\n`;
    md += `Active triggers today (strict): ${triggers.length?triggers.join("; "):"None"}\n`;
    md += `Playbook: ${ct.playbook || "—"}\n\n`;

    md += `1) Portfolio Snapshot — Owned Positions\n\n`;
    md += (blocks.length ? blocks.join("\n\n") : "—");

    return md.trim();
  }

  // ----------- Main flow -----------
  async function run() {
    const btn = byId("run-btn") || $(".primary");
    if (!btn) return console.error("Run button not found");

    ensureOutput().innerHTML = "";  // clear UI each run
    setButtonBusy(btn, true);
    try {
      const state = await getState();
      const res = await callAgent(state);

      // Prefer data-first
      if (res && res.data) {
        const md = renderFromData(res.data);
        renderPlan(md);
      } else if (res && typeof res.plan === "string") {
        renderPlan(res.plan); // fallback if server ever returns plan string
      } else {
        renderError("No data returned from agent.");
      }
    } catch (err) {
      renderError(err?.message || err);
    } finally {
      setButtonBusy(btn, false);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = byId("run-btn") || $(".primary");
    if (btn) btn.addEventListener("click", run, { passive: true });

    // start clean on hard refresh
    const out = byId("output");
    if (out) out.innerHTML = "";

    // remove any helper banners if present
    document.querySelectorAll(".helper,.tip,.card,.status-wrap").forEach(n => n.remove());
  });
})();
