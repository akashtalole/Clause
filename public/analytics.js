// Escrow analytics: an AG Studio dashboard over Clause's pacts, milestones, arbiter reviews and
// PayPal ledger. Its AI assistant runs AG Studio's built-in agents on Claude (through the Clause
// server) plus a custom "Escrow risk analyst" agent with tools that read live pact data.
let studioApi = null;
let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadStudio() {
  loading ||= (async () => {
    await loadScript("/vendor/ag-studio/ag-studio.min.js");
    const ag = window.agStudio;
    ag.AgStudioModuleRegistry.registerModules([ag.AgStudioAiModule]);
    const cfg = await fetch("/api/analytics/config").then((r) => r.json());
    if (cfg.licenseKey) ag.AgStudioLicenseManager.setLicenseKey(cfg.licenseKey);
    return ag;
  })();
  return loading;
}

// ------------------------------------------------------------------ Claude adapter (AgLlmAdapter)
// One turn = one POST to /api/ai/turn, where the server calls Claude. We replay the finished turn
// as AG-UI events so the chat panel renders text and tool calls.
export const claudeAdapter = {
  executeTurn(request, options = {}) {
    const complete = fetch("/api/ai/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) return { id: `err_${Date.now()}`, createdAt: Date.now(), status: "failed", output: [], error: { code: String(r.status), message: data.error || "AI request failed" } };
      return data;
    });
    const stream = {
      async *[Symbol.asyncIterator]() {
        const res = await complete;
        if (res.error) {
          yield { type: "RUN_ERROR", message: res.error.message, code: res.error.code };
          return;
        }
        for (const item of res.output) {
          if (item.type === "message") {
            yield { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" };
            for (const c of item.content) if (c.text) yield { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: c.text };
            yield { type: "TEXT_MESSAGE_END", messageId: item.id };
          } else if (item.type === "function_call") {
            yield { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name, parentMessageId: item.id };
            yield { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments };
            yield { type: "TOOL_CALL_END", toolCallId: item.callId };
          }
        }
      },
    };
    return { stream, complete };
  },
};

// ------------------------------------------------------------------ Clause theme
// Every value points at a Clause design token (public/styles.css), so Studio renders as part of the
// page: cards, type and chart colours match the escrow meter (mint = released, amber = held, …).
function clauseTheme(ag) {
  const token = (name) => `var(--${name})`;
  const line = (color) => ({ width: 1, color: token(color) });
  // Ordered so categories sort onto meaningful colours (escalate→violet, release→mint, revision→amber).
  const chartColors = ["violet", "mint", "amber", "sky", "rose", "ink-2", "mint-deep", "muted"];
  const palette = Object.fromEntries(
    chartColors.flatMap((c, i) => [
      [`chartPaletteFills${i + 1}Color`, token(c)],
      [`chartPaletteStrokes${i + 1}Color`, token(c)],
    ])
  );
  return ag.studioTheme.withParams({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 14,
    textColor: token("ink"),
    foregroundColor: token("ink"),
    subtleTextColor: token("muted"),
    backgroundColor: token("card"),
    borderColor: token("line"),
    accentColor: token("mint-deep"),
    iconColor: token("ink-2"),

    studioWrapperBorder: false,
    studioWrapperBorderRadius: 0,
    studioWrapperSpacing: 0,
    studioWrapperBackgroundColor: token("bg"),
    studioCanvasBorder: false,
    studioCanvasBorderRadius: 0,
    studioCanvasShadow: false,
    studioCanvasBackgroundColor: token("bg"),
    studioCanvasPadding: 14,
    studioCanvasRowHeight: 17,
    studioCanvasFontFamily: "Inter, system-ui, sans-serif",

    studioWidgetBackgroundColor: token("card"),
    studioWidgetBorder: line("line"),
    studioWidgetBorderRadius: 14,
    studioWidgetPadding: 12,
    studioWidgetTitleFontFamily: "Inter, system-ui, sans-serif",
    studioWidgetTitleFontSize: 15,
    studioWidgetTitleFontWeight: 600,
    studioWidgetTitleTextColor: token("ink"),
    studioWidgetResizeBorderColor: token("mint-deep"),

    studioPanelContainerBackgroundColor: token("card"),
    studioPanelContainerBorder: line("line"),
    studioPanelHeaderFontWeight: 600,
    studioToggleButtonActiveBackgroundColor: token("mint-soft"),
    studioToggleButtonActiveBorderColor: token("mint-deep"),
    studioToggleButtonActiveColor: token("mint-deep"),

    gridFontFamily: "Inter, system-ui, sans-serif",
    gridFontSize: 14,
    gridCellTextColor: token("ink"),
    gridHeaderBackgroundColor: token("card"),
    gridHeaderTextColor: token("muted"),
    gridHeaderFontWeight: 600,
    gridRowHeight: 38,
    gridRowBorder: line("line"),
    gridWrapperBorder: false,

    chartFontFamily: "Inter, system-ui, sans-serif",
    chartTextColor: token("ink"),
    chartSubtleTextColor: token("muted"),
    chartAxisLineColor: token("line"),
    chartGridLineColor: token("line"),
    ...palette,
  });
}

