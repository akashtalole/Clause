// Clause front-end: vanilla JS, no build step.
import { renderTimeline, detachTimeline, destroyTimeline } from "/timeline.js";
import { mountAnalytics, destroyAnalytics } from "/analytics.js";
const $app = document.getElementById("app");
const state = {
  config: null,
  role: safeGet("clause.role") || "buyer",
  draft: null,
  draftTrace: null,
  sellerKind: "human",
  pact: null,
  stream: null,
  busy: {}, // key -> label
  live: false, // split-screen buyer|seller view
  seen: new Set(), // verdicts already shown (new ones get the reveal animation)
  lastReleased: {}, // pactId -> released amount last rendered (for the money animation)
  open: {}, // ui toggles
};

const EXAMPLES = [
  {
    label: "🤖 Hire an AI agent to write product copy",
    agent: true,
    text: "I run a small candle shop called Ember & Oak. I want an AI agent to write product descriptions for my 3 bestsellers (Cedar Smoke, Fig Leaf, Sea Salt Linen). $120 total. First the three descriptions, each 50-90 words, mentioning hand-poured soy wax and a 45-hour burn time. Then 5 short Instagram captions (under 150 characters each) with at most 2 hashtags per caption.",
  },
  {
    label: "🎨 Logo for a bakery",
    text: "Maria (buyer) is hiring Dev (designer) to create a logo for her bakery 'Rise & Crumb' for $450. First 3 different rough concepts as sketches, then a refined color version of the chosen concept using warm tones, then final files: PNG on transparent background plus a one-color version. Needs to work at small sizes for the website favicon.",
  },
  {
    label: "🧾 Translate a menu",
    text: "Translate our restaurant's 20-item dinner menu from English to Spanish for $80. Keep dish names in original language with Spanish description underneath, keep all prices unchanged, and flag any allergens (nuts, dairy, gluten) with a marker.",
  },
  {
    label: "📸 Event photographer",
    text: "Booking a photographer for my sister's graduation party on Saturday, $600. Deliver at least 150 edited photos within 7 days, including group shots of the whole family and candid shots, plus 10 highlight photos edited in black and white.",
  },
];

// ------------------------------------------------------------------ utils
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(Number(n) || 0);
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
const statusLabel = (s) => ({ awaiting_funding: "Awaiting funding", active: "Active", completed: "Completed", cancelled: "Cancelled", pending: "Open", reviewing: "Arbiter reviewing", revision_requested: "Revision requested", escalated: "Needs buyer decision", released: "Released", settled: "Settled (partial)", voided: "Voided", refunded: "Refunded" })[s] || s;

let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), err ? 7000 : 3500);
}

async function api(path, { method = "GET", body, form } = {}) {
  const res = await fetch(path, {
    method,
    headers: form ? undefined : body ? { "Content-Type": "application/json" } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function busy(key, label, fn) {
  state.busy[key] = label;
  rerender();
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    delete state.busy[key];
    rerender();
  }
}

function rerender() {
  const r = route();
  if (r.name === "home") renderHome();
  else if (r.name === "pact" && state.pact) renderPact();
}

// ------------------------------------------------------------------ router
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const m = h.match(/^\/(pact|live)\/([\w-]+)/);
  if (m) return { name: "pact", id: m[2], live: m[1] === "live" };
  const rc = h.match(/^\/receipt\/([\w-]+)\/([\w-]+)/);
  if (rc) return { name: "receipt", id: rc[1], mid: rc[2] };
  if (h.startsWith("/pacts")) return { name: "list" };
  if (h.startsWith("/how")) return { name: "how" };
  if (h.startsWith("/analytics")) return { name: "analytics" };
  return { name: "home" };
}

async function navigate() {
  if (state.stream) { state.stream.close(); state.stream = null; }
  const r = route();
  if (r.name !== "pact" || r.id !== state.pact?.id || r.live !== state.live) destroyTimeline();
  window.scrollTo(0, 0);
  document.body.classList.toggle("wide", r.name === "analytics");
  if (r.name !== "analytics") destroyAnalytics();
  if (r.name === "home") renderHome();
  else if (r.name === "list") renderList();
  else if (r.name === "how") renderHow();
  else if (r.name === "analytics") renderAnalytics();
  else if (r.name === "receipt") renderReceipt(r.id, r.mid);
  else if (r.name === "pact") {
    $app.innerHTML = `<div class="empty">Loading pact…</div>`;
    try {
      state.pact = await api(`/api/pacts/${r.id}`);
      state.live = Boolean(r.live);
      // Verdicts that already existed are not re-animated; money baseline starts at what's there.
      state.pact.milestones.forEach((m) => m.submissions.forEach((s) => s.verdict && state.seen.add(s.id)));
      state.lastReleased[state.pact.id] ??= state.pact.money.released;
      renderPact();
      state.stream = new EventSource(`/api/pacts/${r.id}/stream`);
      state.stream.onmessage = (e) => {
        state.pact = JSON.parse(e.data);
        renderPact();
      };
    } catch (e) {
      $app.innerHTML = `<div class="empty">${esc(e.message)} · <a href="#/">Start a new pact</a></div>`;
    }
  }
}
window.addEventListener("hashchange", navigate);

// ------------------------------------------------------------------ header mode chips
function renderMode() {
  const c = state.config;
  const ai = c.aiMode === "claude" ? `<span class="chip" title="Model: ${esc(c.model)}"><i class="dot ok"></i>Claude · ${esc(c.model)}</span>` : `<span class="chip" title="Add ANTHROPIC_API_KEY to .env for real AI"><i class="dot warn"></i>Simulated AI</span>`;
  const rw = c.aiRunner && c.aiRunner !== "inline" ? `<span class="chip" title="AI agents run as Render Workflow tasks"><i class="dot ok"></i>${esc(c.aiRunner)}</span>` : "";
  const pp = c.paypalConfigured ? `<span class="chip"><i class="dot ok"></i>PayPal sandbox</span>` : `<span class="chip"><i class="dot bad"></i>PayPal not configured</span>`;
  document.getElementById("mode").innerHTML = ai + rw + pp;
}

// ------------------------------------------------------------------ HOME
function renderHome() {
  const b = state.busy.compile;
  $app.innerHTML = `
  <section class="hero">
    <div>
      <div class="eyebrow">AI-verified escrow · settled on PayPal</div>
      <h1>Payments that <em>read</em> the contract.</h1>
      <p class="lede">Describe a deal in plain English. Clause turns it into milestones with objective acceptance tests, holds the buyer's money on PayPal, and releases each milestone only when an AI arbiter verifies the work — for human freelancers and AI agents alike.</p>
      <div class="pillars">
        ${pillar("✍️", "var(--sky-soft)", "Contract compiler", "Claude turns a chat-style deal into milestones, amounts and checkable criteria — and flags ambiguities before money moves.")}
        ${pillar("🔒", "var(--amber-soft)", "Funds held, not charged", "One PayPal approval places an authorization hold. Each milestone is a partial capture; the rest stays with the buyer.")}
        ${pillar("⚖️", "var(--violet-soft)", "Evidence-based arbiter", "Every criterion is judged with quoted evidence (text and images). Prompt-injection attempts are flagged, not obeyed.")}
        ${pillar("🛡️", "var(--mint-soft)", "AI proposes, code disposes", "A deterministic spend gate decides when money moves. Disputes go to an AI tribunal that can split funds or refund.")}
      </div>
    </div>
    <div class="card composer">
      <div class="eyebrow" style="margin-bottom:8px">Describe the deal</div>
      <textarea id="dealText" placeholder="e.g. Hire a designer to make my bakery logo for $450: three concepts, then a color version, then final PNG files…">${esc(state.dealText || "")}</textarea>
      <div class="examples">${EXAMPLES.map((e, i) => `<button data-ex="${i}">${esc(e.label)}</button>`).join("")}</div>
      <div class="row">
        <label class="toggle"><input type="checkbox" id="agentSeller" ${state.sellerKind === "agent" ? "checked" : ""}/> Seller is an AI agent</label>
        <span class="spacer"></span>
        <button class="btn primary" id="compile" ${b ? "disabled" : ""}>${b ? `<span class="spinner"></span> Compiling…` : "Compile pact →"}</button>
      </div>
    </div>
  </section>
  ${state.draft ? renderDraft() : flowStrip()}`;

  const ta = document.getElementById("dealText");
  ta.addEventListener("input", () => (state.dealText = ta.value));
  document.getElementById("agentSeller").addEventListener("change", (e) => (state.sellerKind = e.target.checked ? "agent" : "human"));
  $app.querySelectorAll("[data-ex]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const ex = EXAMPLES[btn.dataset.ex];
      state.dealText = ex.text;
      state.sellerKind = ex.agent ? "agent" : "human";
      renderHome();
    })
  );
  document.getElementById("compile").addEventListener("click", () =>
    busy("compile", "Compiling", async () => {
      const r = await api("/api/pacts/draft", { method: "POST", body: { text: state.dealText } });
      state.draft = r.draft;
      state.draftTrace = r.trace;
      setTimeout(() => document.querySelector(".draft")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    })
  );
  if (state.draft) bindDraft();
}

