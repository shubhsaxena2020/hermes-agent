/**
 * useChatStreaming — bridge the assistant-ui widget to the existing
 * tui_gateway over /api/ws.
 *
 * Architecture (verified against repo source):
 *   - tui_gateway/ws.py serves a JSON-RPC dialect identical to Ink's stdio
 *   - tui_gateway/server.py:4342 exposes `@method("prompt.submit")` which
 *     takes {session_id, text}, lazily builds an AIAgent for the session,
 *     starts the turn, returns {status: "streaming"} immediately, and
 *     fans events back over the same WebSocket
 *   - web/src/lib/gatewayClient.ts already implements the client side
 *     (auth, JSON-RPC framing, event subscription, request/response
 *     correlation) — we reuse it as-is
 *
 * What this hook does on top:
 *   - lazy-opens one GatewayClient per session id
 *   - calls session.resume on connect so prompt.submit binds to the
 *     correct session row
 *   - accumulates message.delta frames into a single streamingMessage
 *     that the widget renders as a live assistant bubble
 *   - tracks in-flight tool calls from tool.start / tool.complete events
 *     and surfaces them as ToolEntry[] on the streaming message
 *   - exposes a single boolean `isStreaming` so the composer can disable
 *     itself between turns
 *
 * What's deliberately out of scope for v1:
 *   - approval / clarify / sudo / secret request modals (gateway emits
 *     them; we ignore for now and the user can hit `terminal` toggle if
 *     a turn stalls waiting for one)
 *   - reasoning.delta streaming UI
 *   - reconnection logic — drop on the floor for now, user reloads
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { GatewayClient, type GatewayEvent } from "@/lib/gatewayClient";
import type { ToolEntry } from "@/components/ToolCall";

export interface StreamingMessage {
  id: string;
  text: string;
  tools: ToolEntry[];
}

export interface ChatStreamingState {
  /** Assistant message currently being streamed, or null between turns. */
  streamingMessage: StreamingMessage | null;
  /** True while a turn is in flight. Composer should disable input. */
  isStreaming: boolean;
  /** Last error from the gateway, if any. Cleared on next successful submit. */
  error: string | null;
  /** True once the gateway WebSocket is open and session.resume succeeded. */
  ready: boolean;
  /** Send a new user message. Resolves when the turn completes (or errors). */
  sendMessage: (text: string) => Promise<void>;
  /** Manual reset of the per-turn state — used after the parent commits
   *  the streamed assistant message into its own history. */
  clearStreamingMessage: () => void;
}

interface ToolStartPayload {
  tool_id?: string;
  id?: string;
  name?: string;
  args?: unknown;
  context?: string;
}
interface ToolCompletePayload {
  tool_id?: string;
  id?: string;
  summary?: string;
  result?: string;
  error?: string;
}

/** Best-effort short context line from tool args (mirror of converter logic). */
function argsToContext(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    let s: string;
    if (typeof v === "string") s = v.length > 60 ? v.slice(0, 57) + "…" : v;
    else if (v === null || typeof v === "number" || typeof v === "boolean") s = String(v);
    else s = Array.isArray(v) ? `[${v.length}]` : "{…}";
    parts.push(`${k}=${s}`);
  }
  return parts.join(", ");
}

/** Resolve the tool id from a tool.* event payload — accepts both `id` and
 *  `tool_id` since different code paths in the gateway use different keys. */
function pickToolId(p: ToolStartPayload | ToolCompletePayload): string | null {
  return (p.tool_id ?? p.id) || null;
}

