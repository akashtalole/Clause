// Quick environment check: PayPal sandbox auth + order creation, and a tiny Claude call.
//   npm run smoke
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import * as paypal from "../src/paypal.js";

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);

console.log("\nClause smoke test\n");
try {
  await paypal.ping();
  ok("PayPal sandbox OAuth token");
  const o = await paypal.createEscrowOrder({ id: "smoke", title: "Smoke test", currency: "USD", total: 10, milestones: [{ title: "A", description: "a", amount: 4 }, { title: "B", description: "b", amount: 6 }] });
  ok(`PayPal order ${o.orderId} created (${o.status}) — approve: ${o.approveUrl}`);
} catch (e) {
  bad(`PayPal: ${e.message}`);
}

if (!process.env.ANTHROPIC_API_KEY) {
  bad("ANTHROPIC_API_KEY not set — app will run in simulated-AI mode");
} else {
  try {
    const client = new Anthropic();
    const r = await client.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
      max_tokens: 200,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
    });
    ok(`Claude (${r.model}) replied: ${r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim()}`);
  } catch (e) {
    bad(`Claude: ${e.message}`);
  }
}
console.log("");