function flowStrip() {
  const node = (x, ico, t, d) => `<g transform="translate(${x},0)"><circle r="30" cy="44" class="fnode"/><text y="53" text-anchor="middle" class="fico">${ico}</text><text y="98" text-anchor="middle" class="ft">${t}</text><text y="116" text-anchor="middle" class="fd">${d}</text></g>`;
  return `<section class="card flow" aria-label="How money moves in Clause">
    <svg viewBox="0 0 960 178" role="img" aria-label="Buyer funds a PayPal hold, Claude verifies, the spend gate releases a capture to the seller; unearned funds return to the buyer">
      <path id="fpath" d="M120 44 H840" class="fline"/>
      <path d="M840 126 C 700 160, 260 160, 120 126" class="fback"/>
      ${node(120, "🧑", "Buyer approves once", "PayPal order · intent AUTHORIZE")}
      ${node(360, "🔒", "Funds held, not charged", "Authorization hold")}
      ${node(600, "⚖️", "Claude verifies + spend gate", "evidence · confidence · red flags")}
      ${node(840, "✅", "Seller paid per milestone", "partial capture")}
      <circle r="9" class="coin"><animateMotion dur="4.5s" repeatCount="indefinite" keyPoints="0;0.32;0.32;0.66;0.66;1" keyTimes="0;0.25;0.4;0.6;0.75;1" calcMode="linear"><mpath href="#fpath"/></animateMotion></circle>
      <text x="480" y="170" text-anchor="middle" class="fd back">unearned funds return to the buyer automatically · disputes → AI tribunal → capture or refund</text>
    </svg>
  </section>`;
}

const pillar = (ico, bg, t, d) => `<div class="pillar"><div class="ico" style="background:${bg}">${ico}</div><div><b>${t}</b><span>${d}</span></div></div>`;

