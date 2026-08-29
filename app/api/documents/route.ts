import { NextResponse } from "next/server";
import { db, ensureBookingTables } from "../../../lib/db";
import { requireActiveAccount } from "../bookings/_lib";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "image/png",
  "image/jpeg",
]);

export async function GET() {
  await ensureBookingTables();
  const documents = await db().query(
    `SELECT id, title, booking_reference, trainer_name, status, file_name, file_mime, file_size, created_at, updated_at
     FROM delivery_documents ORDER BY updated_at DESC, title`,
  );
  return NextResponse.json({ documents: documents.rows });
}

export async function POST(request: Request) {
  const accountBlocked = await requireActiveAccount();
  if (accountBlocked) return accountBlocked;
  try {
    const form = await request.formData();
    const documentId = String(form.get("documentId") ?? "");
    const file = form.get("file");
    if (!documentId || !(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "Choose a document file to upload" }, { status: 400 });
    }
    if (file.size > MAX_DOCUMENT_BYTES) return NextResponse.json({ error: "Documents must be 10MB or smaller" }, { status: 400 });
    if (!ALLOWED_DOCUMENT_MIMES.has(file.type)) return NextResponse.json({ error: "Upload a PDF, Office document, PNG, or JPEG file" }, { status: 400 });
    await ensureBookingTables();
    const result = await db().query(
      `UPDATE delivery_documents SET file_name=$2, file_mime=$3, file_data=$4, file_size=$5, status='Uploaded', updated_at=CURRENT_TIMESTAMP
       WHERE id=$1
       RETURNING id, title, booking_reference, trainer_name, status, file_name, file_mime, file_size, created_at, updated_at`,
      [documentId, file.name.slice(0, 255), file.type, Buffer.from(await file.arrayBuffer()), file.size],
    );
    if (!result.rows[0]) return NextResponse.json({ error: "Document record not found" }, { status: 404 });
    return NextResponse.json({ document: result.rows[0] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to upload document" }, { status: 400 });
  }
}
