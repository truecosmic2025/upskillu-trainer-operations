import { db, ensureBookingTables } from "./db";
import { googleJson } from "./google";

export const OPERATIONS_AGENT_MODEL = "claude-sonnet-5";
export const MAX_TOOL_ROUNDS = 6;

type PipelineShape = "outstanding_tbc" | "unconfirmed_invites" | "pending_pipeline_steps" | "by_client" | "by_date_range";
export type PipelineQueryInput = {
  shape: PipelineShape;
  clientName?: string;
  timeMin?: string;
  timeMax?: string;
};

type GmailList = { messages?: Array<{ id: string; threadId: string }> };
type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name: string; value: string }> };
};
type GmailThread = { id: string; messages?: GmailMessage[] };
type CalendarList = {
  items?: Array<{
    id: string;
    summary?: string;
    status?: string;
    htmlLink?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  }>;
};

export type GoogleRequester = <T>(userEmail: string, url: string, init?: RequestInit) => Promise<T>;

export const operationsAgentTools = [
  {
    name: "query_pipeline",
    description: "Query this account's authoritative structured bookings, allocations, speakers, delivery invites, and post-session pipeline. Use this before email or calendar for operational status.",
    input_schema: {
      type: "object",
      properties: {
        shape: { type: "string", enum: ["outstanding_tbc", "unconfirmed_invites", "pending_pipeline_steps", "by_client", "by_date_range"] },
        clientName: { type: "string", description: "Required only for by_client; use the client organisation name." },
        timeMin: { type: "string", description: "Required for by_date_range. ISO date or datetime inclusive lower bound." },
        timeMax: { type: "string", description: "Required for by_date_range. ISO date or datetime inclusive upper bound." },
      },
      required: ["shape"],
    },
  },
  {
    name: "search_gmail",
    description: "Read a small set of relevant Trainer Operations email metadata. Use only when the question needs email or thread evidence that the booking database cannot answer, for example whether a person replied.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search terms. Searches are scoped to Trainer Operations unless the query already includes a narrower scope." },
        maxResults: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_gmail_message",
    description: "Read metadata and snippets from one specific Gmail thread already found using search_gmail. It does not return full email bodies.",
    input_schema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
  },
  {
    name: "search_calendar",
    description: "Read calendar events within a specific time range. This tool cannot create, edit, or delete calendar events.",
    input_schema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "ISO datetime, inclusive." },
        timeMax: { type: "string", description: "ISO datetime, exclusive." },
        query: { type: "string", description: "Optional calendar text filter." },
      },
      required: ["timeMin", "timeMax"],
    },
  },
  {
    name: "draft_email",
    description: "Create a Gmail draft only when the administrator asks for a draft. This tool has no send capability. Clearly state in your final answer that a human must review and send any resulting Gmail draft.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Single recipient email address, optionally with a display name." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text draft body." },
        bookingId: { type: "string", description: "Optional booking id the draft relates to." },
      },
      required: ["to", "subject", "body"],
    },
  },
] as const;

const bookingOverviewSelect = `
  SELECT
    b.id AS booking_id,
    c.name AS client_name,
    c.primary_contact,
    c.contact_email,
    b.session_type,
    b.proposed_dates,
    b.confirmed_date,
    b.status AS booking_status,
    b.venue,
    b.start_time,
    b.finish_time,
    b.delivery_mode,
    COALESCE(p.attendance_received_at, NULL) AS attendance_received_at,
    COALESCE(p.attendance_late, FALSE) AS attendance_late,
    COALESCE(p.names_checked, FALSE) AS names_checked,
    COALESCE(p.shared_with_client, FALSE) AS shared_with_client,
    COALESCE(p.evaluation_sent, FALSE) AS evaluation_sent,
    COALESCE(p.certificates_issued, FALSE) AS certificates_issued,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', t.name, 'email', t.email, 'leadPick', a.lead_pick))
      FROM booking_allocations a JOIN trainers t ON t.email = a.trainer_email
      WHERE a.booking_id = b.id
    ), '[]'::jsonb) AS allocated_trainers,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', s.name, 'contact', s.contact, 'status', bs.status))
      FROM booking_speakers bs JOIN speakers s ON s.id = bs.speaker_id
      WHERE bs.booking_id = b.id
    ), '[]'::jsonb) AS speakers,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('recipientName', i.recipient_name, 'recipientType', i.recipient_type, 'forwarded', i.forwarded, 'forwardedAt', i.forwarded_at))
      FROM delivery_invites i WHERE i.booking_id = b.id
    ), '[]'::jsonb) AS delivery_invites
  FROM bookings b
  JOIN clients c ON c.id = b.client_id
  LEFT JOIN post_session_pipeline p ON p.booking_id = b.id
`;

