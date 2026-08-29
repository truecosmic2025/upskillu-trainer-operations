import { NextRequest, NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../../lib/db";

export async function GET(request: NextRequest) {
  const documentId = request.nextUrl.searchParams.get("documentId");
  if (!documentId) return NextResponse.json({ error: "Document id is required" }, { status: 400 });
  await ensureBookingTables();
  const result = await db().query<{ title: string; file_name: string | null; file_mime: string | null; file_data: Buffer | null }>(
    `SELECT title, file_name, file_mime, file_data FROM delivery_documents WHERE id=$1`,
    [documentId],
  );
  const document = result.rows[0];
  if (!document?.file_data || !document.file_mime) return NextResponse.json({ error: "No uploaded file is available for this document" }, { status: 404 });
  const name = (document.file_name || `${document.title}.file`).replace(/[\r\n"]/g, "_");
  return new NextResponse(new Uint8Array(document.file_data), {
    headers: {
      "Content-Type": document.file_mime,
      "Content-Length": String(document.file_data.byteLength),
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