function renderDraft() {
  const d = state.draft;
  const total = d.milestones.reduce((s, m) => s + (Number(m.amount) || 0), 0);
  const creating = state.busy.create;
  return `
  <section class="card draft">
    <div class="row" style="margin-bottom:10px"><h2 style="margin:0">Compiled pact — review & edit</h2><span class="spacer"></span>
      ${state.draftTrace ? `<span class="chip" title="AI receipt"><i class="dot ${state.draftTrace.mode === "claude" ? "ok" : "warn"}"></i>${esc(state.draftTrace.model)} · ${(state.draftTrace.ms / 1000).toFixed(1)}s</span>` : ""}
    </div>
    <div class="draft-head">
      <input data-f="title" value="${esc(d.title)}" aria-label="Pact title" />
      <textarea data-f="summary" rows="2" aria-label="Summary">${esc(d.summary)}</textarea>
    </div>
    <div class="row" style="margin-top:6px">
      <span class="chip">Buyer: <input class="field" data-f="buyer_name" value="${esc(d.buyer_name)}" style="width:120px;padding:2px 6px"/></span>
      <span class="chip">Seller: <input class="field" data-f="seller_name" value="${esc(d.seller_name)}" style="width:120px;padding:2px 6px"/></span>
      <span class="chip">${state.sellerKind === "agent" ? "🤖 AI agent seller" : "🧑 Human seller"}</span>
    </div>
    ${d.milestones
      .map(
        (m, i) => `
      <div class="ms-edit">
        <div class="ms-num">${i + 1}</div>
        <div>
          <input class="title" data-m="${i}" data-k="title" value="${esc(m.title)}" />
          <textarea data-m="${i}" data-k="description" rows="1">${esc(m.description)}</textarea>
          <div class="eyebrow" style="margin:6px 0 2px 7px">Acceptance criteria</div>
          ${m.criteria.map((c, j) => `<div class="crit-edit"><span class="tick">✓</span><input data-m="${i}" data-c="${j}" value="${esc(c.text)}" /><button class="btn ghost small" data-delc="${i}:${j}" title="Remove">✕</button></div>`).join("")}
          <button class="btn ghost small" data-addc="${i}" style="margin:6px 0 0 7px">+ criterion</button>
        </div>
        <div class="amount-wrap">
          <div class="row" style="gap:2px;flex-wrap:nowrap"><span style="font-weight:700;font-size:17px;color:var(--muted)">$</span><input class="amount" data-m="${i}" data-k="amount" type="number" min="1" step="0.01" value="${esc(m.amount)}" aria-label="Milestone amount" /></div>
          <div class="hint" style="text-align:right">due in ${esc(m.due_in_days)}d</div>
          ${d.milestones.length > 1 ? `<div style="text-align:right"><button class="btn ghost small" data-delm="${i}">Remove</button></div>` : ""}
        </div>
      </div>`
      )
      .join("")}
    ${d.milestones.length < 5 ? `<button class="btn ghost small" id="addm" style="margin-top:10px">+ Add milestone</button>` : ""}
    ${d.risk_notes?.length || d.clarifying_questions?.length ? `<div class="notes">
      ${d.risk_notes?.length ? `<div class="note amber"><b>⚠️ Dispute risks spotted</b><ul>${d.risk_notes.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : "<div></div>"}
      ${d.clarifying_questions?.length ? `<div class="note sky"><b>❓ Worth clarifying — answer and Claude tightens the contract</b>
        <div class="qa">${d.clarifying_questions.map((q, i) => `<label><span>${esc(q)}</span><input class="field" data-answer="${i}" placeholder="Your answer (optional)" value="${esc(state.answers?.[i] || "")}"></label>`).join("")}</div>
        <button class="btn primary small" id="recompile" ${state.busy.compile ? "disabled" : ""}>${state.busy.compile ? `<span class="spinner"></span> Recompiling…` : "↻ Answer & recompile"}</button></div>` : ""}
    </div>` : ""}
    <div class="totalbar">
      <div><div class="eyebrow">Total held in escrow</div><div class="total" id="draftTotal">${fmt(total, d.currency)}</div></div>
      <span class="spacer"></span>
      <button class="btn ghost" id="discard">Discard</button>
      <button class="btn mint" id="create" ${creating ? "disabled" : ""}>${creating ? `<span class="spinner"></span> Creating…` : "Create pact & go to funding →"}</button>
    </div>
  </section>`;
}

function bindDraft() {
  const d = state.draft;
  const updTotal = () => (document.getElementById("draftTotal").textContent = fmt(d.milestones.reduce((s, m) => s + (Number(m.amount) || 0), 0), d.currency));
  $app.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("input", () => (d[el.dataset.f] = el.value)));
  $app.querySelectorAll("[data-m]").forEach((el) =>
    el.addEventListener("input", () => {
      const m = d.milestones[el.dataset.m];
      if (el.dataset.c !== undefined) m.criteria[el.dataset.c].text = el.value;
      else m[el.dataset.k] = el.dataset.k === "amount" ? Number(el.value) : el.value;
      if (el.dataset.k === "amount") updTotal();
    })
  );
  $app.querySelectorAll("[data-addc]").forEach((b) => b.addEventListener("click", () => { const m = d.milestones[b.dataset.addc]; m.criteria.push({ id: `c${m.criteria.length + 1}`, text: "" }); renderHome(); }));
  $app.querySelectorAll("[data-delc]").forEach((b) => b.addEventListener("click", () => { const [i, j] = b.dataset.delc.split(":"); d.milestones[i].criteria.splice(j, 1); renderHome(); }));
  $app.querySelectorAll("[data-delm]").forEach((b) => b.addEventListener("click", () => { d.milestones.splice(b.dataset.delm, 1); renderHome(); }));
  document.getElementById("addm")?.addEventListener("click", () => { d.milestones.push({ title: "New milestone", description: "", amount: 50, due_in_days: 7, criteria: [{ id: "c1", text: "" }] }); renderHome(); });
  document.getElementById("discard").addEventListener("click", () => { state.draft = null; renderHome(); });
  $app.querySelectorAll("[data-answer]").forEach((el) => el.addEventListener("input", () => ((state.answers ||= {})[el.dataset.answer] = el.value)));
  document.getElementById("recompile")?.addEventListener("click", () => {
    const qa = (d.clarifying_questions || []).map((q, i) => [q, (state.answers?.[i] || "").trim()]).filter(([, a]) => a);
    if (!qa.length) return toast("Answer at least one question first", true);
    state.dealText = `${state.dealText || d.source_text || ""}\n\nClarifications agreed by both parties:\n${qa.map(([q, a]) => `- ${q} → ${a}`).join("\n")}`;
    state.answers = {};
    busy("compile", "Recompiling", async () => {
      const r = await api("/api/pacts/draft", { method: "POST", body: { text: state.dealText } });
      state.draft = r.draft;
      state.draftTrace = r.trace;
      toast("Contract recompiled with your answers");
    });
  });
  document.getElementById("create").addEventListener("click", () =>
    busy("create", "Creating", async () => {
      d.milestones.forEach((m) => (m.criteria = m.criteria.filter((c) => c.text.trim()).map((c, j) => ({ id: `c${j + 1}`, text: c.text }))));
      const p = await api("/api/pacts", { method: "POST", body: { draft: d, trace: state.draftTrace, sellerKind: state.sellerKind } });
      state.draft = null;
      state.dealText = "";
      location.hash = `#/pact/${p.id}`;
    })
  );
}

// ------------------------------------------------------------------ LIST
async function renderList() {
  $app.innerHTML = `<div class="empty">Loading…</div>`;
  const list = await api("/api/pacts").catch(() => []);
  $app.innerHTML = `
    <div class="row" style="margin-bottom:16px"><h1 style="margin:0;font-size:26px">Pacts</h1><span class="spacer"></span><a class="btn primary" href="#/">+ New pact</a></div>
    ${list.length ? `<div class="list">${list.map(tile).join("")}</div>` : `<div class="card" style="padding:28px;text-align:center"><p class="empty">No pacts yet.</p><a class="btn primary" href="#/">Compile your first pact</a></div>`}`;
}

function tile(p) {
  const t = p.money.total || 1;
  return `<a class="card pact-tile" href="#/pact/${p.id}">
    <div class="row"><span class="pill ${p.status}">${statusLabel(p.status)}</span>${p.seller.kind === "agent" ? `<span class="chip">🤖 agent</span>` : ""}${p.demo ? `<span class="chip">Demo seed</span>` : ""}<span class="spacer"></span><b>${fmt(p.total, p.currency)}</b></div>
    <h3>${esc(p.title)}</h3>
    <div class="empty">${p.milestones.length} milestones · ${esc(p.buyer.name)} → ${esc(p.seller.name)} · ${ago(p.createdAt)}</div>
    <div class="mini-meter"><div class="seg-released" style="width:${(p.money.released / t) * 100}%"></div><div class="seg-held" style="width:${(p.money.held / t) * 100}%"></div><div class="seg-returned" style="width:${(p.money.returned / t) * 100}%"></div></div>
  </a>`;
}

