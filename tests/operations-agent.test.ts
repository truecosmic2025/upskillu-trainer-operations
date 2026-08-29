import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { db, ensureBookingTables } from "../lib/db";
import {
  draftEmail,
  logAgentToolUsage,
  queryPipeline,
  type AgentClient,
  type GoogleRequester,
} from "../lib/operations-agent";
import { createOperationsAgentHandler } from "../lib/operations-agent-handler";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const dbTest = hasDatabase ? test : test.skip;

dbTest("query_pipeline returns real outstanding, invite, and client data from PostgreSQL", async () => {
  await ensureBookingTables();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const clientId = `test_cli_${suffix}`;
  const tbcBookingId = `test_bkg_tbc_${suffix}`;
  const confirmedBookingId = `test_bkg_confirmed_${suffix}`;
  const email = `test-${suffix}@example.org`;

  try {
    await db().query(`INSERT INTO clients (id, name, primary_contact, contact_email) VALUES ($1,$2,$3,$4)`, [clientId, `Test Client ${suffix}`, "Test Contact", email]);
    await db().query(
      `INSERT INTO bookings (id, client_id, session_type, proposed_dates, status, venue, start_time, finish_time, delivery_mode)
       VALUES ($1,$2,'TBC Test Session','[{"date":"2026-10-01","status":"tbc"}]'::jsonb,'to_be_confirmed','','','','virtual')`,
      [tbcBookingId, clientId],
    );
    await db().query(
      `INSERT INTO bookings (id, client_id, session_type, proposed_dates, confirmed_date, status, venue, start_time, finish_time, delivery_mode)
       VALUES ($1,$2,'Confirmed Test Session','[{"date":"2026-10-02","status":"chosen"}]'::jsonb,'2026-10-02','confirmed','Test venue','09:00','16:00','in-person')`,
      [confirmedBookingId, clientId],
    );
    await db().query(`INSERT INTO post_session_pipeline (booking_id) VALUES ($1)`, [confirmedBookingId]);
    await db().query(`INSERT INTO trainers (email, name, initials, is_lead) VALUES ($1,'Test Lead','TL',TRUE) ON CONFLICT (email) DO NOTHING`, [email]);
    await db().query(`INSERT INTO booking_allocations (id, booking_id, trainer_email, lead_pick) VALUES ($1,$2,$3,TRUE)`, [`test_alloc_${suffix}`, confirmedBookingId, email]);
    await db().query(`INSERT INTO delivery_invites (id, booking_id, recipient_type, recipient_ref, recipient_name, forwarded) VALUES ($1,$2,'trainer',$3,'Test Lead',FALSE)`, [`test_inv_${suffix}`, confirmedBookingId, email]);

    const outstanding = await queryPipeline({ shape: "outstanding_tbc" });
    assert.ok(outstanding.some((row) => row.booking_id === tbcBookingId));
    const invites = await queryPipeline({ shape: "unconfirmed_invites" });
    assert.ok(invites.some((row) => row.booking_id === confirmedBookingId));
    const clientRows = await queryPipeline({ shape: "by_client", clientName: `test client ${suffix}` });
    assert.equal(clientRows.filter((row) => row.client_name === `Test Client ${suffix}`).length, 2);

    await logAgentToolUsage({
      conversationId: `test-conversation-${suffix}`,
      toolName: "query_pipeline",
      toolInput: { shape: "outstanding_tbc" },
      toolResult: { verified: true },
      inputTokens: 12,
      outputTokens: 8,
    });
    const usage = await db().query(`SELECT * FROM agent_usage_log WHERE conversation_id=$1`, [`test-conversation-${suffix}`]);
    assert.equal(usage.rows.length, 1);
    assert.equal(usage.rows[0].tool_name, "query_pipeline");
    assert.equal(usage.rows[0].input_tokens, 12);
  } finally {
    await db().query(`DELETE FROM bookings WHERE id IN ($1,$2)`, [tbcBookingId, confirmedBookingId]);
    await db().query(`DELETE FROM trainers WHERE email=$1`, [email]);
    await db().query(`DELETE FROM clients WHERE id=$1`, [clientId]);
    await db().query(`DELETE FROM agent_usage_log WHERE conversation_id=$1`, [`test-conversation-${suffix}`]);
  }
});

