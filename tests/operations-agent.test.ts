import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  TRAINER_OPERATIONS_SYSTEM_INSTRUCTION,
  operationsAgentTools,
  runOperationsAgent,
  type AgentClient,
} from "../lib/operations-agent";
import { createOperationsAgentHandler } from "../lib/operations-agent-handler";

test("Operations Agent exposes only the nine authoritative trainer scheduling tools", () => {
  assert.deepEqual(operationsAgentTools.map((tool) => tool.function.name), [
    "get_session", "get_assignment", "get_approved_materials", "get_readiness", "create_confirmation_draft",
    "submit_send_for_approval", "send_approved_message", "record_acknowledgement", "record_access_outcome",
  ]);
  assert.match(TRAINER_OPERATIONS_SYSTEM_INSTRUCTION, /sole source of truth/);
  assert.match(TRAINER_OPERATIONS_SYSTEM_INSTRUCTION, /Explicit learner acknowledgement is required/);
});

test("Operations Agent chains typed tool calls and audits every mutation-capable call", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const usage: unknown[] = [];
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "tool_1", function: { name: "get_readiness", arguments: '{"session_id":"HA-2026-09-09"}' } }] } }], usage: { prompt_tokens: 30, completion_tokens: 15 } },
    { choices: [{ message: { content: "HA-2026-09-09 is waiting for an explicit learner acknowledgement." } }], usage: { prompt_tokens: 44, completion_tokens: 17 } },
  ];
  const client: AgentClient = { chat: { completions: { create: async (request) => { requests.push(request); const reply = replies.shift(); assert.ok(reply); return reply; } } } };
  const result = await runOperationsAgent({
    client, question: "Is HA-2026-09-09 ready?", conversationId: "ops_test_1", system: TRAINER_OPERATIONS_SYSTEM_INSTRUCTION,
    executeTool: async (name, input) => { calls.push({ name, input }); return { readiness: "waiting", assignments: [] }; },
    logUsage: async (event) => { usage.push(event); },
  });
  assert.match(result.answer, /waiting/);
  assert.equal(result.toolRounds, 1);
  assert.deepEqual(calls, [{ name: "get_readiness", input: { session_id: "HA-2026-09-09" } }]);
  assert.equal(usage.length, 1);
  assert.equal(requests.length, 2);
});

test("Broad Gmail and Calendar scheduling retrieval is absent from the agent layer", async () => {
  const source = await readFile(new URL("../lib/operations-agent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /search_gmail/);
  assert.doesNotMatch(source, /search_calendar/);
  assert.doesNotMatch(source, /get_gmail_message/);
  assert.doesNotMatch(source, /query_pipeline/);
});

test("Operations Agent route fails safely when OPENAI_API_KEY is absent", async () => {
  const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  try {
    const handler = createOperationsAgentHandler({ currentStaff: async () => "admin@truecosmic.com", requireEntitlement: async () => null });
    const response = await handler(new NextRequest("http://localhost/api/operations/agent", { method: "POST", body: JSON.stringify({ question: "What is ready?" }), headers: { "content-type": "application/json" } }));
    assert.equal(response.status, 503);
    assert.match((await response.json() as { error: string }).error, /OPENAI_API_KEY/);
  } finally { if (original) process.env.OPENAI_API_KEY = original; }
});
