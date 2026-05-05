import { db } from "@/db";
import { discussionForms, formMessages } from "@/db/schema";
import { desc, ilike, inArray, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

type FormPayload = {
  title?: unknown;
  description?: unknown;
  createdBy?: unknown;
};

const FORMS_PAGE_SIZE = 6;

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").trim().slice(0, 80);
  const page = parsePositiveInt(searchParams.get("page"), 1);

  const filter = query
    ? or(
        ilike(discussionForms.title, `%${query}%`),
        ilike(discussionForms.description, `%${query}%`),
        ilike(discussionForms.createdBy, `%${query}%`),
      )
    : undefined;

  const countRows =
    filter === undefined
      ? await db.select({ count: sql<number>`count(*)::int` }).from(discussionForms)
      : await db.select({ count: sql<number>`count(*)::int` }).from(discussionForms).where(filter);

  const total = countRows[0]?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / FORMS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * FORMS_PAGE_SIZE;

  const forms =
    filter === undefined
      ? await db
          .select()
          .from(discussionForms)
          .orderBy(desc(discussionForms.createdAt))
          .limit(FORMS_PAGE_SIZE)
          .offset(offset)
      : await db
          .select()
          .from(discussionForms)
          .where(filter)
          .orderBy(desc(discussionForms.createdAt))
          .limit(FORMS_PAGE_SIZE)
          .offset(offset);

  const formIds = forms.map((form) => form.id);

  const counts =
    formIds.length === 0
      ? []
      : await db
          .select({
            formId: formMessages.formId,
            count: sql<number>`count(*)::int`,
          })
          .from(formMessages)
          .where(inArray(formMessages.formId, formIds))
          .groupBy(formMessages.formId);

  const countByFormId = new Map(counts.map((entry) => [entry.formId, entry.count]));

  return NextResponse.json({
    forms: forms.map((form) => ({
      id: form.id,
      title: form.title,
      description: form.description,
      createdBy: form.createdBy,
      createdAt: form.createdAt.toISOString(),
      messageCount: countByFormId.get(form.id) ?? 0,
    })),
    pagination: {
      query,
      page: safePage,
      pageSize: FORMS_PAGE_SIZE,
      total,
      totalPages,
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as FormPayload;

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 500) : "";
  const createdBy =
    typeof body.createdBy === "string" && body.createdBy.trim().length > 0
      ? body.createdBy.trim().slice(0, 30)
      : null;

  if (!title) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }

  if (!description) {
    return NextResponse.json({ error: "Description is required." }, { status: 400 });
  }

  const inserted = await db
    .insert(discussionForms)
    .values({
      title,
      description,
      createdBy,
    })
    .returning({
      id: discussionForms.id,
    });

  return NextResponse.json({ ok: true, id: inserted[0]?.id ?? null }, { status: 201 });
}
