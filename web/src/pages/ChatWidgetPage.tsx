/**
 * ChatWidgetPage — rich-render chat panel built on assistant-ui v0.14.
 *
 * Two ways to use it:
 *
 *  1. Mounted at /chat-spike with no props → renders hardcoded mock messages
 *     (smoke-test surface; safe to delete once we trust the integration).
 *  2. Embedded inside ChatPage as <ChatWidgetPage sessionId={resumeParam} />
 *     → loads real session history from /api/sessions/{id}/messages and
 *     renders it through assistant-ui's primitive Thread.
 *
 * Currently READ-ONLY. Tool calls are rendered via the existing <ToolCall>
 * component (passed through a React Context keyed by message id). Composer
 * + streaming arrive in the next chunk.
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
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/Markdown";
import { ToolCall, type ToolEntry } from "@/components/ToolCall";
import { api, type SessionMessage } from "@/lib/api";
import {
  convertSessionMessages,
  type ConvertedThread,
} from "@/lib/chatMessageConverter";

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
    {
      id: "mock-2",
      role: "user",
      content: [
        { type: "text", text: "Got it. Why doubling instead of linear from the start?" },
      ],
    },
    {
      id: "mock-3",
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "Doubling probes available bandwidth in `log₂(N)` round-trips instead of `N`. " +
            "Linear growth from cold-start would leave a 1 Gbps link mostly idle for hundreds of RTTs " +
            "before reaching its capacity — the whole point of slow-start is to find the ceiling quickly, " +
            "*then* slow down once we're near it.",
        },
      ],
    },
  ],
  toolsByMessageId: new Map(),
};

/* ───────── Tool-entry context ─────────
 * AssistantMessage needs per-message tool entries, but assistant-ui's
 * primitive components don't pass arbitrary metadata through. The widget
 * provides a Map<messageId, ToolEntry[]> via React Context; AssistantMessage
 * reads it via useMessage() to get the current message id. */
const ToolEntriesContext = createContext<Map<string, ToolEntry[]>>(new Map());

function TextPart() {
  const { text } = useMessagePartText();
  if (!text) return null; // Skip the zero-width text part on tools-only assistant messages.
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
  | { kind: "empty" }
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

  useEffect(() => {
    if (!sessionId) {
      setState({ kind: "ready", thread: MOCK_THREAD });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });

    api
      .getSessionMessages(sessionId)
      .then((resp) => {
        if (cancelled) return;
        const converted = convertSessionMessages(
          resp.messages as SessionMessage[],
        );
        setState(
          converted.messages.length === 0
            ? { kind: "empty" }
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

  // Hooks run unconditionally; pass an empty thread until messages arrive.
  const thread = state.kind === "ready" ? state.thread : null;
  const messages = thread?.messages ?? [];
  const toolsByMessageId = useMemo(
    () => thread?.toolsByMessageId ?? new Map<string, ToolEntry[]>(),
    [thread],
  );
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: false,
    convertMessage: (m) => m,
    onNew: async () => {
      // Read-only for now; streaming input lands in the next chunk.
    },
  });

  return (
    <div className="flex h-full flex-col">
      {showHeader && (
        <div className="border-b border-border px-4 py-3">
          <h1 className="text-lg font-semibold text-foreground">
            {sessionId ? "Session messages" : "Chat Widget Spike"}
          </h1>
          <p className="text-xs text-muted-foreground">
            {sessionId
              ? `Read-only view of session ${sessionId}. Streaming input lands in the next iteration.`
              : "Read-only assistant-ui v0.14 thread with mock data. Smoke-test surface."}
          </p>
        </div>
      )}
      <ToolEntriesContext.Provider value={toolsByMessageId}>
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root className="flex-1 overflow-hidden">
            <ThreadPrimitive.Viewport className="flex h-full flex-col gap-4 overflow-y-auto p-4">
              {state.kind === "loading" && (
                <div className="m-auto text-sm text-muted-foreground">
                  Loading session…
                </div>
              )}
              {state.kind === "empty" && (
                <div className="m-auto max-w-md text-center text-sm text-muted-foreground">
                  This session has no renderable messages yet.
                </div>
              )}
              {state.kind === "error" && (
                <div className="m-auto max-w-md text-center text-sm text-destructive">
                  Couldn't load this session: {state.message}
                </div>
              )}
              {state.kind === "ready" && (
                <ThreadPrimitive.Messages
                  components={{ UserMessage, AssistantMessage }}
                />
              )}
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </ToolEntriesContext.Provider>
    </div>
  );
}
