// Clause MCP server — lets any MCP-capable AI agent (Claude Desktop, Claude Code, …) buy or sell work
// through Clause escrow on PayPal. It talks to a running Clause server over HTTP (CLAUSE_URL).
//
//   claude mcp add clause -- node /path/to/src/mcp.js        (Claude Code)
//   or add to claude_desktop_config.json (see README)
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.CLAUSE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Clause API ${res.status}`);
  return data;
}

const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });

function summarize(p) {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    currency: p.currency,
    money: p.money,
    url: `${BASE}/#/pact/${p.id}`,
    milestones: p.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      amount: m.amount,
      status: m.status,
      acceptance_criteria: m.criteria.map((c) => c.text),
      last_verdict: m.submissions.at(-1)?.verdict
        ? { decision: m.submissions.at(-1).verdict.decision, feedback: m.submissions.at(-1).verdict.feedback_to_seller, criteria: m.submissions.at(-1).verdict.criteria.map((c) => ({ id: c.criterion_id, result: c.result })) }
        : null,
    })),
    current_milestone_id: p.currentMilestoneId,
  };
}

const server = new McpServer({ name: "clause-escrow", version: "1.0.0" });

server.registerTool(
  "draft_pact",
  {
    title: "Draft an escrow pact",
    description: "Compile a plain-English deal (what is bought, price, deliverables) into a milestone escrow contract with objective acceptance criteria. Returns a draft to review; nothing is created or charged.",
    inputSchema: { deal: z.string().describe("Deal description, including price and deliverables") },
  },
  async ({ deal }) => {
    try {
      const r = await api("/api/pacts/draft", { method: "POST", body: { text: deal } });
      return ok(r.draft);
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "create_pact",
  {
    title: "Create pact and get PayPal funding link",
    description: "Compile and create an escrow pact, then create a PayPal order (intent AUTHORIZE). Returns a PayPal approval URL the human buyer must open to place the hold. Funds are not charged until milestones are verified.",
    inputSchema: {
      deal: z.string().describe("Deal description, including price and deliverables"),
      seller_is_agent: z.boolean().optional().describe("True if an AI agent will do the work"),
    },
  },
  async ({ deal, seller_is_agent }) => {
    try {
      const { draft, trace } = await api("/api/pacts/draft", { method: "POST", body: { text: deal } });
      const pact = await api("/api/pacts", { method: "POST", body: { draft, trace, sellerKind: seller_is_agent ? "agent" : "human" } });
      const order = await api(`/api/pacts/${pact.id}/paypal/order`, { method: "POST" });
      return ok({ ...summarize(pact), paypal_approval_url: order.approveUrl, next_step: "Ask the buyer to open paypal_approval_url and approve. Then poll get_pact until status is 'active'." });
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "get_pact",
  { title: "Get pact status", description: "Get the status of a pact: funding, milestones, verdicts, and money released/held.", inputSchema: { pact_id: z.string() } },
  async ({ pact_id }) => {
    try { return ok(summarize(await api(`/api/pacts/${pact_id}`))); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_pacts",
  { title: "List pacts", description: "List recent escrow pacts.", inputSchema: {} },
  async () => {
    try { return ok((await api("/api/pacts")).slice(0, 20).map((p) => ({ id: p.id, title: p.title, status: p.status, total: p.total, released: p.money.released }))); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "submit_deliverable",
  {
    title: "Submit work for a milestone",
    description: "As the seller, submit the deliverable (text) for the current milestone. Clause's arbiter verifies it against the acceptance criteria; if it passes the spend gate, the milestone amount is captured to the seller on PayPal immediately. Returns the verdict and feedback.",
    inputSchema: { pact_id: z.string(), milestone_id: z.string(), deliverable: z.string().describe("The complete work product") },
  },
  async ({ pact_id, milestone_id, deliverable }) => {
    try {
      const fd = new FormData();
      fd.append("text", deliverable);
      const res = await fetch(`${BASE}/api/pacts/${pact_id}/milestones/${milestone_id}/submit`, { method: "POST", body: fd });
      const p = await res.json();
      if (!res.ok) throw new Error(p.error);
      const m = p.milestones.find((x) => x.id === milestone_id);
      return ok({ milestone_status: m.status, verdict: m.submissions.at(-1)?.verdict, spend_gate: m.submissions.at(-1)?.gate, money: p.money });
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "release_milestone",
  {
    title: "Approve and release a milestone",
    description: "As the buyer, approve the current milestone and capture `percent` of its amount to the seller on PayPal. Use only with explicit human approval.",
    inputSchema: { pact_id: z.string(), milestone_id: z.string(), percent: z.number().min(0).max(100).default(100) },
    annotations: { destructiveHint: true },
  },
  async ({ pact_id, milestone_id, percent }) => {
    try { return ok(summarize(await api(`/api/pacts/${pact_id}/milestones/${milestone_id}/release`, { method: "POST", body: { percent } }))); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "open_dispute",
  {
    title: "Send a milestone to the AI tribunal",
    description: "Open a dispute on a milestone. Two AI advocates argue; an AI judge awards a percentage to the seller, which Clause settles on PayPal (capture or refund).",
    inputSchema: { pact_id: z.string(), milestone_id: z.string(), statement: z.string(), as: z.enum(["buyer", "seller"]) },
    annotations: { destructiveHint: true },
  },
  async ({ pact_id, milestone_id, statement, as }) => {
    try {
      const body = as === "buyer" ? { claim: statement, by: "buyer" } : { response: statement, by: "seller" };
      return ok(summarize(await api(`/api/pacts/${pact_id}/milestones/${milestone_id}/dispute`, { method: "POST", body })));
    } catch (e) { return fail(e); }
  }
);

await server.connect(new StdioServerTransport());
console.error(`Clause MCP server ready (API: ${BASE})`);
