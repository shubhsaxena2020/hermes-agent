/**
 * ChatWidgetPage — rich-render chat panel built on assistant-ui v0.14.
 *
 * Streaming composer (Option E from the audit): user input goes through the
 * existing /api/ws JSON-RPC gateway via `prompt.submit`. message.delta /
 * tool.start / tool.complete events flow back over the same socket. No new
 * backend route was added; we consume what tui_gateway already exposes for
 * Ink, iOS, and desktop clients.
 *
 * Three message sources are merged into the visible thread:
 *   - historic    : loaded once from /api/sessions/{id}/messages
 *   - local       : turns submitted in this browser session that have
 *                   already completed (user message + final assistant)
 *   - streaming   : the assistant message currently being streamed,
 *                   shown as a live preview bubble until message.complete
 */

import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessage,
  useMessagePartText,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Send } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { Markdown } from "@/components/Markdown";
import { ToolCall, type ToolEntry } from "@/components/ToolCall";
import { api, type SessionMessage } from "@/lib/api";
import {
  convertSessionMessages,
  type ConvertedThread,
} from "@/lib/chatMessageConverter";
import { useChatStreaming } from "@/lib/useChatStreaming";

const MOCK_THREAD: ConvertedThread = {
  messages: [
    {
      id: "mock-0",
      role: "user",
      content: [{ type: "text", text: "Explain TCP slow-start in three bullets." }],
    },
    {
      id: "mock-1",
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "**TCP slow-start** controls how aggressively a sender ramps up after a new connection or a loss event:\n\n" +
            "- Sender starts with a small congestion window (`cwnd`, ~10 segments) and **doubles** it each round-trip until reaching `ssthresh`.\n" +
            "- When `cwnd` hits `ssthresh`, the sender switches to **congestion avoidance** — linear growth via AIMD.\n" +
            "- A loss event halves `ssthresh`: timeout drops back to slow-start, three duplicate ACKs drop into congestion avoidance.",
        },
      ],
    },
  ],
  toolsByMessageId: new Map(),
};

/* ──────────── Tool-entry context (per-message) ───────────── */
const ToolEntriesContext = createContext<Map<string, ToolEntry[]>>(new Map());