// ------------------------------------------------------------------ custom agent + tools
const RISK_INSTRUCTIONS = `You are Clause's Escrow risk analyst, embedded in an AG Studio dashboard.
Clause is AI-verified milestone escrow on PayPal: buyers fund a pact once (a PayPal authorization hold),
each milestone is released as a partial capture only when an AI arbiter verifies the work and a
deterministic spend gate passes, and disputes go to an AI tribunal that can capture partially or refund.

Use clause_list_pacts and clause_get_pact for live, per-pact detail (verdicts, red flags, ledger,
schedule risk). Use the Studio tools (view_schema, execute_query) for aggregate questions over the
dashboard data. When the user wants a chart, KPI or new page, delegate to the dashboard lead agent with
a precise brief (fields, aggregation, chart type) instead of describing it in prose.

Be concrete: name pacts, amounts in USD and PayPal states (held, captured, refunded). Rows whose
data source is "Demo seed" are generated demo history, not real transactions; say so when relevant.
Never claim you moved money: only the buyer, the arbiter's spend gate, or the tribunal can.`;

function clauseTools(api) {
  const listPacts = api.defineAiTool({
    name: "clause_list_pacts",
    description: "List Clause escrow pacts with status, money held/released, open milestone, red flags and schedule risk.",
    params: (s) => s.object({ status: s.enum(["awaiting_funding", "active", "completed", "cancelled"]).optional(), include_demo: s.boolean().optional() }),
    async execute(args, ctx) {
      const all = await fetch("/api/pacts").then((r) => r.json());
      const rows = all
        .filter((p) => (args.status ? p.status === args.status : true) && (args.include_demo === false ? !p.demo : true))
        .slice(0, 60)
        .map((p) => {
          const open = p.milestones.find((m) => m.id === p.currentMilestoneId);
          const flags = p.milestones.flatMap((m) => m.submissions).filter((s) => s.verdict?.red_flags?.length).length;
          return { id: p.id, title: p.title, status: p.status, demo: Boolean(p.demo), seller: `${p.seller.name} (${p.seller.kind})`, total: p.total, held: p.money.held, released: p.money.released, refunded: p.money.refunded, open_milestone: open ? `${open.title}: ${open.status}` : null, red_flagged_reviews: flags, at_risk_milestones: (p.schedule || []).filter((s) => s.atRisk).length };
        });
      return ctx.success(JSON.stringify(rows));
    },
  });
  const getPact = api.defineAiTool({
    name: "clause_get_pact",
    description: "Full detail of one pact: milestones with acceptance criteria, the latest arbiter verdict and spend-gate reasons, disputes, and the PayPal ledger.",
    params: (s) => s.object({ pact_id: s.string({ description: "Pact id, e.g. pact_ab12cd34ef" }) }),
    async execute(args, ctx) {
      const r = await fetch(`/api/pacts/${encodeURIComponent(args.pact_id)}`);
      if (!r.ok) return ctx.error(`No pact ${args.pact_id}`);
      const p = await r.json();
      return ctx.success(
        JSON.stringify({
          id: p.id, title: p.title, status: p.status, demo: Boolean(p.demo), money: p.money,
          milestones: p.milestones.map((m) => {
            const s = m.submissions.at(-1);
            return { title: m.title, amount: m.amount, status: m.status, criteria: m.criteria.map((c) => c.text), attempts: m.submissions.length, last_verdict: s?.verdict ? { decision: s.verdict.decision, confidence: s.verdict.confidence, red_flags: s.verdict.red_flags, feedback: s.verdict.feedback_to_seller, spend_gate: s.gate } : null, settlement: m.settlement, disputes: m.disputes.map((d) => ({ award: d.ruling?.award_to_seller_percent, rationale: d.ruling?.rationale })) };
          }),
          ledger: p.ledger.map((l) => ({ at: l.at, kind: l.kind, amount: l.amount, paypal_id: l.paypalId })),
        })
      );
    },
  });
  const openPact = api.defineAiTool({
    name: "clause_open_pact",
    description: "Open a pact's page in the Clause app so the user can act on it (fund, approve, dispute).",
    params: (s) => s.object({ pact_id: s.string() }),
    execute(args, ctx) {
      location.hash = `#/pact/${encodeURIComponent(args.pact_id)}`;
      return ctx.success(`Opened ${args.pact_id}.`);
    },
  });
  return [listPacts, getPact, openPact];
}

