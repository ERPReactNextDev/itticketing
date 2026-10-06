import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Returns the signed-in user with their resolved permissions. */
export const GET = withApi(async () => {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({ user });
});