export function useChatStreaming(sessionId: string | null | undefined): ChatStreamingState {
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessage | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Refs survive re-renders without re-subscribing.
  const gwRef = useRef<GatewayClient | null>(null);
  const currentTurnIdRef = useRef<string | null>(null);
  // Resolver/rejector for the in-flight sendMessage() promise. Cleared on
  // message.complete or error.
  const turnResolverRef = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

  // Open + bind the gateway once per sessionId.
  useEffect(() => {
    if (!sessionId) {
      setReady(false);
      return;
    }

    let cancelled = false;
    const gw = new GatewayClient();
    gwRef.current = gw;

    // Subscribe BEFORE connecting so we don't miss the initial gateway.ready.
    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(
      gw.on("message.start", () => {
        const id = `stream-${Date.now()}`;
        currentTurnIdRef.current = id;
        setStreamingMessage({ id, text: "", tools: [] });
      }),
    );

    unsubscribers.push(
      gw.on("message.delta", (ev: GatewayEvent<{ text?: string }>) => {
        const delta = ev.payload?.text ?? "";
        if (!delta) return;
        setStreamingMessage((prev) =>
          prev ? { ...prev, text: prev.text + delta } : prev,
        );
      }),
    );

    unsubscribers.push(
      gw.on("message.complete", () => {
        setIsStreaming(false);
        turnResolverRef.current?.resolve();
        turnResolverRef.current = null;
        // Leave streamingMessage in state — the parent commits it then
        // calls clearStreamingMessage().
      }),
    );

    unsubscribers.push(
      gw.on("tool.start", (ev: GatewayEvent<ToolStartPayload>) => {
        const p = ev.payload ?? {};
        const id = pickToolId(p);
        if (!id) return;
        const entry: ToolEntry = {
          kind: "tool",
          id,
          tool_id: id,
          name: p.name ?? "tool",
          context: p.context ?? argsToContext(p.args),
          status: "running",
          startedAt: Date.now(),
        };
        setStreamingMessage((prev) =>
          prev
            ? { ...prev, tools: [...prev.tools, entry] }
            : { id: `stream-${Date.now()}`, text: "", tools: [entry] },
        );
      }),
    );

    unsubscribers.push(
      gw.on("tool.complete", (ev: GatewayEvent<ToolCompletePayload>) => {
        const p = ev.payload ?? {};
        const id = pickToolId(p);
        if (!id) return;
        setStreamingMessage((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            tools: prev.tools.map((t) =>
              t.id === id
                ? {
                    ...t,
                    status: p.error ? "error" : "done",
                    summary: p.summary ?? p.result,
                    error: p.error,
                    completedAt: Date.now(),
                  }
                : t,
            ),
          };
        });
      }),
    );

    unsubscribers.push(
      gw.on("error", (ev: GatewayEvent<{ message?: string }>) => {
        const msg = ev.payload?.message ?? "gateway error";
        setError(msg);
        setIsStreaming(false);
        turnResolverRef.current?.reject(new Error(msg));
        turnResolverRef.current = null;
      }),
    );

    gw.connect()
      .then(async () => {
        if (cancelled) return;
        try {
          await gw.request("session.resume", { session_id: sessionId });
          if (!cancelled) setReady(true);
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });

    return () => {
      cancelled = true;
      for (const u of unsubscribers) u();
      gw.close();
      gwRef.current = null;
      setReady(false);
      setStreamingMessage(null);
      setIsStreaming(false);
    };
  }, [sessionId]);

  const sendMessage = useCallback(
    (text: string): Promise<void> => {
      if (!gwRef.current || !ready) {
        return Promise.reject(new Error("gateway not ready"));
      }
      if (!sessionId) return Promise.reject(new Error("no session id"));
      if (isStreaming) return Promise.reject(new Error("turn already in progress"));

      setError(null);
      setStreamingMessage({ id: `stream-${Date.now()}`, text: "", tools: [] });
      setIsStreaming(true);

      const turnPromise = new Promise<void>((resolve, reject) => {
        turnResolverRef.current = { resolve, reject };
      });

      gwRef.current
        .request("prompt.submit", { session_id: sessionId, text })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          setIsStreaming(false);
          turnResolverRef.current?.reject(new Error(msg));
          turnResolverRef.current = null;
        });

      return turnPromise;
    },
    [sessionId, isStreaming, ready],
  );

  const clearStreamingMessage = useCallback(() => {
    setStreamingMessage(null);
    currentTurnIdRef.current = null;
  }, []);

  return {
    streamingMessage,
    isStreaming,
    error,
    ready,
    sendMessage,
    clearStreamingMessage,
  };
}