// ------------------------------------------------------------------ PACT
function renderPact() {
  const p = state.pact;
  const cur = p.currency;
  const t = p.money.total || 1;
  const keepOpen = captureInputs();
  // Keep the live PayPal Buttons iframe across re-renders (destroying it would kill an open popup).
  const oldButtons = document.getElementById("paypal-buttons");
  const keepButtons = oldButtons && oldButtons.childElementCount ? oldButtons : null;
  const keepGantt = detachTimeline();
  $app.innerHTML = `
  ${p.demo ? `<div class="flags" style="margin-bottom:14px">Demo seed record for the analytics dashboard: generated history, not a real PayPal transaction (ids start with DEMO-).</div>` : ""}
  <div class="pact-head">
    <div style="flex:1;min-width:280px">
      <div class="row"><span class="pill ${p.status}">${statusLabel(p.status)}</span><span class="mono empty">${p.id}</span></div>
      <h1>${esc(p.title)}</h1>
      <p>${esc(p.summary)}</p>
      <div class="parties">
        <span class="chip">🧑 Buyer · ${esc(p.buyer.name)}${p.paypal.payer?.email ? ` <span class="mono">(${esc(p.paypal.payer.email)})</span>` : ""}</span>
        <span class="chip">${p.seller.kind === "agent" ? "🤖 AI agent" : "🧑"} Seller · ${esc(p.seller.name)}</span>
        ${auditChip(p)}
      </div>
    </div>
    <div class="head-actions">
      <a class="btn ${state.live ? "primary" : "ghost"} small" href="#/${state.live ? "pact" : "live"}/${p.id}" title="Buyer and seller side by side, updating live">${state.live ? "✕ Exit split screen" : "⚡ Live split screen"}</a>
      ${state.live ? "" : `<div class="role-switch" role="tablist" aria-label="View as">
        <button class="${state.role === "buyer" ? "on" : ""}" data-role="buyer">View as buyer</button>
        <button class="${state.role === "seller" ? "on" : ""}" data-role="seller">View as seller</button>
      </div>`}
    </div>
  </div>

  <section class="card meter-card">
    ${moneyPop(p)}
    <div class="meter-nums">
      <div><div class="k">Escrow total</div><div class="v">${fmt(p.money.total, cur)}</div></div>
      <div><div class="k"><i class="sw seg-released"></i>Released to seller</div><div class="v">${fmt(p.money.released, cur)}</div></div>
      <div><div class="k"><i class="sw seg-held"></i>Held on PayPal</div><div class="v">${fmt(p.money.held, cur)}</div></div>
      <div><div class="k"><i class="sw seg-returned"></i>Kept / returned to buyer</div><div class="v">${fmt(p.status === "awaiting_funding" ? 0 : p.money.returned, cur)}</div></div>
    </div>
    <div class="meter"><div class="seg-released" style="width:${(p.money.released / t) * 100}%"></div><div class="seg-held" style="width:${(p.money.held / t) * 100}%"></div><div class="seg-returned" style="width:${p.status === "awaiting_funding" ? 0 : (p.money.returned / t) * 100}%"></div></div>
  </section>

  ${state.live ? liveTicker(p) : ""}
  <section class="card timeline-card" ${state.live ? "hidden" : ""}>
    <div class="row"><div class="section-title" style="margin:0">Delivery timeline</div>
      <span class="hint" style="margin:0">${p.status === "awaiting_funding" ? "Projected from today — dates lock in when the buyer funds." : "Bars show where each milestone's money is. Revisions requested by the arbiter push later milestones out."}</span>
      <span class="spacer"></span>
      ${p.schedule.some((s) => s.atRisk) ? `<span class="pill escalated">⚠️ ${p.schedule.filter((s) => s.atRisk).length} at risk</span>` : `<span class="pill completed">On schedule</span>`}
    </div>
    <div id="gantt-slot" class="gantt-host"></div>
  </section>

  <div class="${state.live ? "live-wrap" : "grid2"}">
    ${state.live ? `<div class="live-grid">
      <div class="pane buyer-pane"><div class="pane-head"><span class="pane-role">🧑 Buyer</span><b>${esc(p.buyer.name)}</b><span class="spacer"></span><span class="hint" style="margin:0">funds, approves, disputes</span></div>${paneBody(p, "buyer")}</div>
      <div class="pane seller-pane"><div class="pane-head"><span class="pane-role">${p.seller.kind === "agent" ? "🤖 AI seller" : "🧑 Seller"}</span><b>${esc(p.seller.name)}</b><span class="spacer"></span><span class="hint" style="margin:0">delivers, gets paid</span></div>${paneBody(p, "seller")}</div>
    </div>` : `<div>${paneBody(p, state.role)}</div>`}
    <aside class="side">
      <div class="card">
        <div class="row"><div class="section-title" style="margin:0">PayPal ledger</div><span class="spacer"></span>${p.paypal.authorizationId ? `<button class="btn ghost small" id="refresh" title="Fetch live status from PayPal">${state.busy.refresh ? `<span class="spinner"></span>` : "↻ Sync"}</button>` : ""}</div>
        ${p.paypal.authorizationId ? `<div class="hint" style="margin:6px 0 10px">Authorization <span class="mono">${esc(p.paypal.authorizationId)}</span> · <b>${esc(p.paypal.authStatus || "")}</b>${p.paypal.expirationTime ? ` · expires ${new Date(p.paypal.expirationTime).toLocaleDateString()}` : ""}</div>` : ""}
        ${p.ledger.length ? `<ul class="ledger">${p.ledger.map((l) => `<li><span class="kind">${l.kind === "hold" ? "🔒 Hold placed" : l.kind === "capture" ? "✅ Captured" : l.kind === "refund" ? "↩️ Refunded" : l.kind === "void" ? "⛔ Hold voided" : "🔁 Reauthorized"}</span><span class="amt">${l.amount ? fmt(l.amount, cur) : ""}</span><span class="pid">${esc(l.paypalId)} · ${esc(l.status)} · ${ago(l.at)}</span></li>`).join("")}</ul>` : `<p class="empty">No money has moved yet.</p>`}
      </div>
      <div class="card">
        <div class="section-title">Timeline</div>
        <ul class="timeline">${[...p.events].reverse().map((e) => `<li><span class="actor ${esc(e.actor)}">${esc(e.actor.replace("-", " "))}</span><span>${esc(e.message)} <span class="empty">· ${ago(e.at)}</span></span></li>`).join("")}</ul>
      </div>
      <div class="card">
        <div class="section-title">AI receipts</div>
        ${p.aiTraces.length ? `<ul class="traces">${p.aiTraces.map((tr) => `<li><span>${esc(tr.label)}</span><span class="mono">${esc(tr.model)}${tr.effort && tr.effort !== "-" ? ` · ${esc(tr.effort)}` : ""} · ${(tr.ms / 1000).toFixed(1)}s${tr.output_tokens ? ` · ${tr.output_tokens} tok` : ""}${tr.runner === "render-workflows" ? ` · Render ${esc(tr.taskRunId || tr.task)}` : ""}</span></li>`).join("")}</ul>` : `<p class="empty">No AI calls yet.</p>`}
        <p class="hint">Money only moves when the deterministic spend gate passes: every criterion met, no red flags, confidence ≥ ${Math.round(p.policy.minConfidence * 100)}%.</p>
      </div>
    </aside>
  </div>`;
  restoreInputs(keepOpen);
  bindPact();
  p.milestones.forEach((m) => m.submissions.forEach((s) => s.verdict && state.seen.add(s.id)));
  const ganttSlot = document.getElementById("gantt-slot");
  if (keepGantt) ganttSlot.appendChild(keepGantt);
  renderTimeline(ganttSlot, p).catch((e) => {
    console.error(e);
    ganttSlot.innerHTML = `<p class="empty">Timeline unavailable: ${esc(e.message)}</p>`;
  });
  if (p.status === "awaiting_funding") {
    const slot = document.getElementById("paypal-buttons");
    if (keepButtons && slot) slot.replaceWith(keepButtons);
    else mountPayPal(p);
  }
}

function fundingCard(p) {
  const c = state.config;
  return `<section class="card fund">
    <h3>🔒 Fund the escrow</h3>
    <p>The buyer approves <b>${fmt(p.total, p.currency)}</b> once with PayPal. It's placed on hold (an authorization) — <b>nothing is charged</b> until a milestone is verified. Unearned funds are released back automatically.</p>
    ${c.paypalConfigured ? `<div id="paypal-buttons"></div>
      <div class="row" style="margin-top:10px"><button class="btn ghost small" id="redirectFund">${state.busy.redirect ? `<span class="spinner"></span>` : ""}Or open PayPal approval link</button></div>
      <div class="hint">Sandbox: log in with your <b>personal</b> sandbox account${c.buyerHint ? ` (<span class="mono">${esc(c.buyerHint)}</span>)` : ""}. Funds go to the business sandbox account that owns this app.</div>` : `<div class="flags">PayPal sandbox credentials are missing. Add PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET to .env and restart.</div>`}
    ${state.busy.fund ? `<div class="working"><span class="spinner"></span>${esc(state.busy.fund)}</div>` : ""}
  </section>`;
}

