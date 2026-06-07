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
 * Currently READ-ONLY. The composer is not rendered, and onNew is a no-op.
 * Streaming + new-message input lands in the next chunk, which will swap
 * useExternalStoreRuntime for a useLocalRuntime + ChatModelAdapter that
 * talks to a (yet-to-be-built) /api/chat/stream WebSocket.
 */

import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessagePartText,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useState } from "react";

import { Markdown } from "@/components/Markdown";
import { api, type SessionMessage } from "@/lib/api";
import { convertSessionMessages } from "@/lib/chatMessageConverter";

const MOCK_MESSAGES: ThreadMessageLike[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Explain TCP slow-start in three bullets." }],
  },
  {
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
    role: "user",
    content: [{ type: "text", text: "Got it. Why doubling instead of linear from the start?" }],
  },
  {
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
];

function TextPart() {
  const { text } = useMessagePartText();
  return <Markdown content={text} />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
        <MessagePrimitive.Parts components={{ Text: TextPart }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-3">
        <MessagePrimitive.Parts components={{ Text: TextPart }} />
      </div>
    </MessagePrimitive.Root>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; messages: ThreadMessageLike[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export interface ChatWidgetPageProps {
  /** Session ID to load. When omitted, renders MOCK_MESSAGES (smoke-test mode). */
  sessionId?: string | null;
  /** Hide the page header when embedded inside ChatPage (which has its own chrome). */
  showHeader?: boolean;
}

export default function ChatWidgetPage({
  sessionId,
  showHeader = true,
}: ChatWidgetPageProps = {}) {
  const [state, setState] = useState<LoadState>(() =>
    sessionId ? { kind: "loading" } : { kind: "ready", messages: MOCK_MESSAGES },
  );

  useEffect(() => {
    if (!sessionId) {
      setState({ kind: "ready", messages: MOCK_MESSAGES });
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
          converted.length === 0
            ? { kind: "empty" }
            : { kind: "ready", messages: converted },
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

  // assistant-ui hooks must be called unconditionally; pass an empty thread
  // until messages arrive.
  const messages = state.kind === "ready" ? state.messages : [];
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: false,
    convertMessage: (m) => m,
    onNew: async () => {
      // Read-only for this chunk; streaming input arrives later.
    },
  });

  return (
    <div className="flex h-full flex-col">
      {showHeader && (
        <div className="border-b px-4 py-3">
          <h1 className="text-lg font-semibold">
            {sessionId ? "Session messages" : "Chat Widget Spike"}
          </h1>
          <p className="text-xs text-muted-foreground">
            {sessionId
              ? `Read-only view of session ${sessionId}. Streaming input lands in the next iteration.`
              : "Read-only assistant-ui v0.14 thread with mock data. Smoke-test surface."}
          </p>
        </div>
      )}
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
    </div>
  );
}
