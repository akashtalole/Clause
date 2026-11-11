// Where Clause's AI work runs.
// With RENDER_WORKFLOW_SLUG + RENDER_API_KEY set, each AI job is dispatched to the Render Workflows
// service (src/workflows.js) and runs as a retryable task on its own compute. Otherwise it runs
// inline in this process — same functions, same results — so local development needs nothing extra.
import * as ai from "./ai.js";

const SLUG = process.env.RENDER_WORKFLOW_SLUG;
const remote = Boolean(SLUG && process.env.RENDER_API_KEY);
let render = null;

export const runner = () => (remote ? `render-workflows (${SLUG})` : "inline");

async function runOnRender(taskName, args) {
  if (!render) {
    const { Render } = await import("@renderinc/sdk");
    render = new Render();
  }
  const started = Date.now();
  const run = await render.workflows.runTask(`${SLUG}/${taskName}`, args);
  if (run.status !== "completed") throw new Error(`Render task ${taskName} ${run.status}${run.error ? `: ${run.error}` : ""}`);
  const out = Array.isArray(run.results) ? run.results[0] : run.results;
  return { out, meta: { runner: "render-workflows", task: taskName, taskRunId: run.id, wallMs: Date.now() - started } };
}

const tag = (t, meta) => (t ? { ...t, ...meta } : t);

export async function compilePact(text) {
  if (!remote) return ai.compilePact(text);
  const { out, meta } = await runOnRender("compile_pact", [text]);
  return { ...out, trace: tag(out.trace, meta) };
}

export async function arbitrate(input) {
  if (!remote) return ai.arbitrate(input);
  const { out, meta } = await runOnRender("arbitrate", [input]);
  return { ...out, trace: tag(out.trace, meta) };
}

export async function sellerAgent(input) {
  if (!remote) return ai.sellerAgent(input);
  const { out, meta } = await runOnRender("seller_agent", [input]);
  return { ...out, trace: tag(out.trace, meta) };
}

export async function tribunal(input) {
  if (!remote) return ai.tribunal(input);
  const { out, meta } = await runOnRender("tribunal", [input]);
  return { ...out, traces: (out.traces || []).map((t) => tag(t, meta)) };
}
