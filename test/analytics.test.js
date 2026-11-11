// Unit tests for the AG Studio <-> Claude bridge and the analytics tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnthropic, fromAnthropic } from "../src/studioAi.js";

test("AG Studio turn -> Messages API: roles, tool calls and tool results map correctly", () => {
  const req = {
    instructions: "You are the analyst.",
    input: [
      { type: "message", role: "system", content: [{ type: "text", text: "Dashboard has 4 tables." }] },
      { type: "message", role: "user", content: [{ type: "text", text: "Which pacts need attention?" }] },
      { type: "message", role: "assistant", content: [{ type: "text", text: "Checking." }] },
      { type: "function_call", callId: "call_1", name: "clause_list_pacts", arguments: '{"status":"active"}' },
      { type: "function_call_output", callId: "call_1", output: "[]", status: "completed" },
    ],
    tools: [
      { name: "clause_list_pacts", description: "List pacts", parameters: { type: "object", properties: { status: { type: "string" } } } },
      { name: "web_search", description: "x", parameters: {}, kind: "provided" },
    ],
    toolChoice: { name: "clause_list_pacts" },
    responseFormat: { type: "text" },
    model: { id: "claude-opus-5-5", effort: "high" },
  };
  const out = toAnthropic(req);
  assert.match(out.system, /You are the analyst\./);
  assert.match(out.system, /Dashboard has 4 tables\./);
  assert.match(out.system, /must call the tool "clause_list_pacts"/, "forced tool choice becomes a prompt instruction");
  assert.deepEqual(out.tool_choice, { type: "auto" });
  assert.equal(out.effort, "high");
  assert.deepEqual(out.tools.map((t) => t.name), ["clause_list_pacts"], "provider-hosted tools are not forwarded");
  assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant", "user"]);
  const assistant = out.messages[1].content;
  assert.equal(assistant[1].type, "tool_use");
  assert.deepEqual(assistant[1].input, { status: "active" });
  assert.equal(out.messages[2].content[0].type, "tool_result");
  assert.equal(out.messages[2].content[0].tool_use_id, "call_1");
});

test("Messages API reply -> AG output items", () => {
  const res = fromAnthropic({
    id: "msg_1",
    model: "claude-opus-5-5",
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: "Looking up pacts." },
      { type: "tool_use", id: "toolu_9", name: "clause_get_pact", input: { pact_id: "pact_x" } },
    ],
  });
  assert.equal(res.status, "completed");
  assert.equal(res.output.length, 2);
  assert.equal(res.output[0].type, "message");
  assert.equal(res.output[1].type, "function_call");
  assert.equal(res.output[1].callId, "toolu_9");
  assert.deepEqual(JSON.parse(res.output[1].arguments), { pact_id: "pact_x" });
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5 });
});

test("JSON response format asks for schema-shaped JSON and strips code fences", () => {
  const out = toAnthropic({ input: [{ type: "message", role: "user", content: [{ type: "text", text: "plan" }] }], responseFormat: { type: "json", name: "plan", schema: { type: "object" } } });
  assert.match(out.system, /Reply with only a JSON object/);
  const res = fromAnthropic({ id: "m", model: "x", stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: '```json\n{"a":1}\n```' }] });
  assert.equal(res.output[0].content[0].text, '{"a":1}');
});
