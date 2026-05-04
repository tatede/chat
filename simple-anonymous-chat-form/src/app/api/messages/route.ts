import { db } from "@/db";
import { chatMessages, chatUserBadges } from "@/db/schema";
import { isModeratorRequest } from "@/lib/moderation";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

type IncomingPayload = {
  id?: unknown;
  displayName?: unknown;
  message?: unknown;
  parentMessageId?: unknown;
};

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

export async function GET() {
  const [latest, badges] = await Promise.all([
    db
      .select()
      .from(chatMessages)
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(100),
    db.select().from(chatUserBadges),
  ]);

  const ordered = [...latest].reverse();
  const byId = new Map(ordered.map((msg) => [msg.id, msg]));
  const badgeByName = new Map(badges.map((entry) => [entry.normalizedName, entry.badge]));

  const payload = ordered.map((msg) => {
    const normalized = msg.displayName ? normalizeName(msg.displayName) : null;

    return {
      id: msg.id,
      displayName: msg.displayName,
      badge: normalized ? badgeByName.get(normalized) ?? null : null,
      message: msg.message,
      parentMessageId: msg.parentMessageId,
      parentPreview: msg.parentMessageId ? byId.get(msg.parentMessageId)?.message.slice(0, 120) ?? null : null,
      createdAt: msg.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ messages: payload });
}

export async function POST(req: Request) {
  const body = (await req.json()) as IncomingPayload;

  const displayName =
    typeof body.displayName === "string" && body.displayName.trim().length > 0
      ? body.displayName.trim().slice(0, 30)
      : null;

  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!message) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }

  const parsedParentId =
    typeof body.parentMessageId === "number"
      ? body.parentMessageId
      : typeof body.parentMessageId === "string"
        ? Number.parseInt(body.parentMessageId, 10)
        : null;

  const parentMessageId = Number.isInteger(parsedParentId) && parsedParentId && parsedParentId > 0 ? parsedParentId : null;

  if (parentMessageId !== null) {
    const parentExists = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.id, parentMessageId))
      .limit(1);

    if (parentExists.length === 0) {
      return NextResponse.json({ error: "Reply target not found." }, { status: 400 });
    }
  }

  await db.insert(chatMessages).values({
    displayName,
    message: message.slice(0, 500),
    parentMessageId,
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE(req: Request) {
  const canModerate = await isModeratorRequest();

  if (!canModerate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as IncomingPayload;

  const parsedId =
    typeof body.id === "number" ? body.id : typeof body.id === "string" ? Number.parseInt(body.id, 10) : null;

  if (!Number.isInteger(parsedId) || !parsedId || parsedId <= 0) {
    return NextResponse.json({ error: "Valid message id is required." }, { status: 400 });
  }

  const messageId = parsedId;

  await db.delete(chatMessages).where(eq(chatMessages.id, messageId));

  return NextResponse.json({ ok: true });
}