function paneBody(p, role) {
  return `${p.status === "awaiting_funding" && role === "buyer" ? fundingCard(p) : ""}
    ${p.status === "awaiting_funding" && role === "seller" ? `<div class="card waiting">⏳ Waiting for the buyer to fund the escrow on PayPal. You'll start work once ${fmt(p.total, p.currency)} is held.</div>` : ""}
    ${p.milestones.map((m) => milestoneCard(p, m, role)).join("")}
    ${p.status === "active" && role === "buyer" ? `<div class="row"><span class="spacer"></span><button class="btn danger small" data-cancel="1">Cancel pact & void remaining hold</button></div>` : ""}`;
}

function milestoneCard(p, m, role = state.role) {
  const isCurrent = p.currentMilestoneId === m.id && p.status === "active";
  const last = m.submissions.at(-1);
  const v = last?.verdict;
  const results = Object.fromEntries((v?.criteria || []).map((c) => [c.criterion_id, c]));
  const mk = { met: "✓", partially_met: "~", not_met: "✕", unverifiable: "?" };
  const busyLabel = state.busy[`ms-${m.id}`];
  const fresh = last?.verdict && !state.seen.has(last.id);
  return `<section class="card ms ${m.status} ${isCurrent ? "current" : ""} ${fresh ? "reveal" : ""}">
    <div class="badge">${m.status === "released" || m.status === "settled" ? "✓" : m.index + 1}</div>
    <div class="ms-top"><h3>${esc(m.title)}</h3><span class="pill ${m.status}">${statusLabel(m.status)}</span><span class="amt">${fmt(m.amount, p.currency)}</span></div>
    <div class="ms-desc">${esc(m.description)} <span class="empty">· due ${m.due_in_days}d after funding</span></div>
    <ul class="criteria">${m.criteria
      .map((c) => {
        const r = results[c.id];
        return `<li style="--i:${m.criteria.indexOf(c)}"><span class="cmark ${r?.result || ""}">${r ? mk[r.result] : "·"}</span><span>${esc(c.text)}${r ? `<span class="evidence">${r.evidence ? `<q>${esc(r.evidence)}</q> — ` : ""}${esc(r.reasoning)}</span>` : ""}</span></li>`;
      })
      .join("")}</ul>
    ${m.settlement ? `<div class="settle"><span>💸 <b>${m.settlement.percent}%</b> · ${fmt(m.settlement.amount, p.currency)} captured${m.settlement.refunded ? ` · ${fmt(m.settlement.refunded, p.currency)} refunded` : ""} — ${esc(m.settlement.reason)}</span><span class="spacer"></span><a class="btn ghost small" href="#/receipt/${p.id}/${m.id}">🧾 Verifiable receipt</a></div>` : ""}
    ${v ? (["released", "settled", "refunded"].includes(m.status) && !fresh ? `<details class="sub"><summary>⚖️ Arbiter verdict & spend gate</summary>${verdictBlock(v, last)}</details>` : verdictBlock(v, last)) : ""}
    ${m.disputes.map(rulingBlock).join("")}
    ${m.submissions.length ? `<details class="sub"><summary>Deliverable${m.submissions.length > 1 ? `s (${m.submissions.length} attempts)` : ""}</summary>${[...m.submissions].reverse().map((s, i) => `<div class="hint" style="margin-top:10px">Attempt ${m.submissions.length - i} · ${s.by === "agent" ? "🤖 AI seller agent" : "seller"} · ${ago(s.at)}${s.verdict ? ` · ${esc(s.verdict.decision.replace("_", " "))}` : ""}</div>${s.text ? `<div class="deliverable">${esc(s.text)}</div>` : ""}${s.images?.length ? `<div class="thumbs">${s.images.map((im) => `<img alt="${esc(im.name || "deliverable image")}" src="data:${im.mediaType};base64,${im.data}">`).join("")}</div>` : ""}${s.links?.length ? s.links.map((l) => `<div><a href="${esc(l)}" target="_blank" rel="noopener noreferrer">${esc(l)}</a></div>`).join("") : ""}`).join("")}</details>` : ""}
    ${busyLabel ? `<div class="working"><span class="spinner"></span>${esc(busyLabel)}</div>` : actionsFor(p, m, isCurrent, role)}
  </section>`;
}

function verdictBlock(v, sub) {
  const head = { release: "✅ Verified — release recommended", request_revision: "✏️ Revision requested", escalate: "🚩 Escalated to buyer" }[v.decision];
  return `<div class="verdict ${v.decision}">
    <div class="verdict-head">⚖️ Arbiter: ${head}<span class="conf">confidence <span class="bar"><i style="width:${Math.round(v.confidence * 100)}%"></i></span>${Math.round(v.confidence * 100)}%</span></div>
    <p>${esc(v.summary_for_buyer)}</p>
    ${v.decision !== "release" ? `<p><b>Feedback to seller:</b> ${esc(v.feedback_to_seller)}</p>` : ""}
    ${v.red_flags?.length ? `<div class="flags">🚩 <b>Red flags:</b> ${v.red_flags.map(esc).join(" · ")}</div>` : ""}
    ${sub.gate ? gateBlock(sub.gate) : ""}
  </div>`;
}

function gateBlock(gate) {
  const checks = gate.checks || gate.reasons.map((r) => ({ label: r, pass: false, detail: "" }));
  return `<div class="gatebox ${gate.autoRelease ? "open" : "shut"}">
    <div class="gate-title">🛡️ Spend gate <span class="hint" style="margin:0">— deterministic code, not the model, decides if money moves</span></div>
    <div class="gates">${checks.map((c, i) => `<div class="gatechk ${c.pass ? "ok" : "no"}" style="--i:${i}"><span class="gi">${c.pass ? "✓" : "✕"}</span><span><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></span></div>`).join("")}</div>
    <div class="gate-result">${gate.autoRelease ? "🔓 All checks passed → PayPal capture released this milestone to the seller." : "🔒 Funds stay held on PayPal → the buyer decides, or the AI tribunal rules."}</div>
  </div>`;
}

function auditChip(p) {
  if (!p.audit) return "";
  return p.audit.valid
    ? `<span class="chip audit-ok" title="Every event is SHA-256 hash-chained to the previous one. Head: ${esc(p.audit.head || "")}">🔗 Audit chain verified · ${p.audit.checked} events</span>`
    : `<span class="chip audit-bad" title="${esc(p.audit.reason || "")}">⚠️ Audit chain broken at event ${p.audit.brokenAt}</span>`;
}

function moneyPop(p) {
  const prev = state.lastReleased[p.id] ?? p.money.released;
  const delta = Math.round((p.money.released - prev) * 100) / 100;
  state.lastReleased[p.id] = p.money.released;
  return delta > 0 ? `<div class="money-pop" aria-live="polite">+${fmt(delta, p.currency)} → ${esc(p.seller.name)}</div>` : "";
}

function liveTicker(p) {
  const ev = [...p.events].slice(-5).reverse();
  return `<section class="ticker">${ev.map((e, i) => `<span class="tick ${i === 0 ? "newest" : ""}"><span class="actor ${esc(e.actor)}">${esc(e.actor.replace("-", " "))}</span>${esc(e.message)}</span>`).join("")}</section>`;
}

function rulingBlock(d) {
  const r = d.ruling;
  return `<div class="ruling">
    <div class="verdict-head">🏛️ Tribunal ruling${d.appeal ? " (appeal)" : ""}: <b>${r.award_to_seller_percent}% to seller</b><span class="conf">confidence ${Math.round(r.confidence * 100)}%</span></div>
    <p style="margin:8px 0 0;font-size:14px">${esc(r.rationale)}</p>
    ${r.findings?.length ? `<ul style="margin:8px 0 0;padding-left:18px;font-size:13.5px">${r.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    <details class="sub"><summary>Advocate arguments</summary><div class="args"><div class="arg"><b>Buyer's advocate</b>${esc(r.buyer_argument)}</div><div class="arg"><b>Seller's advocate</b>${esc(r.seller_argument)}</div></div></details>
  </div>`;
}

function actionsFor(p, m, isCurrent, role = state.role) {
  const out = [];
  if (isCurrent && role === "seller" && ["pending", "revision_requested", "escalated"].includes(m.status)) {
    out.push(`<div class="submit-box">
      <div class="eyebrow" style="margin-bottom:6px">${m.submissions.length ? "Submit a revision" : "Submit your deliverable"}</div>
      <textarea data-input="text-${m.id}" placeholder="Paste the work (text, copy, code, notes)… You can also attach images."></textarea>
      <div class="row" style="margin-top:8px">
        <label class="file-label">📎 Attach images<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple data-input="files-${m.id}"></label>
        <span class="hint" data-filecount="${m.id}"></span>
        <span class="spacer"></span>
        ${p.seller.kind === "agent" ? `<button class="btn ghost" data-agent="${m.id}">🤖 Let the AI seller agent do it</button>` : ""}
        <button class="btn primary" data-submit="${m.id}">Submit for verification</button>
      </div>
      ${m.status === "revision_requested" ? `<div class="row" style="margin-top:10px"><span class="hint">Disagree with the arbiter?</span><button class="btn ghost small" data-toggle="sdis-${m.id}">Dispute verdict</button></div>${state.open[`sdis-${m.id}`] ? disputeForm(m, "seller") : ""}` : ""}
    </div>`);
  }
  if (isCurrent && role === "seller" && m.status === "pending" && !m.submissions.length && p.seller.kind !== "agent") {
    /* already covered above */
  }
  if (isCurrent && role === "buyer" && ["revision_requested", "escalated"].includes(m.status) && m.submissions.length) {
    out.push(`<div class="actions">
      <button class="btn mint" data-release="${m.id}" data-pct="100">Approve & release ${fmt(m.amount, p.currency)}</button>
      <button class="btn ghost" data-toggle="partial-${m.id}">Partial release…</button>
      <button class="btn ghost" data-toggle="bdis-${m.id}">Send to AI tribunal</button>
    </div>
    ${state.open[`partial-${m.id}`] ? `<div class="row" style="margin-top:10px"><input type="range" min="0" max="100" value="50" data-input="pct-${m.id}" style="flex:1"><b data-pctlabel="${m.id}">50%</b><button class="btn primary small" data-release="${m.id}">Release</button></div>` : ""}
    ${state.open[`bdis-${m.id}`] ? disputeForm(m, "buyer") : ""}`);
  }
  if (isCurrent && role === "buyer" && m.status === "pending") {
    out.push(`<p class="hint" style="margin-top:12px">Waiting for the seller to deliver.${state.live ? "" : ` Switch to <b>View as seller</b> to submit${p.seller.kind === "agent" ? " or let the AI agent do the work" : ""}.`}</p>`);
  }
  if (role === "buyer" && m.status === "released" && m.settlement?.captureId && !m.disputes.some((d) => d.appeal)) {
    out.push(`<div class="actions"><button class="btn ghost small" data-toggle="appeal-${m.id}">Appeal release (refund via tribunal)…</button></div>${state.open[`appeal-${m.id}`] ? disputeForm(m, "buyer") : ""}`);
  }
  return out.join("");
}

function disputeForm(m, by) {
  return `<div class="submit-box">
    <div class="eyebrow" style="margin-bottom:6px">${by === "buyer" ? "Your claim (what's wrong with the delivery?)" : "Your response (why the work meets the criteria)"}</div>
    <textarea data-input="claim-${by}-${m.id}" placeholder="${by === "buyer" ? "e.g. The captions use 4 hashtags each, the contract says at most 2." : "e.g. Criterion 2 is met — see paragraph 3."}"></textarea>
    <div class="row" style="margin-top:8px"><span class="hint">Two AI advocates argue each side in parallel; an independent AI judge rules. The award is settled on PayPal (capture, partial capture, or refund).</span><span class="spacer"></span><button class="btn primary" data-dispute="${m.id}" data-by="${by}">Open dispute</button></div>
  </div>`;
}

// keep text typed in textareas across live re-renders
function captureInputs() {
  const saved = {};
  $app.querySelectorAll("textarea[data-input], input[type=range][data-input]").forEach((el) => (saved[el.dataset.input] = el.value));
  saved.__files = state.files || {};
  return saved;
}
function restoreInputs(saved) {
  $app.querySelectorAll("textarea[data-input], input[type=range][data-input]").forEach((el) => {
    if (saved[el.dataset.input] !== undefined) el.value = saved[el.dataset.input];
  });
}

function bindPact() {
  const p = state.pact;
  state.files = state.files || {};
  $app.querySelectorAll("[data-role]").forEach((b) => b.addEventListener("click", () => { state.role = b.dataset.role; safeSet("clause.role", state.role); renderPact(); }));
  $app.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => { state.open[b.dataset.toggle] = !state.open[b.dataset.toggle]; renderPact(); }));
  $app.querySelectorAll("input[type=file][data-input]").forEach((el) =>
    el.addEventListener("change", () => {
      const mid = el.dataset.input.slice(6);
      state.files[mid] = [...el.files];
      const lab = $app.querySelector(`[data-filecount="${mid}"]`);
      if (lab) lab.textContent = `${el.files.length} image(s) attached`;
    })
  );
  $app.querySelectorAll("input[type=range][data-input]").forEach((el) =>
    el.addEventListener("input", () => { const l = $app.querySelector(`[data-pctlabel="${el.dataset.input.slice(4)}"]`); if (l) l.textContent = `${el.value}%`; })
  );
  $app.querySelectorAll("[data-submit]").forEach((b) =>
    b.addEventListener("click", () => {
      const mid = b.dataset.submit;
      const text = $app.querySelector(`[data-input="text-${mid}"]`)?.value || "";
      const fd = new FormData();
      fd.append("text", text);
      (state.files[mid] || []).forEach((f) => fd.append("images", f));
      busy(`ms-${mid}`, "Arbiter is checking every criterion against the deliverable…", async () => {
        state.pact = await api(`/api/pacts/${p.id}/milestones/${mid}/submit`, { method: "POST", form: fd });
        state.files[mid] = [];
        announce(state.pact, mid);
      });
    })
  );
  $app.querySelectorAll("[data-agent]").forEach((b) =>
    b.addEventListener("click", () =>
      busy(`ms-${b.dataset.agent}`, "🤖 AI seller agent is doing the work, then the arbiter will verify it…", async () => {
        state.pact = await api(`/api/pacts/${p.id}/milestones/${b.dataset.agent}/agent`, { method: "POST" });
        announce(state.pact, b.dataset.agent);
      })
    )
  );
  $app.querySelectorAll("[data-release]").forEach((b) =>
    b.addEventListener("click", () => {
      const mid = b.dataset.release;
      const pct = b.dataset.pct || $app.querySelector(`[data-input="pct-${mid}"]`)?.value || 100;
      busy(`ms-${mid}`, `Capturing ${pct}% on PayPal…`, async () => {
        state.pact = await api(`/api/pacts/${p.id}/milestones/${mid}/release`, { method: "POST", body: { percent: Number(pct) } });
        toast(`Released ${pct}% via PayPal capture`);
      });
    })
  );
  $app.querySelectorAll("[data-dispute]").forEach((b) =>
    b.addEventListener("click", () => {
      const mid = b.dataset.dispute;
      const by = b.dataset.by;
      const txt = $app.querySelector(`[data-input="claim-${by}-${mid}"]`)?.value || "";
      busy(`ms-${mid}`, "🏛️ Advocates are arguing both sides; the judge will rule and PayPal will settle…", async () => {
        state.pact = await api(`/api/pacts/${p.id}/milestones/${mid}/dispute`, { method: "POST", body: by === "buyer" ? { claim: txt, by } : { response: txt, by } });
        Object.keys(state.open).forEach((k) => (state.open[k] = false));
        toast("Tribunal ruled and PayPal settled the milestone");
      });
    })
  );
  $app.querySelector("[data-cancel]")?.addEventListener("click", () => {
    if (!confirm("Cancel the pact? The remaining PayPal hold will be voided and returned to the buyer.")) return;
    busy("cancel", "Cancelling", async () => { state.pact = await api(`/api/pacts/${p.id}/cancel`, { method: "POST", body: { by: "buyer" } }); });
  });
  document.getElementById("refresh")?.addEventListener("click", () =>
    busy("refresh", "Syncing", async () => {
      const r = await api(`/api/pacts/${p.id}/refresh`, { method: "POST" });
      state.pact = r.pact;
      toast(`PayPal says: authorization ${r.authorization?.status}`);
    })
  );
  document.getElementById("redirectFund")?.addEventListener("click", () =>
    busy("redirect", "Opening PayPal", async () => {
      const o = await api(`/api/pacts/${p.id}/paypal/order`, { method: "POST" });
      location.href = o.approveUrl;
    })
  );
}

