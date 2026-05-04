"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Message = {
  id: number;
  displayName: string | null;
  message: string;
  parentMessageId: number | null;
  parentPreview: string | null;
  createdAt: string;
};

export function AnonymousChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [replyToId, setReplyToId] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replyTarget = useMemo(
    () => messages.find((entry) => entry.id === replyToId) ?? null,
    [messages, replyToId],
  );

  const fetchMessages = useCallback(async () => {
    const res = await fetch("/api/messages", { cache: "no-store" });

    if (!res.ok) {
      throw new Error("Failed to load messages");
    }

    const data = (await res.json()) as { messages: Message[] };
    setMessages(data.messages);
  }, []);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        await fetchMessages();
      } catch {
        if (mounted) {
          setError("Could not load messages right now.");
        }
      }
    };

    void load();

    const intervalId = setInterval(() => {
      void load();
    }, 3000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [fetchMessages]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = message.trim();

    if (!trimmed) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName,
          message: trimmed,
          parentMessageId: replyToId,
        }),
      });

      if (!res.ok) {
        const payload = (await res.json()) as { error?: string };
        throw new Error(payload.error ?? "Could not send message.");
      }

      setMessage("");
      setReplyToId(null);
      await fetchMessages();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8 sm:px-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Anonymous Chat</h1>
        <p className="mt-2 text-sm text-slate-600">
          Feed auto-refreshes every few seconds. Click reply on any message.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="displayName" className="mb-1 block text-sm font-medium text-slate-700">
              Name (optional)
            </label>
            <input
              id="displayName"
              name="displayName"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={30}
              placeholder="Anonymous"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-slate-300 transition focus:border-slate-400 focus:ring"
            />
          </div>

          {replyTarget ? (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm">
              <p className="font-medium text-indigo-900">Replying to #{replyTarget.id}</p>
              <p className="mt-1 line-clamp-2 text-indigo-800">{replyTarget.message}</p>
              <button
                type="button"
                onClick={() => setReplyToId(null)}
                className="mt-2 text-xs font-medium text-indigo-700 hover:text-indigo-900"
              >
                Cancel reply
              </button>
            </div>
          ) : null}

          <div>
            <label htmlFor="message" className="mb-1 block text-sm font-medium text-slate-700">
              Message
            </label>
            <textarea
              id="message"
              name="message"
              maxLength={500}
              required
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Type your message..."
              className="h-28 w-full resize-y rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none ring-slate-300 transition focus:border-slate-400 focus:ring"
            />
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Sending..." : "Send"}
          </button>
        </form>
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-lg font-semibold text-slate-900">Recent Messages</h2>

        {messages.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No messages yet. Be the first to post.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {messages.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-slate-800">
                    {entry.displayName?.trim() || "Anonymous"} <span className="text-slate-500">#{entry.id}</span>
                  </p>
                  <p className="text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</p>
                </div>

                {entry.parentMessageId ? (
                  <p className="mt-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
                    Reply to #{entry.parentMessageId}: {entry.parentPreview ?? "Original message"}
                  </p>
                ) : null}

                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{entry.message}</p>

                <button
                  type="button"
                  onClick={() => setReplyToId(entry.id)}
                  className="mt-2 text-xs font-medium text-slate-700 hover:text-slate-900"
                >
                  Reply
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
