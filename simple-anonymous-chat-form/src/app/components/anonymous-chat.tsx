"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type FormRecord = {
  id: number;
  title: string;
  description: string;
  createdBy: string | null;
  createdAt: string;
  messageCount: number;
};

type Message = {
  id: number;
  formId: number;
  displayName: string | null;
  badge: string | null;
  message: string;
  parentMessageId: number | null;
  parentPreview: string | null;
  reactions: Record<string, number>;
  totalReactions: number;
  editedAt: string | null;
  createdAt: string;
};

type BadgeEntry = {
  normalizedName: string;
  badge: string;
  updatedAt: string;
};

const EMOJIS = ["👍", "❤️", "😂", "🔥", "🎉"];

export function AnonymousChat() {
  const [forms, setForms] = useState<FormRecord[]>([]);
  const [formPagination, setFormPagination] = useState<Pagination>({ page: 1, pageSize: 6, total: 0, totalPages: 1 });
  const [formQueryInput, setFormQueryInput] = useState("");
  const [formQuery, setFormQuery] = useState("");
  const [formPage, setFormPage] = useState(1);

  const [selectedFormId, setSelectedFormId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagePage, setMessagePage] = useState(1);
  const [messagePagination, setMessagePagination] = useState<Pagination>({ page: 1, pageSize: 5, total: 0, totalPages: 1 });

  const [badges, setBadges] = useState<BadgeEntry[]>([]);
  const [canModerate, setCanModerate] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [replyToId, setReplyToId] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [newFormTitle, setNewFormTitle] = useState("");
  const [newFormDescription, setNewFormDescription] = useState("");
  const [isCreatingForm, setIsCreatingForm] = useState(false);

  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const [badgeName, setBadgeName] = useState("");
  const [badgeValue, setBadgeValue] = useState("");
  const [isSavingBadge, setIsSavingBadge] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [badgeError, setBadgeError] = useState<string | null>(null);
  const [badgeNotice, setBadgeNotice] = useState<string | null>(null);

  const selectedForm = useMemo(
    () => forms.find((form) => form.id === selectedFormId) ?? null,
    [forms, selectedFormId],
  );

  const replyTarget = useMemo(
    () => messages.find((entry) => entry.id === replyToId) ?? null,
    [messages, replyToId],
  );

  const fetchSession = useCallback(async () => {
    const res = await fetch("/api/session", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load session");
    const data = (await res.json()) as { canModerate: boolean };
    setCanModerate(data.canModerate);
  }, []);

  const fetchBadges = useCallback(async () => {
    const res = await fetch("/api/badges", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load badges");
    const data = (await res.json()) as { badges: BadgeEntry[] };
    setBadges(data.badges);
  }, []);

  const fetchForms = useCallback(async (query: string, page: number) => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    params.set("page", String(page));

    const res = await fetch(`/api/forms?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load forms");

    const data = (await res.json()) as { forms: FormRecord[]; pagination: Pagination };
    setForms(data.forms);
    setFormPagination(data.pagination);

    setSelectedFormId((current) => {
      if (current && data.forms.some((form) => form.id === current)) {
        return current;
      }
      return data.forms[0]?.id ?? null;
    });
  }, []);

  const fetchMessages = useCallback(async (formId: number | null, page: number) => {
    if (!formId) {
      setMessages([]);
      setMessagePagination({ page: 1, pageSize: 5, total: 0, totalPages: 1 });
      return;
    }

    const params = new URLSearchParams();
    params.set("formId", String(formId));
    params.set("page", String(page));

    const res = await fetch(`/api/messages?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load messages");

    const data = (await res.json()) as { messages: Message[]; pagination: Pagination };
    setMessages(data.messages);
    setMessagePagination(data.pagination);
  }, []);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        await Promise.all([fetchSession(), fetchBadges(), fetchForms(formQuery, formPage)]);
      } catch {
        if (mounted) setError("Could not load form data right now.");
      }
    };

    void load();
    const interval = setInterval(() => {
      void load();
    }, 4000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [fetchBadges, fetchForms, fetchSession, formPage, formQuery]);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        await fetchMessages(selectedFormId, messagePage);
      } catch {
        if (mounted) setError("Could not load messages right now.");
      }
    };

    void load();
    const interval = setInterval(() => {
      void load();
    }, 3000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [fetchMessages, messagePage, selectedFormId]);

  const onCreateForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsCreatingForm(true);

    try {
      const res = await fetch("/api/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newFormTitle,
          description: newFormDescription,
          createdBy: displayName,
        }),
      });

      const payload = (await res.json()) as { error?: string; id?: number | null };
      if (!res.ok) throw new Error(payload.error ?? "Could not create form.");

      setNewFormTitle("");
      setNewFormDescription("");
      setFormPage(1);
      await fetchForms(formQuery, 1);
      if (payload.id) {
        setSelectedFormId(payload.id);
        setMessagePage(1);
      }
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create form.");
    } finally {
      setIsCreatingForm(false);
    }
  };

  const onSubmitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedFormId) {
      setError("Create or select a form first.");
      return;
    }

    const trimmed = message.trim();
    if (!trimmed) return;

    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formId: selectedFormId,
          displayName,
          message: trimmed,
          parentMessageId: replyToId,
        }),
      });

      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Could not send message.");

      setMessage("");
      setReplyToId(null);
      setMessagePage(1);
      await Promise.all([fetchMessages(selectedFormId, 1), fetchForms(formQuery, formPage)]);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not send message.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const onReact = async (id: number, emoji: string) => {
    try {
      const res = await fetch("/api/messages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "react", emoji }),
      });

      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Reaction failed.");
      await fetchMessages(selectedFormId, messagePage);
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : "Reaction failed.");
    }
  };

  const onSaveEdit = async () => {
    if (!editingMessageId) return;

    try {
      const res = await fetch("/api/messages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingMessageId, action: "edit", message: editDraft }),
      });

      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Edit failed.");

      setEditingMessageId(null);
      setEditDraft("");
      await fetchMessages(selectedFormId, messagePage);
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : "Edit failed.");
    }
  };

  const onDeleteMessage = async (id: number) => {
    try {
      const res = await fetch("/api/messages", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });

      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Delete failed.");
      await Promise.all([fetchMessages(selectedFormId, messagePage), fetchForms(formQuery, formPage)]);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Delete failed.");
    }
  };

  const onSaveBadge = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBadgeError(null);
    setBadgeNotice(null);

    if (!badgeName.trim()) {
      setBadgeError("Enter a username first.");
      return;
    }

    setIsSavingBadge(true);

    try {
      const res = await fetch("/api/badges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: badgeName, badge: badgeValue }),
      });

      const payload = (await res.json()) as { error?: string; removed?: boolean };
      if (!res.ok) throw new Error(payload.error ?? "Could not save badge.");

      setBadgeNotice(payload.removed ? "Badge removed." : "Badge saved.");
      await Promise.all([fetchBadges(), fetchMessages(selectedFormId, messagePage)]);
    } catch (saveError) {
      setBadgeError(saveError instanceof Error ? saveError.message : "Could not save badge.");
    } finally {
      setIsSavingBadge(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8 sm:px-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Forms Discussion Board</h1>
        <p className="mt-2 text-sm text-slate-600">
          Search forms and browse paginated messages (5 per page), sorted by most reactions.
        </p>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Create Form</h2>
            <form onSubmit={onCreateForm} className="mt-4 space-y-3">
              <input
                value={newFormTitle}
                onChange={(event) => setNewFormTitle(event.target.value)}
                maxLength={80}
                placeholder="Form title"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
              <textarea
                value={newFormDescription}
                onChange={(event) => setNewFormDescription(event.target.value)}
                maxLength={500}
                placeholder="What is this form about?"
                className="h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={isCreatingForm}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
              >
                {isCreatingForm ? "Creating..." : "Create form"}
              </button>
            </form>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Forms</h2>

            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFormPage(1);
                setFormQuery(formQueryInput.trim());
              }}
            >
              <input
                value={formQueryInput}
                onChange={(event) => setFormQueryInput(event.target.value)}
                maxLength={80}
                placeholder="Search forms..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
              <button type="submit" className="rounded-xl bg-slate-900 px-3 py-2 text-xs text-white">
                Search
              </button>
            </form>

            <ul className="mt-3 space-y-2">
              {forms.map((form) => (
                <li key={form.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFormId(form.id);
                      setReplyToId(null);
                      setEditingMessageId(null);
                      setMessagePage(1);
                    }}
                    className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${
                      form.id === selectedFormId ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <p className="font-medium text-slate-900">{form.title}</p>
                    <p className="mt-1 text-xs text-slate-600">{form.messageCount} messages</p>
                  </button>
                </li>
              ))}
              {forms.length === 0 ? <p className="text-sm text-slate-500">No forms found.</p> : null}
            </ul>

            <div className="mt-3 flex items-center justify-between text-xs text-slate-600">
              <button
                type="button"
                disabled={formPagination.page <= 1}
                onClick={() => setFormPage((p) => Math.max(1, p - 1))}
                className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
              >
                Prev
              </button>
              <span>
                Page {formPagination.page} / {formPagination.totalPages}
              </span>
              <button
                type="button"
                disabled={formPagination.page >= formPagination.totalPages}
                onClick={() => setFormPage((p) => Math.min(formPagination.totalPages, p + 1))}
                className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>

          {canModerate ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-slate-900">Badge Manager</h2>
              <form onSubmit={onSaveBadge} className="mt-3 space-y-2">
                <input
                  value={badgeName}
                  onChange={(event) => setBadgeName(event.target.value)}
                  maxLength={30}
                  placeholder="username"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  value={badgeValue}
                  onChange={(event) => setBadgeValue(event.target.value)}
                  maxLength={20}
                  placeholder="badge (blank removes)"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={isSavingBadge}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white"
                >
                  {isSavingBadge ? "Saving..." : "Save badge"}
                </button>
                {badgeError ? <p className="text-xs text-red-600">{badgeError}</p> : null}
                {badgeNotice ? <p className="text-xs text-emerald-700">{badgeNotice}</p> : null}
              </form>

              <ul className="mt-3 space-y-1">
                {badges.slice(0, 8).map((entry) => (
                  <li key={entry.normalizedName} className="flex justify-between rounded-md bg-slate-50 px-2 py-1 text-xs">
                    <span>{entry.normalizedName}</span>
                    <span className="font-semibold text-indigo-700">{entry.badge}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">{selectedForm?.title ?? "Select a form"}</h2>
          <p className="mt-1 text-sm text-slate-600">{selectedForm?.description ?? "Create a form to get started."}</p>

          <form onSubmit={onSubmitMessage} className="mt-5 space-y-3">
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={30}
              placeholder="Your name (optional)"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />

            {replyTarget ? (
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
                Replying to #{replyTarget.id}: {replyTarget.message.slice(0, 120)}
                <button type="button" onClick={() => setReplyToId(null)} className="ml-2 text-xs underline">
                  cancel
                </button>
              </div>
            ) : null}

            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={1000}
              placeholder="Write a message..."
              className="h-28 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={isSubmitting || !selectedFormId}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {isSubmitting ? "Posting..." : "Post message"}
            </button>
          </form>

          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

          <p className="mt-6 text-xs text-slate-500">Sorted by most reactions. 5 messages per page.</p>

          <ul className="mt-3 space-y-3">
            {messages.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    <span>{entry.displayName?.trim() || "Anonymous"}</span>
                    {entry.badge ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        {entry.badge}
                      </span>
                    ) : null}
                    <span className="text-slate-500">#{entry.id}</span>
                  </p>
                  <p className="text-xs text-slate-500">⭐ {entry.totalReactions}</p>
                </div>

                {entry.parentMessageId ? (
                  <p className="mt-1 rounded-lg bg-white px-2 py-1 text-xs text-slate-600">
                    Reply to #{entry.parentMessageId}: {entry.parentPreview ?? "Original message"}
                  </p>
                ) : null}

                {editingMessageId === entry.id ? (
                  <div className="mt-2 space-y-2">
                    <textarea
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      maxLength={1000}
                      className="h-24 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => void onSaveEdit()} className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white">
                        Save edit
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMessageId(null);
                          setEditDraft("");
                        }}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                    {entry.message}
                    {entry.editedAt ? <span className="ml-2 text-xs text-slate-500">(edited)</span> : null}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setReplyToId(entry.id)} className="text-xs font-medium text-slate-700">
                    Reply
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingMessageId(entry.id);
                      setEditDraft(entry.message);
                    }}
                    className="text-xs font-medium text-slate-700"
                  >
                    Edit
                  </button>
                  {canModerate ? (
                    <button type="button" onClick={() => void onDeleteMessage(entry.id)} className="text-xs font-medium text-red-700">
                      Delete
                    </button>
                  ) : null}

                  {EMOJIS.map((emoji) => (
                    <button
                      key={`${entry.id}-${emoji}`}
                      type="button"
                      onClick={() => void onReact(entry.id, emoji)}
                      className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs"
                    >
                      {emoji} {entry.reactions[emoji] ?? 0}
                    </button>
                  ))}
                </div>
              </li>
            ))}
            {selectedFormId && messages.length === 0 ? <p className="text-sm text-slate-500">No messages yet.</p> : null}
          </ul>

          <div className="mt-4 flex items-center justify-between text-xs text-slate-600">
            <button
              type="button"
              disabled={messagePagination.page <= 1 || !selectedFormId}
              onClick={() => setMessagePage((p) => Math.max(1, p - 1))}
              className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
            >
              Prev
            </button>
            <span>
              Page {messagePagination.page} / {messagePagination.totalPages}
            </span>
            <button
              type="button"
              disabled={messagePagination.page >= messagePagination.totalPages || !selectedFormId}
              onClick={() => setMessagePage((p) => Math.min(messagePagination.totalPages, p + 1))}
              className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