function announce(p, mid) {
  const m = p.milestones.find((x) => x.id === mid);
  const s = m?.submissions.at(-1);
  if (!s?.verdict) return;
  if (m.status === "released") toast(`Verified ✓ — ${fmt(m.amount, p.currency)} captured on PayPal`);
  else if (m.status === "revision_requested") toast("Arbiter requested a revision — funds stay held");
  else toast("Escalated to the buyer — funds stay held");
}

// ------------------------------------------------------------------ PayPal JS SDK
let sdkPromise;
function loadPayPalSdk() {
  if (window.paypal) return Promise.resolve(window.paypal);
  sdkPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(state.config.paypalClientId)}&currency=USD&intent=authorize&components=buttons&disable-funding=card,credit,paylater,venmo`;
    s.onload = () => resolve(window.paypal);
    s.onerror = () => reject(new Error("Could not load PayPal JS SDK"));
    document.head.appendChild(s);
  });
  return sdkPromise;
}

async function mountPayPal(p) {
  const el = document.getElementById("paypal-buttons");
  if (!el || state.busy.fund) return;
  try {
    const pp = await loadPayPalSdk();
    if (!document.getElementById("paypal-buttons") || el.childElementCount) return;
    pp.Buttons({
      style: { layout: "horizontal", color: "gold", shape: "rect", label: "paypal", tagline: false, height: 45 },
      createOrder: async () => (await api(`/api/pacts/${p.id}/paypal/order`, { method: "POST" })).orderId,
      onApprove: async (data) =>
        busy("fund", "Placing the hold on PayPal…", async () => {
          state.pact = await api(`/api/pacts/${p.id}/paypal/authorize`, { method: "POST", body: { orderID: data.orderID } });
          toast(`${fmt(p.total, p.currency)} held on PayPal — nothing charged yet`);
        }),
      onError: (err) => toast(`PayPal: ${err?.message || err}`, true),
    }).render(el);
  } catch (e) {
    el.innerHTML = `<div class="flags">${esc(e.message)} — use the approval link below instead.</div>`;
  }
}

// ------------------------------------------------------------------ RECEIPT
async function renderReceipt(pid, mid) {
  $app.innerHTML = `<div class="empty">Loading receipt…</div>`;
  let r, v;
  try {
    [r, v] = await Promise.all([api(`/api/pacts/${pid}/receipts/${mid}`), api(`/api/pacts/${pid}/verify`)]);
  } catch (e) {
    $app.innerHTML = `<div class="flags">${esc(e.message)}</div>`;
    return;
  }
  const row = (k, val, mono) => `<div class="rrow"><span>${k}</span><b class="${mono ? "mono" : ""}">${val}</b></div>`;
  $app.innerHTML = `
  <div class="receipt-wrap">
    <div class="row no-print" style="margin-bottom:14px"><a class="btn ghost small" href="#/pact/${esc(pid)}">← Back to pact</a><span class="spacer"></span>
      <button class="btn ghost small" id="copyJson">Copy JSON</button><button class="btn primary small" onclick="window.print()">Print / save PDF</button></div>
    <article class="card receipt">
      <div class="r-head">
        <div><div class="eyebrow">Clause · verifiable escrow receipt</div><h1>${esc(r.milestone.title)}</h1><div class="hint" style="margin:0">${esc(r.pact.title)} · ${esc(r.pact.buyer)} → ${esc(r.pact.seller)}</div></div>
        <div class="r-amt">${fmt(r.settlement.amount, r.pact.currency)}<small>${r.settlement.percent}% of ${fmt(r.milestone.amount, r.pact.currency)}${r.settlement.refunded ? ` · ${fmt(r.settlement.refunded, r.pact.currency)} refunded` : ""}</small></div>
      </div>
      ${r.pact.demo ? `<div class="flags">Demo seed record: not a real PayPal transaction.</div>` : ""}
      <div class="r-stamp ${v.valid ? "ok" : "bad"}">${v.valid ? `✓ Audit chain intact — ${v.checked} events re-hashed just now` : `⚠️ Audit chain broken at event ${v.brokenAt}: ${esc(v.reason)}`}</div>
      <h3>What was agreed</h3>
      <ul class="r-list">${r.milestone.criteria.map((c, i) => `<li><span class="cmark ${r.verdict?.criteria[i]?.result || ""}">${r.verdict?.criteria[i]?.result === "met" ? "✓" : r.verdict?.criteria[i] ? "~" : "·"}</span>${esc(c)}</li>`).join("")}</ul>
      <h3>Evidence</h3>
      ${row("Deliverable SHA-256", esc(r.deliverable?.sha256 || "—"), true)}
      ${row("Submitted", r.deliverable ? `${new Date(r.deliverable.submittedAt).toLocaleString()} · ${r.deliverable.by === "agent" ? "AI seller agent" : "seller"} · attempt ${r.deliverable.attempts}` : "—")}
      ${r.verdict ? row("Arbiter verdict", `${esc(r.verdict.decision.replace("_", " "))} · ${Math.round(r.verdict.confidence * 100)}% confidence${r.verdict.redFlags?.length ? ` · ${r.verdict.redFlags.length} red flag(s)` : ""}`) : ""}
      ${r.verdict ? row("Verdict SHA-256", esc(r.verdict.sha256), true) : ""}
      ${r.verdict?.spendGate ? row("Spend gate", r.verdict.spendGate.autoRelease ? "passed — released automatically" : "held — settled by buyer or tribunal") : ""}
      ${r.disputes.length ? row("Tribunal", r.disputes.map((d) => `${d.awardToSellerPercent}% to seller`).join(", ")) : ""}
      <h3>Money</h3>
      ${row("PayPal capture ID", esc(r.paypal.captureId || "— (nothing captured)"), true)}
      ${row("PayPal authorization", esc(r.paypal.authorizationId || "—"), true)}
      ${row("Settled", `${new Date(r.settlement.settledAt).toLocaleString()} · ${esc(r.settlement.reason)}`)}
      ${row("Event hash", esc(r.chain.eventHash || "—"), true)}
      ${row("Chain head", esc(v.head || "—"), true)}
      <p class="hint">Anyone can check this receipt: the capture ID is verifiable in PayPal (sandbox), the deliverable fingerprint matches only the exact work submitted, and every pact event is SHA-256-chained to the one before it, so editing history breaks the chain.</p>
    </article>
  </div>`;
  document.getElementById("copyJson").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(r, null, 2)); toast("Receipt JSON copied"); } catch { toast("Copy failed", true); }
  });
}

// ------------------------------------------------------------------ ANALYTICS (AG Studio)
let analyticsMode = "view";
async function renderAnalytics() {
  $app.innerHTML = `
    <div class="row analytics-bar">
      <div><h1 style="margin:0;font-size:24px;letter-spacing:-0.02em">Escrow analytics</h1>
        <div class="hint" style="margin:2px 0 0">Every pact, milestone, arbiter verdict and PayPal movement, cross-filterable. Built with AG Studio.</div></div>
      <span class="spacer"></span>
      <span class="chip"><i class="dot ${state.config.aiMode === "claude" ? "ok" : "warn"}"></i>AI Assistant: ${state.config.aiMode === "claude" ? "Claude" : "needs ANTHROPIC_API_KEY"}</span>
      <button class="btn ${analyticsMode === "edit" ? "primary" : "ghost"}" id="studioMode">${analyticsMode === "edit" ? "✓ Editing with AI Assistant" : "✨ Edit & ask the AI Assistant"}</button>
    </div>
    <div id="studio-host" class="studio-host"><div class="empty" style="padding:24px">Loading AG Studio…</div></div>
    <p class="hint">No data yet? Run <code>npm run seed</code> to add clearly-labelled demo history (Data source = "Demo seed"); live sandbox pacts appear as "Live".</p>`;
  document.getElementById("studioMode").addEventListener("click", () => {
    analyticsMode = analyticsMode === "edit" ? "view" : "edit";
    renderAnalytics();
  });
  const host = document.getElementById("studio-host");
  try {
    await mountAnalytics(host, { mode: analyticsMode, onReady: () => host.querySelector(".empty")?.remove() });
  } catch (e) {
    host.innerHTML = `<div class="flags">Could not load AG Studio: ${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------------ HOW
function renderHow() {
  const step = (n, t, d, apis) => `<div class="card step"><div class="n">${n}</div><div><h3>${t}</h3><p>${d}</p>${apis ? `<p style="margin-top:8px">${apis.map((a) => `<span class="api-tag">${a}</span>`).join(" ")}</p>` : ""}</div></div>`;
  $app.innerHTML = `<section class="how">
    <div class="eyebrow">How it works</div>
    <h1>Trust, compiled.</h1>
    <p class="lede">Freelancers fear not getting paid; clients fear paying for nothing. AI agents that buy and sell work have the same problem with no human in the loop. Clause makes the contract executable: the money knows what was promised and checks it was delivered.</p>
    <div class="flow">
      ${step(1, "Describe the deal", "Plain English in, contract out. Claude compiles milestones, amounts and objective acceptance criteria, and flags dispute risks before anyone pays.", ["Claude · structured outputs"])}
      ${step(2, "Buyer funds once — money is held, not charged", "A single PayPal approval creates an order with intent AUTHORIZE. Each milestone is a line item. The authorization keeps funds on hold for the pact.", ["POST /v2/checkout/orders", "POST /v2/checkout/orders/{id}/authorize"])}
      ${step(3, "Seller (human or AI agent) delivers", "Text, images and links are submitted. An AI seller agent can do the work itself — agent-to-agent commerce with escrow in between.", ["Claude · seller agent"])}
      ${step(4, "Arbiter verifies, spend gate decides", "Claude reviews each criterion with quoted evidence and vision. A deterministic policy (all criteria met, no red flags, confidence over threshold) is the only thing that can release funds automatically.", ["Claude · vision + structured outputs", "prompt-injection detection"])}
      ${step(5, "PayPal settles per milestone", "Each verified milestone is a partial capture with final_capture=false, keeping the remaining hold alive. The last capture closes it; anything unearned returns to the buyer automatically.", ["POST /v2/payments/authorizations/{id}/capture", "…/void", "…/reauthorize"])}
      ${step(6, "Disputes → AI tribunal", "Buyer and seller advocates argue in parallel; an independent judge awards a percentage. Clause executes it as a partial capture — or, on appeal of released funds, a partial refund.", ["Claude · multi-agent", "POST /v2/payments/captures/{id}/refund"])}
      ${step(7, "Every step leaves a verifiable receipt", "Each pact event is SHA-256 hash-chained to the one before it, and every deliverable and verdict is fingerprinted. A receipt per milestone ties the work, the verdict and the PayPal capture ID together, and re-checks the chain when opened.", ["SHA-256 hash chain", "GET /api/pacts/{id}/verify"])}
      ${step(8, "Any AI agent can use it", "Clause ships an MCP server, so agents in Claude Desktop or any MCP client can draft pacts, hand the buyer a PayPal approval link, deliver work, and get paid.", ["MCP server · npm run mcp"])}
    </div>
  </section>`;
}

// ------------------------------------------------------------------ boot
document.getElementById("themeToggle")?.addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  safeSet("clause.theme", root.dataset.theme);
  syncThemeIcon();
});
function syncThemeIcon() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const b = document.getElementById("themeToggle");
  if (b) b.textContent = dark ? "☀" : "☾";
}
syncThemeIcon();

(async function boot() {
  try {
    state.config = await api("/api/config");
  } catch {
    state.config = { aiMode: "simulated", model: "?", paypalConfigured: false };
  }
  renderMode();
  navigate();
})();
