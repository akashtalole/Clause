// Builds the default "Escrow health" AG Studio dashboard by calling Studio's own AI tools
// (add_widget / configure_widget) in a headless browser, then saves the resulting report state to
// public/dashboard-state.json, which the app loads as the initial dashboard.
// Dev-only: needs a running Clause server (CLAUSE_URL) and Playwright.
//   CLAUSE_URL=http://localhost:3000 node scripts/build-dashboard.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const URL = process.env.CLAUSE_URL || "http://localhost:3000";
const title = (text) => ({ title: { enabled: true, text } });
const sum = (id) => ({ id, aggregation: "sum" });
const avg = (id) => ({ id, aggregation: "avg" });
const count = (id) => ({ id, aggregation: "count" });

// x/y are on Studio's 24-column canvas grid.
const WIDGETS = [
  { id: "kpi_funded", type: "value", x: 0, y: 0, w: 6, h: 7, value: { format: title("Escrow funded on PayPal"), dataMapping: { value: [sum("pacts.escrow_total")] } } },
  { id: "kpi_released", type: "value", x: 6, y: 0, w: 6, h: 7, value: { format: title("Released to sellers"), dataMapping: { value: [sum("pacts.released")] } } },
  { id: "kpi_confidence", type: "value", x: 12, y: 0, w: 6, h: 7, value: { format: title("Avg arbiter confidence (%)"), dataMapping: { value: [avg("reviews.confidence")] } } },
  { id: "kpi_flags", type: "value", x: 18, y: 0, w: 6, h: 7, value: { format: title("Manipulation attempts blocked"), dataMapping: { value: [sum("pacts.red_flags")] } } },

  { id: "filter_seller", type: "list-filter", x: 0, y: 7, w: 8, h: 5, value: { format: title("Seller type"), dataMapping: { value: [{ id: "pacts.seller_type" }] } } },
  { id: "filter_status", type: "list-filter", x: 8, y: 7, w: 8, h: 5, value: { format: title("Pact status"), dataMapping: { value: [{ id: "pacts.status" }] } } },
  { id: "filter_source", type: "list-filter", x: 16, y: 7, w: 8, h: 5, value: { format: title("Data source"), dataMapping: { value: [{ id: "pacts.data_source" }] } } },

  {
    id: "chart_released", type: "column-chart-stacked", x: 0, y: 12, w: 15, h: 17,
    value: { format: title("Money released to sellers per week, by seller type"), dataMapping: { categoryKey: [{ id: "pacts.funded_date::week" }], valueKey: [sum("pacts.released")], legendKey: [{ id: "pacts.seller_type" }] } },
  },
  { id: "chart_decisions", type: "donut-chart", x: 15, y: 12, w: 9, h: 17, value: { format: title("Arbiter decisions"), dataMapping: { categoryKey: [{ id: "reviews.decision" }], valueKey: [count("reviews.review_id")] } } },

  {
    id: "chart_quality", type: "bar-chart-grouped", x: 0, y: 29, w: 12, h: 16,
    value: { format: title("Human vs AI-agent sellers: verification quality"), dataMapping: { categoryKey: [{ id: "pacts.seller_type" }], valueKey: [avg("reviews.confidence"), avg("reviews.criteria_met_pct")] } },
  },
  { id: "chart_flow", type: "funnel-chart", x: 12, y: 29, w: 12, h: 16, value: { format: title("PayPal money flow (hold → capture → refund)"), dataMapping: { categoryKey: [{ id: "ledger.kind" }], valueKey: [sum("ledger.amount")] } } },

  {
    id: "grid_pacts", type: "grid", x: 0, y: 45, w: 24, h: 18,
    value: {
      format: title("Pacts"),
      dataMapping: { cols: [{ id: "pacts.title" }, { id: "pacts.seller_type" }, { id: "pacts.status" }, sum("pacts.escrow_total"), sum("pacts.released"), sum("pacts.disputes"), sum("pacts.red_flags")] },
    },
  },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${URL}/#/`);
  const result = await page.evaluate(async (widgets) => {
    document.body.innerHTML = '<div id="s" style="height:980px;width:1420px"></div>';
    const m = await import("/analytics.js");
    const api = await new Promise((res, rej) => {
      m.mountAnalytics(document.getElementById("s"), { onReady: res, mode: "edit", blank: true }).catch(rej);
      setTimeout(() => rej(new Error("Studio did not become ready")), 30000);
    });
    const ag = window.agStudio;
    const tools = api.getAiTools();
    const call = (tool, args) => tool.execute({ toolCallId: `c${Math.random()}`, name: tool.name, args }, ag.createAiToolContext());
    const log = [];
    for (const w of widgets) {
      const a = await call(tools.addWidget(), { widgetId: w.id, type: w.type, xTrack: w.x, yTrack: w.y, xSpan: w.w, ySpan: w.h });
      const c = await call(tools.configureWidget({ widgetType: w.type }), { widgetId: w.id, op: "patch", value: { type: w.type, ...w.value } });
      log.push(`${w.id}: add=${a.success} configure=${c.success}${c.success ? "" : " " + JSON.stringify(c.issues || c.response).slice(0, 400)}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
    return { log, state: api.getState() };
  }, WIDGETS);
  console.log(result.log.join("\n"));
  const out = path.join(__dirname, "..", "public", "dashboard-state.json");
  fs.writeFileSync(out, JSON.stringify(result.state, null, 2));
  await page.screenshot({ path: process.env.SHOT || path.join(require("os").tmpdir(), "dashboard.png") });
  console.log(`Saved ${out}`);
  await browser.close();
})();