test("Operations Agent route chains a mocked Claude tool-use response to a final answer", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const usageLogs: unknown[] = [];
  const replies = [
    {
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 15 },
      content: [{ type: "tool_use", id: "tool_1", name: "query_pipeline", input: { shape: "outstanding_tbc" } }],
    },
    {
      stop_reason: "end_turn",
      usage: { input_tokens: 60, output_tokens: 20 },
      content: [{ type: "text", text: "One booking is awaiting confirmation: Trauma for Test Client on 1 October." }],
    },
  ];
  const client: AgentClient = {
    messages: {
      create: async (request) => {
        requests.push(request);
        const reply = replies.shift();
        assert.ok(reply, "Claude mock should only be called for its prepared responses");
        return reply;
      },
    },
  };
  const handler = createOperationsAgentHandler({
    apiKey: "test-key",
    clientFactory: () => client,
    currentStaff: async () => "admin@truecosmic.com",
    requireEntitlement: async () => null,
    executeTool: async (name, input) => {
      toolCalls.push({ name, input });
      return [{ booking_id: "bkg_1", client_name: "Test Client", session_type: "Trauma" }];
    },
    logUsage: async (event) => { usageLogs.push(event); },
  });
  const response = await handler(new NextRequest("http://localhost/api/operations/agent", {
    method: "POST",
    body: JSON.stringify({ question: "What bookings are awaiting confirmation?", conversationId: "conversation_test_1" }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { answer: string; conversationId: string; toolRounds: number };
  assert.match(payload.answer, /One booking is awaiting confirmation/);
  assert.equal(payload.conversationId, "conversation_test_1");
  assert.equal(payload.toolRounds, 1);
  assert.deepEqual(toolCalls, [{ name: "query_pipeline", input: { shape: "outstanding_tbc" } }]);
  assert.equal(usageLogs.length, 1);
  assert.equal(requests.length, 2);
  const secondMessages = requests[1].messages as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>;
  assert.equal(secondMessages.at(-1)?.role, "user");
  assert.equal(secondMessages.at(-1)?.content[0]?.type, "tool_result");
  assert.equal(secondMessages.at(-1)?.content[0]?.tool_use_id, "tool_1");
});

test("draft_email uses Gmail drafts only and has no Gmail send endpoint", async () => {
  const URLs: string[] = [];
  const draftRequester: GoogleRequester = async <T,>(_email: string, url: string) => {
    URLs.push(url);
    return { id: "draft_123" } as T;
  };
  const result = await draftEmail(
    "admin@truecosmic.com",
    { to: "recipient@example.com", subject: "Draft only", body: "Please review this draft." },
    draftRequester,
  );
  assert.equal(result.draftId, "draft_123");
  assert.match(URLs[0], /\/drafts$/);
  const source = await readFile(new URL("../lib/operations-agent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /users\/me\/messages\/send/);
  assert.doesNotMatch(source, /messages\.send/);
});


test("Operations Agent route fails gracefully when ANTHROPIC_API_KEY is absent", async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const handler = createOperationsAgentHandler({
      currentStaff: async () => "admin@truecosmic.com",
      requireEntitlement: async () => null,
    });
    const response = await handler(new NextRequest("http://localhost/api/operations/agent", {
      method: "POST",
      body: JSON.stringify({ question: "What is outstanding?" }),
      headers: { "content-type": "application/json" },
    }));
    assert.equal(response.status, 503);
    const payload = await response.json() as { error: string };
    assert.match(payload.error, /ANTHROPIC_API_KEY/);
    assert.match(payload.error, /Railway service variables/);
  } finally {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  }
});


test("Operations Agent route chains mocked Claude and Gmail responses through to a final answer", async () => {
  const googleUrls: string[] = [];
  const googleRequester: GoogleRequester = async <T,>(_email: string, url: string) => {
    googleUrls.push(url);
    if (url.includes("/messages?")) {
      return { messages: [{ id: "message_1", threadId: "thread_abc123" }] } as T;
    }
    return {
      id: "message_1",
      threadId: "thread_abc123",
      snippet: "Yes, I can attend the confirmed training session.",
      payload: { headers: [{ name: "From", value: "Trainer <trainer@example.org>" }, { name: "Subject", value: "Re: Availability" }] },
    } as T;
  };
  const replies = [
    {
      stop_reason: "tool_use",
      usage: { input_tokens: 21, output_tokens: 11 },
      content: [{ type: "tool_use", id: "gmail_tool_1", name: "search_gmail", input: { query: "trainer availability", maxResults: 3 } }],
    },
    {
      stop_reason: "end_turn",
      usage: { input_tokens: 41, output_tokens: 17 },
      content: [{ type: "text", text: "Trainer has replied: they can attend the confirmed training session." }],
    },
  ];
  const client: AgentClient = { messages: { create: async () => {
    const reply = replies.shift();
    assert.ok(reply, "the agent should not make an unexpected Claude call");
    return reply;
  } } };
  const handler = createOperationsAgentHandler({
    apiKey: "test-key",
    clientFactory: () => client,
    currentStaff: async () => "admin@truecosmic.com",
    requireEntitlement: async () => null,
    googleRequester,
    logUsage: async () => {},
  });
  const response = await handler(new NextRequest("http://localhost/api/operations/agent", {
    method: "POST",
    body: JSON.stringify({ question: "Has the trainer replied about availability?" }),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { answer: string };
  assert.match(payload.answer, /Trainer has replied/);
  assert.equal(googleUrls.length, 2);
  assert.match(decodeURIComponent(googleUrls[0]), /label:"Trainer Operations" trainer availability/);
  assert.match(googleUrls[1], /metadataHeaders=From/);
});
