// Bridge between AG Studio's agent framework (AgLlmAdapter turns) and Claude.
// The browser adapter posts one turn here; we translate AG's conversation items and tool schemas to
// the Messages API, call Claude, and translate the reply back into AG output items.
// Keeping this server-side means the Anthropic key never reaches the browser.
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const uid = (p) => `${p}_${crypto.randomBytes(6).toString("hex")}`;

/** AG conversation items -> { system, messages } for the Messages API. */
export function toAnthropic(request) {
  const systemParts = [request.instructions || ""];
  const messages = [];
  const push = (role, block) => {
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of request.input || []) {
    if (item.type === "message" && item.role === "system") {
      systemParts.push(item.content.map((c) => c.text || "").join("\n"));
    } else if (item.type === "message" && item.role === "user") {
      for (const c of item.content) {
        if (c.type === "text") push("user", { type: "text", text: c.text || " " });
        else if (c.type === "image" && c.imageUrl?.startsWith("data:")) {
          const [, mediaType, data] = c.imageUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
          if (data) push("user", { type: "image", source: { type: "base64", media_type: mediaType, data } });
        } else if (c.type === "image" && c.imageUrl) push("user", { type: "image", source: { type: "url", url: c.imageUrl } });
      }
    } else if (item.type === "message" && item.role === "assistant") {
      const text = item.content.map((c) => c.text || c.refusal || "").join("");
      if (text.trim()) push("assistant", { type: "text", text });
    } else if (item.type === "function_call") {
      let input = {};
      try { input = JSON.parse(item.arguments || "{}"); } catch { /* keep empty */ }
      push("assistant", { type: "tool_use", id: item.callId, name: item.name, input });
    } else if (item.type === "function_call_output") {
      push("user", { type: "tool_result", tool_use_id: item.callId, content: String(item.output ?? "") });
    }
    // reasoning items are not replayed
  }
  if (!messages.length || messages[0].role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });

  const tools = (request.tools || [])
    .filter((t) => t.kind !== "provided")
    .map((t) => ({ name: t.name, description: t.description || t.name, input_schema: normaliseSchema(t.parameters) }));

  // Claude Opus 5.5 does not accept forced tool choice; steer from the prompt instead.
  const choice = request.toolChoice;
  if (choice && typeof choice === "object") systemParts.push(`For this turn you must call the tool "${choice.name}".`);
  else if (choice === "required") systemParts.push("For this turn you must call at least one tool.");

  if (request.responseFormat?.type === "json") {
    systemParts.push(`Reply with only a JSON object (no prose, no code fences) named "${request.responseFormat.name}" that matches this JSON Schema:\n${JSON.stringify(request.responseFormat.schema)}`);
  }
  const effort = EFFORTS.has(request.model?.effort) ? request.model.effort : "medium";
  return {
    system: systemParts.filter(Boolean).join("\n\n"),
    messages,
    tools,
    tool_choice: choice === "none" ? { type: "none" } : tools.length ? { type: "auto" } : undefined,
    effort,
  };
}

function normaliseSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  return schema.type === "object" ? schema : { type: "object", properties: { value: schema }, required: ["value"] };
}

/** Claude response -> AG output items. */
export function fromAnthropic(res) {
  const output = [];
  for (const b of res.content) {
    if (b.type === "text" && b.text.trim()) {
      output.push({ id: uid("msg"), kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: stripFences(b.text), annotations: [] }] });
    } else if (b.type === "tool_use") {
      output.push({ id: uid("fc"), kind: "output", type: "function_call", callId: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), status: "completed" });
    }
  }
  return {
    id: res.id,
    createdAt: Date.now(),
    output,
    status: res.stop_reason === "max_tokens" ? "incomplete" : res.stop_reason === "refusal" ? "failed" : "completed",
    ...(res.stop_reason === "max_tokens" ? { incompleteDetails: { reason: "max_output_tokens" } } : {}),
    ...(res.stop_reason === "refusal" ? { error: { code: "refusal", message: "Claude declined this request." } } : {}),
    usage: { inputTokens: res.usage?.input_tokens || 0, outputTokens: res.usage?.output_tokens || 0 },
    model: res.model,
  };
}

const stripFences = (t) => t.replace(/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, "$1");

export async function runTurn(request) {
  if (!client) {
    return {
      id: uid("sim"),
      createdAt: Date.now(),
      status: "completed",
      output: [{ id: uid("msg"), kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "The AI assistant needs ANTHROPIC_API_KEY in .env to run. The dashboard itself works without it.", annotations: [] }] }],
      model: "simulated",
    };
  }
  const { system, messages, tools, tool_choice, effort } = toAnthropic(request);
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    output_config: { effort },
  });
  return fromAnthropic(res);
}
