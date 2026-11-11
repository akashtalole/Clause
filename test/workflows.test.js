// Render Workflows tasks, exercised in-process with a stand-in TaskContext (as the Render SDK
// recommends) against a local fake of the Anthropic Messages API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let fake;
const calls = [];
before(async () => {
  fake = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const j = JSON.parse(b);
      const structured = Boolean(j.output_config?.format);
      calls.push({ at: Date.now(), system: j.system.slice(0, 40), structured });
      const text = structured
        ? JSON.stringify({ findings: ["Two of three criteria met"], award_to_seller_percent: 66.6, rationale: "Partial delivery.", confidence: 0.8 })
        : j.system.includes("buyer's advocate") ? "Buyer: captions exceed the hashtag limit." : "Seller: descriptions are complete.";
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
      }, structured ? 0 : 150);
    });
  });
  await new Promise((r) => fake.listen(0, r));
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${fake.address().port}`;
  process.env.CLAUDE_SERVER_FALLBACKS = "off";
});
after(() => fake.close());

const pact = { title: "Candle copy", summary: "s", currency: "USD" };
const milestone = { title: "Captions", description: "5 captions", amount: 60, criteria: [{ id: "c1", text: "Five captions" }], submissions: [{ text: "#a #b #c", verdict: { decision: "request_revision", criteria: [], red_flags: [] } }] };

test("tribunal task fans out both advocates in parallel, then runs the judge", async () => {
  const wf = await import("../src/workflows.js");
  const runs = [];
  const ctx = { run: async (def, ...args) => { runs.push({ name: def.name, start: Date.now() }); return def.func(ctx, ...args); } };
  const out = await wf.tribunal.func(ctx, { pact, milestone, claim: "Too many hashtags", response: "Mostly done" });
  assert.deepEqual(runs.map((r) => r.name), ["advocate", "advocate", "judge"]);
  assert.ok(runs[1].start - runs[0].start < 100, "advocates start together (parallel), not one after the other");
  assert.equal(out.ruling.award_to_seller_percent, 67);
  assert.match(out.ruling.buyer_argument, /hashtag/);
  assert.match(out.ruling.seller_argument, /complete/);
  assert.ok(out.traces.some((t) => /Render fan-out/.test(t.label)));
});

test("tasks are registered under the names the web service dispatches to", async () => {
  const wf = await import("../src/workflows.js");
  assert.deepEqual([wf.compilePact, wf.arbitrate, wf.sellerAgent, wf.tribunal, wf.advocate, wf.judge].map((t) => t.name), ["compile_pact", "arbitrate", "seller_agent", "tribunal", "advocate", "judge"]);
});