function buildHarness(ag, api) {
  return ag.createAiHarness(api, ({ builtIn }) => {
    const studioAgents = Object.values(builtIn).map((def) => ag.directLlmRunner({ ...def, adapter: claudeAdapter }));
    const custom = clauseTools(api);
    const analyst = ag.directLlmRunner({
      id: "clause-risk",
      name: "Escrow risk analyst",
      description: "Answers questions about Clause escrow pacts, PayPal money states, arbiter verdicts and risk, using live pact data.",
      adapter: claudeAdapter,
      maxTurns: 20,
      instructions: () => RISK_INSTRUCTIONS,
      tools: (ctx) => [...custom, ctx.studio.viewSchema(), ctx.studio.executeQuery(), ctx.tools.delegateTo(["lead"])],
    });
    return {
      agents: [analyst, ...studioAgents],
      primary: "clause-risk",
      models: [
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: [{ id: "low", label: "Fast" }, { id: "medium", label: "Balanced" }, { id: "high", label: "Thorough" }] },
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: [{ id: "low", label: "Fast" }, { id: "medium", label: "Balanced" }] },
      ],
      promptStarters: [
        { label: "Which pacts need attention?", prompt: "Which active pacts need attention right now? Look for escalated or revision-requested milestones, red flags and schedule risk, and rank them." },
        { label: "Human vs AI sellers", prompt: "Compare human sellers and AI-agent sellers: arbiter confidence, revision rate, disputes and money released." },
        { label: "Chart: red flags by week", prompt: "Add a chart showing red-flagged arbiter reviews per week, split by who submitted the work." },
        { label: "Explain the spend gate", prompt: "Pick one milestone where funds were held, and explain why the spend gate held them." },
      ],
    };
  });
}

export async function mountAnalytics(el, { onReady, mode = "view", blank = false, ai = true } = {}) {
  const ag = await loadStudio();
  const [data, saved] = await Promise.all([
    fetch("/api/analytics/data").then((r) => r.json()),
    blank ? null : fetch("/dashboard-state.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  for (const src of data.sources) for (const f of src.fields || []) if (f.format === "currencyFormat") f.formatOptions = { format: usd };
  studioApi?.destroy();
  studioApi = ag.createStudio(el, {
    data,
    mode,
    ...(saved ? { initialState: saved } : {}),
    theme: clauseTheme(ag),
    // The AI Assistant lives in edit mode; keep it on the left and the editing panels on the right.
    panels: { edit: { left: ["ai"], right: ["edit", "data"] } },
    ...(ai ? { ai: ({ api }) => buildHarness(ag, api) } : {}),
    onStudioReady: () => onReady?.(studioApi),
  });
  return studioApi;
}

export function destroyAnalytics() {
  studioApi?.destroy();
  studioApi = null;
}

export const getStudioApi = () => studioApi;
