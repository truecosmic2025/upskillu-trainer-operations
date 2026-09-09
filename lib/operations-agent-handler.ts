import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "../app/api/bookings/_lib";
import { currentStaffEmail } from "../app/api/integrations/google/_lib";
import {
  createOpenAIClient,
  createOperationsToolExecutor,
  logAgentToolUsage,
  operationsAgentSystemPrompt,
  runOperationsAgent,
  type AgentClient,
  type ToolExecutor,
  type UsageLogger,
} from "./operations-agent";

type RouteDependencies = {
  clientFactory?: () => AgentClient;
  currentStaff?: () => Promise<string | null>;
  requireEntitlement?: () => Promise<NextResponse | null>;
  logUsage?: UsageLogger;
  executeTool?: ToolExecutor;
  apiKey?: string | undefined;
};

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "The Trainer Operations assistant could not complete this request";
  return NextResponse.json({ error: message }, { status: 400 });
}

/** The production handler injects the versioned instruction with every model call. */
export function createOperationsAgentHandler(dependencies: RouteDependencies = {}) {
  return async function handleOperationsAgent(request: NextRequest) {
    const entitlement = await (dependencies.requireEntitlement ?? (() => requireFeature("operationsAgent")))();
    if (entitlement) return entitlement;
    const staffEmail = await (dependencies.currentStaff ?? currentStaffEmail)();
    if (!staffEmail) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
    let body: { question?: unknown; conversationId?: unknown };
    try { body = await request.json() as { question?: unknown; conversationId?: unknown }; }
    catch { return NextResponse.json({ error: "A JSON request body is required" }, { status: 400 }); }
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return NextResponse.json({ error: "A question is required" }, { status: 400 });
    if (question.length > 4_000) return NextResponse.json({ error: "Questions must be 4,000 characters or fewer" }, { status: 400 });
    const conversationId = typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim().slice(0, 160) : crypto.randomUUID();
    const apiKey = dependencies.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey && !dependencies.clientFactory) return NextResponse.json({ error: "Trainer Operations assistant is not configured. Add OPENAI_API_KEY and optionally OPENAI_MODEL to the Railway service variables, then redeploy the service." }, { status: 503 });
    try {
      const client = dependencies.clientFactory?.() ?? createOpenAIClient(apiKey!) as unknown as AgentClient;
      const result = await runOperationsAgent({
        client,
        question,
        conversationId,
        system: await operationsAgentSystemPrompt(staffEmail),
        executeTool: dependencies.executeTool ?? createOperationsToolExecutor(staffEmail),
        logUsage: dependencies.logUsage ?? logAgentToolUsage,
      });
      return NextResponse.json(result);
    } catch {
      // Tool inputs and provider responses can include operationally sensitive values; never log them.
      console.error("Trainer Operations assistant request failed");
      return errorResponse(new Error("The Trainer Operations assistant could not complete this request. Check the OpenAI configuration and verified session data, then try again."));
    }
  };
}
