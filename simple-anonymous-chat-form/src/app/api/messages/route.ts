import { db } from "@/db";
import { chatUserBadges, discussionForms, formMessageReactions, formMessages } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isModeratorRequest } from "@/lib/moderation";

type IncomingPayload = {
  id?: unknown;
  formId?: unknown;
  displayName?: unknown;
  message?: unknown;
  parentMessageId?: unknown;
  action?: unknown;
  emoji?: unknown;
};

const MESSAGES_PAGE_SIZE = 5;

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

function parsePositiveInt(value: unknown, fallback: number | null = null) {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

const ALLOWED_REACTIONS = new Set(["👍", "❤️", "😂", "🔥", "🎉"]);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const formId = parsePositiveInt(searchParams.get("formId"));
  const page = parsePositiveInt(searchParams.get("page"), 1) ?? 1;

  if (!formId) {
    return NextResponse.json({ error: "formId is required." }, { status: 400 });
  }

  const formExists = await db.select({ id: discussionForms.id }).from(discussionForms).where(eq(discussionForms.id, formId)).limit(1);

  if (formExists.length === 0) {
    return NextResponse.json({ error: "Form not found." }, { status: 404 });
  }

  const [allMessages, badges] = await Promise.all([
    db.select().from(formMessages).where(eq(formMessages.formId, formId)).orderBy(desc(formMessages.createdAt), desc(formMessages.id)),
    db.select().from(chatUserBadges),
  ]);

  const allMessageIds = allMessages.map((msg) => msg.id);
  const allReactions =
    allMessageIds.length === 0
      ? []
      : await db.select().from(formMessageReactions).where(inArray(formMessageReactions.messageId, allMessageIds));

  const reactionMap = new Map<number, Record<string, number>>();
  const totalReactionCount = new Map<number, number>();

  for (const reaction of allReactions) {
    const current = reactionMap.get(reaction.messageId) ?? {};
    current[reaction.emoji] = reaction.count;
    reactionMap.set(reaction.messageId, current);

    totalReactionCount.set(reaction.messageId, (totalReactionCount.get(reaction.messageId) ?? 0) + reaction.count);
  }

  const sortedMessages = [...allMessages].sort((a, b) => {
    const ra = totalReactionCount.get(a.id) ?? 0;
    const rb = totalReactionCount.get(b.id) ?? 0;

    if (rb !== ra) return rb - ra;

    const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
    if (timeDiff !== 0) return timeDiff;

    return b.id - a.id;
  });

  const total = sortedMessages.length;
  const totalPages = Math.max(1, Math.ceil(total / MESSAGES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * MESSAGES_PAGE_SIZE;
  const pageMessages = sortedMessages.slice(offset, offset + MESSAGES_PAGE_SIZE);

  const byId = new Map(allMessages.map((msg) => [msg.id, msg]));
  const badgeByName = new Map(badges.map((entry) => [entry.normalizedName, entry.badge]));

  return NextResponse.json({
    messages: pageMessages.map((msg) => {
      const normalized = msg.displayName ? normalizeName(msg.displayName) : null;

      return {
        id: msg.id,
        formId: msg.formId,
        displayName: msg.displayName,
        badge: normalized ? badgeByName.get(normalized) ?? null : null,
        message: msg.message,
        parentMessageId: msg.parentMessageId,
        parentPreview: msg.parentMessageId ? byId.get(msg.parentMessageId)?.message.slice(0, 120) ?? null : null,
        reactions: reactionMap.get(msg.id) ?? {},
        totalReactions: totalReactionCount.get(msg.id) ?? 0,
        editedAt: msg.editedAt ? msg.editedAt.toISOString() : null,
        createdAt: msg.createdAt.toISOString(),
      };
    }),
    pagination: {
      page: safePage,
      pageSize: MESSAGES_PAGE_SIZE,
      total,
      totalPages,
      sort: "most_reactions",
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as IncomingPayload;
  const formId = parsePositiveInt(body.formId);

  if (!formId) {
    return NextResponse.json({ error: "formId is required." }, { status: 400 });
  }

  const formExists = await db.select({ id: discussionForms.id }).from(discussionForms).where(eq(discussionForms.id, formId)).limit(1);

  if (formExists.length === 0) {
    return NextResponse.json({ error: "Form not found." }, { status: 404 });
  }

  const displayName =
    typeof body.displayName === "string" && body.displayName.trim().length > 0
      ? body.displayName.trim().slice(0, 30)
      : null;

  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!message) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }

  const parentMessageId = parsePositiveInt(body.parentMessageId);

  if (parentMessageId !== null) {
    const parentExists = await db
      .select({ id: formMessages.id })
      .from(formMessages)
      .where(and(eq(formMessages.id, parentMessageId), eq(formMessages.formId, formId)))
      .limit(1);

    if (parentExists.length === 0) {
      return NextResponse.json({ error: "Reply target not found in this form." }, { status: 400 });
    }
  }

  await db.insert(formMessages).values({
    formId,
    displayName,
    message: message.slice(0, 1000),
    parentMessageId,
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function PATCH(req: Request) {
  const body = (await req.json()) as IncomingPayload;
  const action = typeof body.action === "string" ? body.action : "";
  const id = parsePositiveInt(body.id);

  if (!id) {
    return NextResponse.json({ error: "Valid message id is required." }, { status: 400 });
  }

  if (action === "edit") {
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
      return NextResponse.json({ error: "Message text is required for edit." }, { status: 400 });
    }

    await db
      .update(formMessages)
      .set({
        message: message.slice(0, 1000),
        editedAt: new Date(),
      })
      .where(eq(formMessages.id, id));

    return NextResponse.json({ ok: true });
  }

  if (action === "react") {
    const emoji = typeof body.emoji === "string" ? body.emoji : "";

    if (!ALLOWED_REACTIONS.has(emoji)) {
      return NextResponse.json({ error: "Unsupported reaction." }, { status: 400 });
    }

    await db
      .insert(formMessageReactions)
      .values({
        messageId: id,
        emoji,
        count: 1,
      })
      .onConflictDoUpdate({
        target: [formMessageReactions.messageId, formMessageReactions.emoji],
        set: {
          count: sql`${formMessageReactions.count} + 1`,
        },
      });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
}

export async function DELETE(req: Request) {
  const canModerate = await isModeratorRequest();

  if (!canModerate) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as IncomingPayload;
  const id = parsePositiveInt(body.id);

  if (!id) {
    return NextResponse.json({ error: "Valid message id is required." }, { status: 400 });
  }

  await db.delete(formMessageReactions).where(eq(formMessageReactions.messageId, id));
  await db.delete(formMessages).where(eq(formMessages.id, id));

  return NextResponse.json({ ok: true });
}
