import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pacts from "./pacts.js";
import * as store from "./store.js";
import * as paypal from "./paypal.js";
import { aiMode, modelName, AIRefusalError } from "./ai.js";
import { runner } from "./jobs.js";
import { PayPalError } from "./paypal.js";
import { buildTables } from "./analytics.js";
import { runTurn } from "./studioAi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Behind Render's (or any) TLS proxy: trust X-Forwarded-Proto so PayPal return URLs are https.
app.set("trust proxy", 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 4 } });
const PORT = Number(process.env.PORT || 3000);
const baseUrl = (req) => process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "..", "public")));
// Bryntum Gantt (trial package) for the delivery timeline — served straight from node_modules.
app.use("/vendor/bryntum", express.static(path.join(here, "..", "node_modules", "@bryntum", "gantt"), { index: false }));
// AG Studio (UMD build) for the escrow analytics dashboard — served straight from node_modules.
app.use("/vendor/ag-studio", express.static(path.join(here, "..", "node_modules", "ag-studio", "dist", "umd"), { index: false }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- config / health
app.get("/api/config", (req, res) => {
  res.json({
    paypalClientId: process.env.PAYPAL_SANDBOX_CLIENT_ID || null,
    paypalConfigured: paypal.isConfigured(),
    currency: "USD",
    aiMode: aiMode(),
    model: modelName(),
    aiRunner: runner(),
    buyerHint: process.env.PAYPAL_BUYER_EMAIL || null,
    businessEmail: process.env.PAYPAL_BUSINESS_EMAIL || null,
  });
});

app.get("/api/health", wrap(async (req, res) => {
  let paypalOk = false;
  try { paypalOk = await paypal.ping(); } catch { /* reported below */ }
  res.json({ ok: true, paypal: paypalOk, ai: aiMode() });
}));

// ---------------------------------------------------------------- pacts
app.post("/api/pacts/draft", wrap(async (req, res) => {
  res.json(await pacts.draftFromText(req.body?.text));
}));

app.post("/api/pacts", wrap(async (req, res) => {
  const { draft, trace, sellerKind } = req.body || {};
  res.status(201).json(pacts.createPact(draft, { trace, sellerKind }));
}));

app.get("/api/pacts", (req, res) => res.json(pacts.list()));
app.get("/api/pacts/:id", (req, res) => res.json(pacts.get(req.params.id)));

// Live updates (server-sent events) so buyer & seller screens update as agents act.
app.get("/api/pacts/:id/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const onChange = (p) => {
    if (p.id === req.params.id) res.write(`data: ${JSON.stringify(pacts.get(p.id))}\n\n`);
  };
  store.events.on("change", onChange);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    store.events.off("change", onChange);
  });
});

// ---------------------------------------------------------------- PayPal funding
app.post("/api/pacts/:id/paypal/order", wrap(async (req, res) => {
  res.json(await pacts.startFunding(req.params.id, { baseUrl: baseUrl(req) }));
}));

app.post("/api/pacts/:id/paypal/authorize", wrap(async (req, res) => {
  res.json(await pacts.completeFunding(req.params.id, req.body?.orderID));
}));

// Redirect-flow fallback (used by agents / MCP clients that hand the buyer an approval link).
app.get("/paypal/return", wrap(async (req, res) => {
  const { pact, token } = req.query;
  try {
    await pacts.completeFunding(String(pact), String(token || ""));
  } catch (e) {
    console.error("return handler:", e.message);
  }
  res.redirect(`/#/pact/${pact}`);
}));

app.get("/api/pacts/:id/verify", (req, res) => res.json(pacts.verifyPact(req.params.id)));
app.get("/api/pacts/:id/receipts/:mid", (req, res) => res.json(pacts.receipt(req.params.id, req.params.mid)));

app.post("/api/pacts/:id/refresh", wrap(async (req, res) => res.json(await pacts.refreshFromPayPal(req.params.id))));
app.post("/api/pacts/:id/reauthorize", wrap(async (req, res) => res.json(await pacts.reauthorize(req.params.id))));
app.post("/api/pacts/:id/cancel", wrap(async (req, res) => res.json(await pacts.cancelPact(req.params.id, req.body || {}))));

// ---------------------------------------------------------------- milestones
app.post("/api/pacts/:id/milestones/:mid/submit", upload.array("images", 4), wrap(async (req, res) => {
  const images = (req.files || [])
    .filter((f) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(f.mimetype))
    .map((f) => ({ name: f.originalname, mediaType: f.mimetype, data: f.buffer.toString("base64") }));
  const links = String(req.body?.links || "").split(/\s+/).filter((l) => /^https?:\/\//.test(l)).slice(0, 5);
  res.json(await pacts.submitDeliverable(req.params.id, req.params.mid, { text: req.body?.text, images, links, by: "seller" }));
}));

app.post("/api/pacts/:id/milestones/:mid/agent", wrap(async (req, res) => {
  res.json(await pacts.runSellerAgent(req.params.id, req.params.mid));
}));

app.post("/api/pacts/:id/milestones/:mid/release", wrap(async (req, res) => {
  res.json(await pacts.buyerRelease(req.params.id, req.params.mid, req.body || {}));
}));

app.post("/api/pacts/:id/milestones/:mid/dispute", wrap(async (req, res) => {
  res.json(await pacts.openDispute(req.params.id, req.params.mid, req.body || {}));
}));

// ---------------------------------------------------------------- analytics (AG Studio)
app.get("/api/analytics/data", (req, res) => res.json(buildTables({ includeDemo: req.query.demo !== "0" })));
app.get("/api/analytics/config", (req, res) => res.json({ licenseKey: process.env.AG_STUDIO_LICENSE_KEY || null }));

// One AG Studio agent turn, executed by Claude (see src/studioAi.js).
app.post("/api/ai/turn", express.json({ limit: "8mb" }), wrap(async (req, res) => {
  res.json(await runTurn(req.body || {}));
}));

// ---------------------------------------------------------------- maintenance (called by the Render cron job)
app.post("/api/maintenance/sweep", wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get("x-cron-secret") !== secret) return res.status(401).json({ error: "unauthorized" });
  res.json(await pacts.sweep());
}));

// ---------------------------------------------------------------- errors
app.use((err, req, res, _next) => {
  const status = err.status && err.status < 600 ? err.status : 500;
  const body = { error: err.message };
  if (err instanceof PayPalError) Object.assign(body, { source: "paypal", paypal: { name: err.paypalName, details: err.details, debugId: err.debugId } });
  if (err instanceof AIRefusalError) body.source = "ai";
  if (status >= 500) console.error(err);
  res.status(err instanceof PayPalError && status < 500 ? 422 : status).json(body);
});

app.listen(PORT, () => {
  console.log(`\n  Clause running on http://localhost:${PORT}`);
  console.log(`  AI: ${modelName()} (runs ${runner()})   PayPal sandbox: ${paypal.isConfigured() ? "configured" : "MISSING CREDENTIALS"}\n`);
});
