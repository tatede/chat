import { getRequestIp, isModeratorRequest } from "@/lib/moderation";
import { NextResponse } from "next/server";

export async function GET() {
  const [ip, canModerate] = await Promise.all([getRequestIp(), isModeratorRequest()]);

  return NextResponse.json({
    canModerate,
    requestIp: ip,
  });
}
