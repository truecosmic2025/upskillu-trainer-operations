import OpenAI from "openai";
import {
  TRAINER_OPERATIONS_INSTRUCTION_VERSION,
  TRAINER_OPERATIONS_SYSTEM_INSTRUCTION,
  createConfirmationDraft,
  getApprovedMaterials,
  getAssignment,
  getReadiness,
  getSession,
  getSettings,
  recordAcknowledgement,
  recordAccessOutcome,
  redactForAudit,
  sendApprovedMessage,
  submitSendForApproval,
  audit,
} from "./trainer-operations";

export const OPERATIONS_AGENT_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
export const MAX_TOOL_ROUNDS = 6;
export { TRAINER_OPERATIONS_INSTRUCTION_VERSION, TRAINER_OPERATIONS_SYSTEM_INSTRUCTION };

export const operationsAgentTools = [
  { type: "function", function: { name: "get_session", description: "Return the current verified session record for one immutable session ID. This is the only source for a session date, generated weekday, timezone, link, and host.", parameters: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false } } },
  { type: "function", function: { name: "get_assignment", description: "Confirm one exact learner-to-session assignment. Never infer an assignment from history or a similar session.", parameters: { type: "object", properties: { learner_id: { type: "string" }, session_id: { type: "string" } }, required: ["learner_id", "session_id"], additionalProperties: false } } },
  { type: "function", function: { name: "get_approved_materials", description: "Return only approved, currently available materials for one session.", parameters: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false } } },
  { type: "function", function: { name: "get_readiness", description: "Return the structured session and per-assignment readiness result, including blockers, owner, and next action.", parameters: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false } } },
  { type: "function", function: { name: "create_confirmation_draft", description: "Create a server-validated confirmation draft for the exact learner and session. This cannot send a message.", parameters: { type: "object", properties: { session_id: { type: "string" }, learner_id: { type: "string" } }, required: ["session_id", "learner_id"], additionalProperties: false } } },
  { type: "function", function: { name: "submit_send_for_approval", description: "Submit a current confirmation draft to a human for approval. This cannot send a message.", parameters: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"], additionalProperties: false } } },
  { type: "function", function: { name: "send_approved_message", description: "Send only a still-valid message that has already been approved by a human. The server revalidates the session, assignment, and link version before sending.", parameters: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"], additionalProperties: false } } },
  { type: "function", function: { name: "record_acknowledgement", description: "Record an explicit learner acknowledgement against an exact sent message and learner assignment.", parameters: { type: "object", properties: { message_id: { type: "string" }, learner_id: { type: "string" } }, required: ["message_id", "learner_id"], additionalProperties: false } } },
  { type: "function", function: { name: "record_access_outcome", description: "Record joined, admission-blocked, absent, or resolved for one exact session and learner assignment.", parameters: { type: "object", properties: { session_id: { type: "string" }, learner_id: { type: "string" }, status: { type: "string", enum: ["joined", "admission_blocked", "absent", "resolved"] } }, required: ["session_id", "learner_id", "status"], additionalProperties: false } } },
] as const;

type ToolInput = Record<string, unknown>;
export type AgentClient = { chat: { completions: { create: (request: Record<string, unknown>) => Promise<AgentResponse> } } };
export type AgentResponse = { choices: Array<{ message: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
export type ToolExecutor = (name: string, input: ToolInput) => Promise<unknown>;
export type UsageLogger = (event: { conversationId: string; toolName: string; toolInput: ToolInput; toolResult: unknown; inputTokens: number; outputTokens: number }) => Promise<void>;

function stringInput(input: ToolInput, key: string) { return String(input[key] ?? ""); }
function outcomeInput(input: ToolInput) {
  const status = stringInput(input, "status");
  if (!["joined", "admission_blocked", "absent", "resolved"].includes(status)) throw new Error("status must be joined, admission_blocked, absent, or resolved");
  return status as "joined" | "admission_blocked" | "absent" | "resolved";
}

/** Exposes only the nine typed, database-backed trainer scheduling operations. */
export function createOperationsToolExecutor(staffEmail: string): ToolExecutor {
  return async (name, input) => {
    switch (name) {
      case "get_session": return getSession(stringInput(input, "session_id"));
      case "get_assignment": return getAssignment(stringInput(input, "learner_id"), stringInput(input, "session_id"));
      case "get_approved_materials": return getApprovedMaterials(stringInput(input, "session_id"));
      case "get_readiness": return getReadiness(stringInput(input, "session_id"));
      case "create_confirmation_draft": return createConfirmationDraft(stringInput(input, "session_id"), stringInput(input, "learner_id"), staffEmail);
      case "submit_send_for_approval": return submitSendForApproval(stringInput(input, "message_id"), staffEmail);
      case "send_approved_message": return sendApprovedMessage(stringInput(input, "message_id"), staffEmail);
      case "record_acknowledgement": return recordAcknowledgement(stringInput(input, "message_id"), stringInput(input, "learner_id"), staffEmail);
      case "record_access_outcome": return recordAccessOutcome(stringInput(input, "session_id"), stringInput(input, "learner_id"), outcomeInput(input), staffEmail);
      default: throw new Error(`Unsupported Trainer Operations tool: ${name}`);
    }
  };
}

export async function logAgentToolUsage(event: Parameters<UsageLogger>[0]) {
  await audit({ sourceType: "ai_tool_call", sourceReference: event.conversationId, actor: "Trainer Operations AI", action: event.toolName, newValue: { input: redactForAudit(event.toolInput), result: redactForAudit(event.toolResult), inputTokens: event.inputTokens, outputTokens: event.outputTokens } });
}

function toolResultContent(result: unknown) { return JSON.stringify(result); }
function safeArguments(value: string) {
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ToolInput : {}; } catch { return {}; }
}

export async function runOperationsAgent(input: { client: AgentClient; question: string; conversationId: string; system: string; executeTool: ToolExecutor; logUsage: UsageLogger }) {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: input.system },
    { role: "user", content: input.question },
  ];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await input.client.chat.completions.create({ model: OPERATIONS_AGENT_MODEL, messages, tools: operationsAgentTools, tool_choice: "auto", parallel_tool_calls: false, max_completion_tokens: 900 });
    const message = response.choices[0]?.message;
    if (!message) return { answer: "I could not produce an answer from the verified operations data.", conversationId: input.conversationId, toolRounds: round };
    const calls = message.tool_calls ?? [];
    if (!calls.length) return { answer: message.content?.trim() || "I could not produce an answer from the verified operations data.", conversationId: input.conversationId, toolRounds: round };
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const toolInput = safeArguments(call.function.arguments);
      let result: unknown;
      try { result = await input.executeTool(call.function.name, toolInput); }
      catch (error) { result = { error: error instanceof Error ? error.message : "The requested verified tool was unavailable" }; }
      await input.logUsage({ conversationId: input.conversationId, toolName: call.function.name, toolInput, toolResult: result, inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 });
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResultContent(result) });
    }
  }
  const finalResponse = await input.client.chat.completions.create({ model: OPERATIONS_AGENT_MODEL, messages: [...messages, { role: "system", content: "The tool limit has been reached. Give a concise answer using only tool results; do not request another tool." }], max_completion_tokens: 900 });
  return { answer: finalResponse.choices[0]?.message.content?.trim() || "I reached the verified-data tool limit. Please refine the request and try again.", conversationId: input.conversationId, toolRounds: MAX_TOOL_ROUNDS };
}

export async function operationsAgentSystemPrompt(staffEmail: string) {
  const stored = await getSettings("assistant_instruction");
  const instruction = typeof stored.instruction === "string" ? stored.instruction : "Trainer Operations database data is authoritative. Do not infer operational facts.";
  const version = typeof stored.version === "string" ? stored.version : TRAINER_OPERATIONS_INSTRUCTION_VERSION;
  return `${instruction}\n\nInstruction version: ${version}.\n\nYou are assisting ${staffEmail}. You have exactly nine typed database tools. Never use email, calendar, prior conversation, or general knowledge as a source for scheduling facts. Every send remains behind a recorded human approval; if the verified tool blocks an action, report the blocker, owner, and next action concisely.`;
}

export function createOpenAIClient(apiKey: string) { return new OpenAI({ apiKey }); }