function TextPart() {
  const { text } = useMessagePartText();
  if (!text) return null;
  return <Markdown content={text} />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl border border-primary/30 bg-primary/10 px-4 py-2 text-foreground">
        <MessagePrimitive.Parts components={{ Text: TextPart }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const message = useMessage();
  const toolEntries = useContext(ToolEntriesContext);
  const entries = (message.id && toolEntries.get(message.id)) || [];

  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="flex max-w-[80%] flex-col gap-2 rounded-2xl border border-border bg-muted/30 px-4 py-3">
        <MessagePrimitive.Parts components={{ Text: TextPart }} />
        {entries.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {entries.map((entry) => (
              <ToolCall key={entry.id} tool={entry} />
            ))}
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; thread: ConvertedThread }
  | { kind: "empty"; thread: ConvertedThread }
  | { kind: "error"; message: string };

export interface ChatWidgetPageProps {
  sessionId?: string | null;
  showHeader?: boolean;
}

export default function ChatWidgetPage({
  sessionId,
  showHeader = true,
}: ChatWidgetPageProps = {}) {
  const [state, setState] = useState<LoadState>(() =>
    sessionId ? { kind: "loading" } : { kind: "ready", thread: MOCK_THREAD },
  );

  // Messages produced in this browser session (user + completed assistant).
  // Kept separate from historic so we don't have to re-fetch /messages after
  // every turn.
  const [localMessages, setLocalMessages] = useState<ThreadMessageLike[]>([]);
  const [localTools, setLocalTools] = useState<Map<string, ToolEntry[]>>(
    () => new Map(),
  );

  const streaming = useChatStreaming(sessionId ?? null);

  useEffect(() => {
    if (!sessionId) {
      setState({ kind: "ready", thread: MOCK_THREAD });
      setLocalMessages([]);
      setLocalTools(new Map());
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });
    setLocalMessages([]);
    setLocalTools(new Map());

    api
      .getSessionMessages(sessionId)
      .then((resp) => {
        if (cancelled) return;
        const converted = convertSessionMessages(
          resp.messages as SessionMessage[],
        );
        setState(
          converted.messages.length === 0
            ? { kind: "empty", thread: converted }
            : { kind: "ready", thread: converted },
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // When a streamed turn completes, commit the final assistant message into
  // localMessages so subsequent turns see it as history. Trigger off the
  // streamingMessage transitioning to null between renders.
  const prevStreamingRef = useRef(streaming.streamingMessage);
  useEffect(() => {
    const prev = prevStreamingRef.current;
    const curr = streaming.streamingMessage;
    prevStreamingRef.current = curr;
    // Commit when we go from "active streaming" to "completed but not yet
    // cleared": isStreaming flips false while streamingMessage is still set.
    if (!streaming.isStreaming && prev && curr && prev.id === curr.id) {
      const id = `local-asst-${Date.now()}`;
      const finalText = curr.text;
      const finalTools = curr.tools;
      setLocalMessages((prevMsgs) => [
        ...prevMsgs,
        {
          id,
          role: "assistant",
          content: finalText ? [{ type: "text", text: finalText }] : [{ type: "text", text: "" }],
        },
      ]);
      if (finalTools.length > 0) {
        setLocalTools((prevTools) => {
          const next = new Map(prevTools);
          next.set(id, finalTools);
          return next;
        });
      }
      streaming.clearStreamingMessage();
    }
  }, [streaming]);

  // Build the displayed thread by merging historic + local + streaming preview.
  const merged: ThreadMessageLike[] = useMemo(() => {
    const hist =
      state.kind === "ready" || state.kind === "empty"
        ? state.thread.messages
        : [];
    const streamPreview: ThreadMessageLike[] = streaming.isStreaming
      ? [
          {
            id: streaming.streamingMessage?.id ?? "stream-preview",
            role: "assistant",
            content: [
              {
                type: "text",
                text: streaming.streamingMessage?.text ?? "",
              },
            ],
          },
        ]
      : [];
    return [...hist, ...localMessages, ...streamPreview];
  }, [state, localMessages, streaming.isStreaming, streaming.streamingMessage]);

  // Merge tool entries from all three sources so AssistantMessage finds them.
  const mergedTools = useMemo(() => {
    const out = new Map<string, ToolEntry[]>();
    if (state.kind === "ready" || state.kind === "empty") {
      for (const [k, v] of state.thread.toolsByMessageId) out.set(k, v);
    }
    for (const [k, v] of localTools) out.set(k, v);
    if (streaming.isStreaming && streaming.streamingMessage) {
      out.set(streaming.streamingMessage.id, streaming.streamingMessage.tools);
    }
    return out;
  }, [state, localTools, streaming.isStreaming, streaming.streamingMessage]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: merged,
    isRunning: streaming.isStreaming,
    convertMessage: (m) => m,
    // The custom composer below bypasses assistant-ui's append flow and
    // calls streaming.sendMessage directly, so onNew is a no-op here.
    onNew: async () => {},
  });

  // Composer (separate from assistant-ui's ComposerPrimitive so we have
  // full control over the styling + keyboard semantics).
  const [draft, setDraft] = useState("");
  const sessionReady = !!sessionId && streaming.ready;
  const canSend = sessionReady && !streaming.isStreaming && draft.trim().length > 0;

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft("");
    // Echo user message immediately so it appears before the gateway round-trip.
    setLocalMessages((prev) => [
      ...prev,
      {
        id: `local-user-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text }],
      },
    ]);
    streaming.sendMessage(text).catch(() => {
      // Error is already surfaced via streaming.error in the composer banner.
    });
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitDraft();
    }
  };

  return (
    <div className="flex h-full flex-col">
      {showHeader && (
        <div className="border-b border-border px-4 py-3">
          <h1 className="text-lg font-semibold text-foreground">
            {sessionId ? "Session messages" : "Chat Widget Spike"}
          </h1>
          <p className="text-xs text-muted-foreground">
            {sessionId
              ? `Session ${sessionId} — type below to continue the conversation.`
              : "Read-only assistant-ui v0.14 thread with mock data. Smoke-test surface."}
          </p>
        </div>
      )}
      <ToolEntriesContext.Provider value={mergedTools}>
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
            <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {state.kind === "loading" && (
                <div className="m-auto text-sm text-muted-foreground">
                  Loading session…
                </div>
              )}
              {state.kind === "error" && (
                <div className="m-auto max-w-md text-center text-sm text-destructive">
                  Couldn't load this session: {state.message}
                </div>
              )}
              {(state.kind === "ready" || state.kind === "empty") && (
                <>
                  {state.kind === "empty" && merged.length === 0 && (
                    <div className="m-auto max-w-md text-center text-sm text-muted-foreground">
                      No messages yet. Send one below to start the conversation.
                    </div>
                  )}
                  <ThreadPrimitive.Messages
                    components={{ UserMessage, AssistantMessage }}
                  />
                </>
              )}
            </ThreadPrimitive.Viewport>

            {/* Composer — only when we have a real session to send to. */}
            {sessionId && (
              <div className="border-t border-border bg-background/40 p-3">
                {streaming.error && (
                  <div className="mb-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
                    {streaming.error}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onComposerKey}
                    rows={1}
                    placeholder={
                      !sessionReady
                        ? "Connecting to gateway…"
                        : streaming.isStreaming
                        ? "Waiting for response…"
                        : "Type a message — Enter to send, Shift+Enter for newline"
                    }
                    disabled={!sessionReady || streaming.isStreaming}
                    className="min-h-[2.25rem] max-h-40 flex-1 resize-y rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={submitDraft}
                    disabled={!canSend}
                    aria-label="Send message"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary/15 text-foreground transition-colors hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </ToolEntriesContext.Provider>
    </div>
  );
}
