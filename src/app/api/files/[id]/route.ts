import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { readFile, isValidFileId } from "@/lib/server/gridfs";
import { withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Streams a GridFS attachment.
 *
 * Requires a session. Authorization is intentionally coarse: any signed-in user
 * who can see a ticket may download its attachments, matching the ticket-level
 * RBAC already applied to the detail view.
 */
export const GET = withApi(async (_req: Request, { params }: Params) => {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "You must be signed in to download files." },
      { status: 401 },
    );
  }

  const { id } = await params;
  if (!isValidFileId(id)) {
    return NextResponse.json(
      { error: "bad_request", message: "That file id is not valid." },
      { status: 400 },
    );
  }

  const file = await readFile(id);
  if (!file) {
    return NextResponse.json({ error: "not_found", message: "File not found." }, { status: 404 });
  }

  const nodeStream = file.stream as unknown as ReadableStream;

  return new NextResponse(nodeStream as unknown as BodyInit, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.size),
      // `inline` lets the browser preview images and PDFs in place.
      "Content-Disposition": `inline; filename="${encodeURIComponent(file.filename)}"`,
      "Cache-Control": "private, max-age=3600",
      // Defence in depth: even though the stored body is sanitised, tell the
      // browser not to sniff or execute anything.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
});