function asIsoDate(value: string | undefined, label: string) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid ISO date or datetime`);
  return parsed.toISOString().slice(0, 10);
}

function requireClientName(value: string | undefined) {
  const name = value?.trim();
  if (!name || name.length > 160) throw new Error("clientName is required and must be 160 characters or fewer");
  return name;
}

/**
 * Runs only predefined, parameterized operational queries. The agent never provides SQL text.
 */
export async function queryPipeline(input: PipelineQueryInput) {
  await ensureBookingTables();
  switch (input.shape) {
    case "outstanding_tbc":
      return (await db().query(`${bookingOverviewSelect} WHERE b.status='to_be_confirmed' ORDER BY b.created_at DESC LIMIT 50`)).rows;
    case "unconfirmed_invites":
      return (await db().query(`${bookingOverviewSelect}
        WHERE b.status='confirmed'
          AND EXISTS (SELECT 1 FROM delivery_invites i WHERE i.booking_id=b.id AND i.forwarded=FALSE)
        ORDER BY b.confirmed_date ASC NULLS LAST LIMIT 50`)).rows;
    case "pending_pipeline_steps":
      return (await db().query(`${bookingOverviewSelect}
        WHERE b.status='confirmed' AND b.confirmed_date <= CURRENT_DATE
          AND (p.attendance_received_at IS NULL OR p.names_checked=FALSE OR p.shared_with_client=FALSE OR p.evaluation_sent=FALSE OR p.certificates_issued=FALSE)
        ORDER BY b.confirmed_date DESC LIMIT 50`)).rows;
    case "by_client": {
      const clientName = requireClientName(input.clientName);
      return (await db().query(`${bookingOverviewSelect}
        WHERE LOWER(c.name) = LOWER($1)
        ORDER BY b.confirmed_date DESC NULLS LAST, b.created_at DESC LIMIT 50`, [clientName])).rows;
    }
    case "by_date_range": {
      const timeMin = asIsoDate(input.timeMin, "timeMin");
      const timeMax = asIsoDate(input.timeMax, "timeMax");
      if (timeMin > timeMax) throw new Error("timeMin must not be after timeMax");
      return (await db().query(`${bookingOverviewSelect}
        WHERE b.confirmed_date BETWEEN $1::date AND $2::date
        ORDER BY b.confirmed_date ASC, b.start_time ASC LIMIT 50`, [timeMin, timeMax])).rows;
    }
    default:
      throw new Error("Unsupported pipeline query shape");
  }
}

function gmailHeader(message: GmailMessage, name: string) {
  return message.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function safeSearchQuery(query: string) {
  const cleaned = query.trim().replaceAll(/\bin:anywhere\b/gi, "").slice(0, 500);
  if (!cleaned) throw new Error("A Gmail search query is required");
  // The label is an enforced default boundary. Sender/recipient terms can further narrow it,
  // but the agent cannot widen a request to the whole mailbox.
  return /\blabel:/i.test(cleaned) ? cleaned : `label:"Trainer Operations" ${cleaned}`;
}

export async function searchGmail(staffEmail: string, input: { query: string; maxResults?: number }, requester: GoogleRequester = googleJson) {
  const maxResults = Math.max(1, Math.min(10, Number.isInteger(input.maxResults) ? Number(input.maxResults) : 6));
  const query = safeSearchQuery(input.query);
  const list = await requester<GmailList>(staffEmail, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`);
  const messages = await Promise.all((list.messages ?? []).slice(0, maxResults).map((item) => requester<GmailMessage>(
    staffEmail,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`,
  )));
  return messages.map((message) => ({
    id: message.id,
    threadId: message.threadId,
    subject: gmailHeader(message, "Subject") || "(No subject)",
    sender: gmailHeader(message, "From"),
    date: gmailHeader(message, "Date") || message.internalDate || "",
    snippet: message.snippet ?? "",
  }));
}

export async function getGmailMessage(staffEmail: string, input: { threadId: string }, requester: GoogleRequester = googleJson) {
  const threadId = input.threadId.trim();
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(threadId)) throw new Error("threadId is invalid");
  const thread = await requester<GmailThread>(
    staffEmail,
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`,
  );
  return (thread.messages ?? []).map((message) => ({
    id: message.id,
    threadId: message.threadId,
    subject: gmailHeader(message, "Subject") || "(No subject)",
    sender: gmailHeader(message, "From"),
    date: gmailHeader(message, "Date") || message.internalDate || "",
    snippet: message.snippet ?? "",
  }));
}

function base64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function recipientEmail(to: string) {
  const trimmed = to.trim();
  const email = trimmed.match(/<([^>]+)>/)?.[1] ?? trimmed;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("draft_email requires one valid recipient email address");
  return trimmed;
}

export async function draftEmail(
  staffEmail: string,
  input: { to: string; subject: string; body: string; bookingId?: string },
  requester: GoogleRequester = googleJson,
) {
  const to = recipientEmail(input.to);
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject || subject.length > 200) throw new Error("Email subject is required and must be 200 characters or fewer");
  if (!body || body.length > 12_000) throw new Error("Email body is required and must be 12,000 characters or fewer");
  if (input.bookingId) {
    await ensureBookingTables();
    const booking = await db().query(`SELECT id FROM bookings WHERE id=$1`, [input.bookingId]);
    if (!booking.rows[0]) throw new Error("The booking referenced by this draft was not found");
  }
  // Gmail's drafts endpoint is intentionally the only endpoint used here. There is no send operation in this module.
  const raw = base64Url(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`);
  const draft = await requester<{ id: string }>(
    staffEmail,
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    { method: "POST", body: JSON.stringify({ message: { raw } }) },
  );
  return {
    draftId: draft.id,
    reviewUrl: "https://mail.google.com/mail/u/0/#drafts",
    status: "draft_created_for_human_review",
  };
}

export async function searchCalendar(
  staffEmail: string,
  input: { timeMin: string; timeMax: string; query?: string },
  requester: GoogleRequester = googleJson,
) {
  const timeMin = new Date(input.timeMin);
  const timeMax = new Date(input.timeMax);
  if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime()) || timeMin >= timeMax) {
    throw new Error("search_calendar requires a valid timeMin before timeMax");
  }
  if (timeMax.getTime() - timeMin.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new Error("search_calendar time range must be one year or less");
  }
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
  });
  if (input.query?.trim()) params.set("q", input.query.trim().slice(0, 300));
  const calendar = await requester<CalendarList>(
    staffEmail,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
  );
  return (calendar.items ?? []).map((item) => ({
    id: item.id,
    title: item.summary ?? "Untitled event",
    start: item.start?.dateTime ?? item.start?.date ?? "",
    end: item.end?.dateTime ?? item.end?.date ?? "",
    status: item.status ?? "confirmed",
    link: item.htmlLink ?? "",
  }));
}

export function createOperationsToolExecutor(staffEmail: string, requester: GoogleRequester = googleJson) {
  const discoveredThreadIds = new Set<string>();
  return async (name: string, input: Record<string, unknown>) => {
    switch (name) {
      case "query_pipeline":
        return queryPipeline(input as PipelineQueryInput);
      case "search_gmail": {
        const results = await searchGmail(staffEmail, input as { query: string; maxResults?: number }, requester);
        results.forEach((result) => discoveredThreadIds.add(result.threadId));
        return results;
      }
      case "get_gmail_message": {
        const threadId = String(input.threadId ?? "");
        if (!discoveredThreadIds.has(threadId)) throw new Error("Gmail threads may be read only after search_gmail returned that thread id in this conversation");
        return getGmailMessage(staffEmail, { threadId }, requester);
      }
      case "search_calendar":
        return searchCalendar(staffEmail, input as { timeMin: string; timeMax: string; query?: string }, requester);
      case "draft_email":
        return draftEmail(staffEmail, input as { to: string; subject: string; body: string; bookingId?: string }, requester);
      default:
        throw new Error(`Unsupported Operations Agent tool: ${name}`);
    }
  };
}

export type AgentResponseBlock = { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string };
export type AgentResponse = {
  content: AgentResponseBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};
export type AgentClient = { messages: { create: (request: Record<string, unknown>) => Promise<AgentResponse> } };
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<unknown>;
export type UsageLogger = (event: {
  conversationId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  inputTokens: number;
  outputTokens: number;
}) => Promise<void>;

export async function logAgentToolUsage(event: Parameters<UsageLogger>[0]) {
  await ensureBookingTables();
  await db().query(
    `INSERT INTO agent_usage_log (id, account_id, conversation_id, tool_name, tool_input, tool_result, input_tokens, output_tokens)
     VALUES ($1,'default',$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
    [
      `agt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      event.conversationId,
      event.toolName,
      JSON.stringify(event.toolInput),
      JSON.stringify(event.toolResult),
      event.inputTokens,
      event.outputTokens,
    ],
  );
}

function responseText(response: AgentResponse) {
  return response.content.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n").trim();
}

/**
 * Executes the standard Anthropic client-tool loop. The call boundary is injected so it can be
 * genuinely mocked in tests without a live Anthropic or Gmail account.
 */
export async function runOperationsAgent(input: {
  client: AgentClient;
  question: string;
  conversationId: string;
  system: string;
  executeTool: ToolExecutor;
  logUsage: UsageLogger;
}) {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: input.question }];
  const requestBase = {
    model: OPERATIONS_AGENT_MODEL,
    max_tokens: 900,
    system: input.system,
    tools: operationsAgentTools,
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await input.client.messages.create({ ...requestBase, messages });
    const calls = response.content.filter((block) => block.type === "tool_use" && block.id && block.name);
    if (!calls.length) {
      return { answer: responseText(response) || "I could not produce an answer from the available operations data.", conversationId: input.conversationId, toolRounds: round };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      let result: unknown;
      try {
        result = await input.executeTool(call.name as string, call.input ?? {});
      } catch (error) {
        result = { error: error instanceof Error ? error.message : "The requested operations tool was unavailable" };
      }
      await input.logUsage({
        conversationId: input.conversationId,
        toolName: call.name as string,
        toolInput: call.input ?? {},
        toolResult: result,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      });
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
  }

  // The bounded six-round safety limit has been reached. Make one text-only request with the
  // accumulated, already-executed results; it cannot ask to execute a seventh tool round.
  const finalResponse = await input.client.messages.create({
    model: OPERATIONS_AGENT_MODEL,
    max_tokens: 900,
    system: `${input.system}\n\nThe tool limit has been reached. Provide the best concise final answer now without requesting more tools.`,
    messages,
  });
  return {
    answer: responseText(finalResponse) || "I reached the six-step research limit. Please refine the question and try again.",
    conversationId: input.conversationId,
    toolRounds: MAX_TOOL_ROUNDS,
  };
}

export function operationsAgentSystemPrompt(staffEmail: string) {
  const localPart = staffEmail.split("@")[0]?.replace(/[._-]+/g, " ") || "the administrator";
  return `You are the Operations Agent inside TrueCosmic's trainer/delivery operations portal, used by ${localPart} at TrueCosmic. You help find outstanding work and prepare follow-ups. You are NOT a general assistant — stay scoped to bookings, trainers, speakers, delivery invites, and the post-session pipeline in this account.

Hard rules, never break these:
- You NEVER send an email, calendar invite, or any message. You may only draft. Every draft you create requires human review and explicit send action outside your control — you do not have send capability at all, by design.
- Session dates start as TBC (multiple candidate dates held). Exactly one becomes the chosen/confirmed date; the rest are archived, never deleted.
- Trainer allocation: the lead trainer always gets first pick of sessions before other trainers are offered them.
- A booking is only "confirmed" once it has a chosen date AND venue AND start/finish time. Otherwise it stays "to be confirmed" even if a date is chosen.
- When asked about outstanding items, prefer querying the account's own booking/pipeline data first — it is authoritative and structured. Only search Gmail/Calendar when the question specifically needs email/thread content the database would not have (for example, "has X replied").
- When searching Gmail, stay scoped to the Trainer Operations label and the trainerops@truecosmic.com alias / relevant client contacts unless the user asks you to broaden the search.
- Be concise and specific: name the booking, client, and date; do not summarize vaguely.`;
}
