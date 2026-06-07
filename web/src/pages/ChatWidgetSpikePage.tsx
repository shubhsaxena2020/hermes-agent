/**
 * ChatWidgetSpikePage — proof-of-concept assistant-ui integration.
 *
 * Scope (intentionally minimal):
 *   - read-only: hardcoded mock messages, no composer, no streaming
 *   - validates that assistant-ui v0.14 + React 19.2 + Vite 7 build cleanly
 *   - validates that the existing <Markdown> renderer slots in as the
 *     text-part component, so we don't have to import or style markdown twice
 *
 * Out of scope for the spike (deferred to phase 2+ if this works):
 *   - real session-history load from /api/sessions/{id}/messages
 *   - WebSocket / streaming via ChatModelAdapter
 *   - tool-call rendering through the existing <ToolCall> component
 *   - composer / input flow
 *   - dark/light theme integration
 *
 * Route: /chat-spike  (registered in web/src/App.tsx BUILTIN_ROUTES_CORE)
 */

import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessagePartText,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useState } from "react";

import { Markdown } from "@/components/Markdown";

const MOCK_MESSAGES: ThreadMessageLike[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Explain TCP slow-start in three bullets." },
    ],
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

/** Text-part renderer. Pulls the running text from the assistant-ui store
 *  and hands it to our existing <Markdown> component. */
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

export default function ChatWidgetSpikePage() {
  const [messages] = useState<ThreadMessageLike[]>(MOCK_MESSAGES);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: false,
    // Identity converter — our messages are already ThreadMessageLike.
    convertMessage: (m) => m,
    // Read-only spike: onNew is a no-op. The composer isn't rendered anyway.
    onNew: async () => {},
  });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h1 className="text-lg font-semibold">Chat Widget Spike</h1>
        <p className="text-xs text-muted-foreground">
          Read-only assistant-ui v0.14 thread, slotting in the existing
          Markdown renderer. Validates the library shape before we build
          the streaming backend.
        </p>
      </div>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="flex-1 overflow-hidden">
          <ThreadPrimitive.Viewport className="flex h-full flex-col gap-4 overflow-y-auto p-4">
            <ThreadPrimitive.Messages
              components={{ UserMessage, AssistantMessage }}
            />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}
