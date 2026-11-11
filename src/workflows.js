// Render Workflows service: Clause's AI agents as distributed, retryable tasks.
// Deploy this file as a Render Workflow (start command: `node src/workflows.js`).
//
//   compile_pact  — contract compiler
//   arbitrate     — evidence-based arbiter (text + vision)
//   seller_agent  — AI freelancer that does the work
//   tribunal      — fans out two advocate tasks in parallel on separate compute, then runs the judge task
//
// Money never moves inside a task. Tasks only return AI output; the Clause web service applies the
// deterministic spend gate and calls PayPal, so a retried task can never double-capture.
import "dotenv/config";
import { task } from "@renderinc/sdk/workflows";
import * as ai from "./ai.js";

const retry = { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 };

export const compilePact = task({ name: "compile_pact", retry, timeoutSeconds: 300 }, async function compile_pact(ctx, text) {
  return ai.compilePact(text);
});

export const arbitrate = task({ name: "arbitrate", retry, timeoutSeconds: 600 }, async function arbitrate(ctx, input) {
  return ai.arbitrate(input);
});

export const sellerAgent = task({ name: "seller_agent", retry, timeoutSeconds: 600 }, async function seller_agent(ctx, input) {
  return ai.sellerAgent(input);
});

export const advocate = task({ name: "advocate", retry, timeoutSeconds: 300 }, async function advocate(ctx, record, side) {
  return ai.advocate(record, side);
});

export const judge = task({ name: "judge", retry, timeoutSeconds: 300 }, async function judge(ctx, record, buyerArg, sellerArg) {
  return ai.judge(record, buyerArg, sellerArg);
});

export const tribunal = task({ name: "tribunal", timeoutSeconds: 900 }, async function tribunal(ctx, input) {
  if (ai.aiMode() !== "claude") return ai.tribunal(input);
  const record = ai.tribunalRecord(input);
  const started = Date.now();
  // The two advocates run at the same time, each on its own compute.
  const [b, s] = await Promise.all([ctx.run(advocate, record, "buyer"), ctx.run(advocate, record, "seller")]);
  const j = await ctx.run(judge, record, b.text, s.text);
  return {
    ruling: { ...j.ruling, buyer_argument: b.text, seller_argument: s.text },
    traces: [b.trace, s.trace, j.trace, { label: "Tribunal (Render fan-out)", model: "render-workflows", effort: "-", ms: Date.now() - started, mode: "claude" }],
  };
});
