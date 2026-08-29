import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "../app/api/bookings/_lib";
import { currentStaffEmail } from "../app/api/integrations/google/_lib";
import {
  createOperationsToolExecutor,
  logAgentToolUsage,
  operationsAgentSystemPrompt,
  runOperationsAgent,
  type AgentClient,
  type GoogleRequester,
  type ToolExecutor,
  type UsageLogger,
} from "./operations-agent";

type RouteDependencies = {
  clientFactory?: () => AgentClient;
  currentStaff?: () => Promise<string | null>;
  requireEntitlement?: () => Promise<NextResponse | null>;
  googleRequester?: GoogleRequester;
  logUsage?: UsageLogger;
  executeTool?: ToolExecutor;
  apiKey?: string | undefined;
};

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "The Operations Agent could not complete this request";
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * The handler factory permits an end-to-end mocked tool-loop test. The production route below uses
 * the defaults: authenticated administrator, entitlement check, official Anthropic SDK and the
 * bounded tool executor.
 */
export function createOperationsAgentHandler(dependencies: RouteDependencies = {}) {
  return async function handleOperationsAgent(request: NextRequest) {
    const entitlement = await (dependencies.requireEntitlement ?? (() => requireFeature("operationsAgent")))();
    if (entitlement) return entitlement;

    const staffEmail = await (dependencies.currentStaff ?? currentStaffEmail)();
    if (!staffEmail) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });

    let body: { question?: unknown; conversationId?: unknown };
    try {
      body = await request.json() as { question?: unknown; conversationId?: unknown };
    } catch {
      return NextResponse.json({ error: "A JSON request body is required" }, { status: 400 });
    }
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return NextResponse.json({ error: "A question is required" }, { status: 400 });
    if (question.length > 4_000) return NextResponse.json({ error: "Questions must be 4,000 characters or fewer" }, { status: 400 });
    const conversationId = typeof body.conversationId === "string" && body.conversationId.trim()
      ? body.conversationId.trim().slice(0, 160)
      : crypto.randomUUID();

    const apiKey = dependencies.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey && !dependencies.clientFactory) {
      return NextResponse.json({
        error: "Operations Agent is not configured. Add ANTHROPIC_API_KEY to the Railway service variables, then redeploy the service.",
      }, { status: 503 });
    }

    try {
      const client = dependencies.clientFactory?.() ?? new Anthropic({ apiKey }) as unknown as AgentClient;
      const executeTool = dependencies.executeTool ?? createOperationsToolExecutor(staffEmail, dependencies.googleRequester);
      const result = await runOperationsAgent({
        client,
        question,
        conversationId,
        system: operationsAgentSystemPrompt(staffEmail),
        executeTool,
        logUsage: dependencies.logUsage ?? logAgentToolUsage,
      });
      return NextResponse.json(result);
    } catch (error) {
      // Do not reveal provider credentials or raw vendor responses to the browser.
      console.error("Operations Agent request failed", error);
      return errorResponse(new Error("The Operations Agent could not complete this request. Check the Anthropic key and Google connection, then try again."));
    }
  };
}
