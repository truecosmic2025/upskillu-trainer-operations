import { NextResponse } from "next/server";
import { currentStaffEmail } from "../../integrations/google/_lib";
import { googleJson } from "../../../../lib/google";

type GmailList = { messages?: Array<{id:string;threadId:string}>; resultSizeEstimate?:number };
type GmailMessage = { id:string; threadId:string; snippet:string; labelIds?:string[]; payload?:{headers?:Array<{name:string;value:string}>} };
type CalendarList = { items?: Array<{id:string;summary?:string;start?:{dateTime?:string;date?:string};status?:string}> };

export async function GET() {
  const email = await currentStaffEmail();
  if (!email) return NextResponse.json({ error: "Administrator sign-in required" }, { status: 401 });
  try {
    const query = encodeURIComponent('{label:"Trainer Operations" from:sasha@upskillu.org to:sasha@upskillu.org to:trainerops@truecosmic.com}');
    const list = await googleJson<GmailList>(email, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=${query}`);
    const messages = await Promise.all((list.messages ?? []).slice(0, 12).map(item => googleJson<GmailMessage>(email, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`)));
    const header = (message:GmailMessage,name:string) => message.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    const emails = messages.map(message => ({ id:message.id, threadId:message.threadId, from:header(message,"From"), subject:header(message,"Subject") || "(No subject)", date:header(message,"Date"), snippet:message.snippet, unread:message.labelIds?.includes("UNREAD") ?? false }));
    const now = new Date();
    const future = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    let calendarItems: CalendarList["items"] = [];
    let calendarError = "";
    try {
      const calendar = await googleJson<CalendarList>(email, `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=20&timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(future.toISOString())}`);
      calendarItems = calendar.items ?? [];
    } catch (error) {
      calendarError = error instanceof Error ? error.message : "Calendar temporarily unavailable";
    }
    return NextResponse.json({ live:true, gmailLive:true, calendarLive:!calendarError, calendarError, mailbox:"trainerops@truecosmic.com", googleAccount:process.env.GOOGLE_WORKSPACE_ACCOUNT ?? "admin@truecosmic.com", fetchedAt:new Date().toISOString(), emailCount:emails.length, unreadCount:emails.filter(item => item.unread).length, emails, upcomingEvents:(calendarItems ?? []).map(item => ({ id:item.id, title:item.summary ?? "Untitled event", start:item.start?.dateTime ?? item.start?.date ?? "", status:item.status ?? "confirmed" })) });
  } catch (error) {
    return NextResponse.json({ live:false, error:error instanceof Error ? error.message : "Google brief failed" }, { status: 502 });
  }
}
