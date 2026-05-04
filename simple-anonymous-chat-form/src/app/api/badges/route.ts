import { db } from "@/db";
import { chatUserBadges } from "@/db/schema";
import { isModeratorRequest } from "@/lib/moderation";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

type BadgePayload = {
  displayName?: unknown;
  badge?: unknown;
};

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

export async function GET() {
  const rows = await db.select().from(chatUserBadges).orderBy(desc(chatUserBadges.updatedAt));

  return NextResponse.json({
    badges: rows.map((row) => ({
      normalizedName: row.normalizedName,
      badge: row.badge,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const canModerate = await isModeratorRequest();

  if (!canModerate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as BadgePayload;

  const rawName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const rawBadge = typeof body.badge === "string" ? body.badge.trim() : "";

  if (!rawName) {
    return NextResponse.json({ error: "Display name is required." }, { status: 400 });
  }

  const normalizedName = normalizeName(rawName).slice(0, 30);

  if (!normalizedName) {
    return NextResponse.json({ error: "Display name is invalid." }, { status: 400 });
  }

  if (!rawBadge) {
    await db.delete(chatUserBadges).where(eq(chatUserBadges.normalizedName, normalizedName));
    return NextResponse.json({ ok: true, removed: true });
  }

  const badge = rawBadge.slice(0, 20);

  await db
    .insert(chatUserBadges)
    .values({
      normalizedName,
      badge,
    })
    .onConflictDoUpdate({
      target: chatUserBadges.normalizedName,
      set: {
        badge,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true, removed: false });
}
