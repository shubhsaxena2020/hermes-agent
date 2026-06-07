/**
 * useChatStreaming — bridge the assistant-ui widget to the existing
 * tui_gateway over /api/ws.
 *
 * v2 adds: approval/clarify/sudo/secret prompt handling, reasoning + thinking
 * stream, mid-turn cancel via session.interrupt, exponential-backoff reconnect
 * with session.resume re-attach, and a manual-retry escape hatch.
 *
 * Verified against the gateway (commit 2d08047):
 *   prompt.submit       (server.py:4342)  → starts a turn, streams events
 *   session.resume      (server.py:3276)  → attaches to an existing session
 *   session.interrupt   (server.py:4059)  → cancels in-flight turn
 *   clarify.respond     (server.py:5609)  → {request_id, answer}
 *   sudo.respond        (server.py:5614)  → {request_id, password}
 *   secret.respond      (server.py:5619)  → {request_id, value}
 *   approval.respond    (server.py:5624)  → {session_id, choice, all?}
 *                                            (routes via tools/approval, NOT
 *                                            via request_id like the others)
 *   slash.exec          (server.py:7672)  → {session_id, command}
 *   complete.slash      (server.py:7368)  → {text} → {items: [...]}
 *   image.attach_bytes  (server.py:5189)  → {session_id, content_base64, ...}
 *
 * Out of scope (still): mid-turn streaming reasoning toggle UI, slash command
 * pager output, multi-attachment thumbnails — all the gaps that need real
 * design rather than just wire-up.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { GatewayClient, type GatewayEvent } from "@/lib/gatewayClient";
import type { ToolEntry } from "@/components/ToolCall";

export interface StreamingMessage {
  id: string;
  text: string;
  tools: ToolEntry[];
}

export type PendingPrompt =
  | {
      kind: "approval";
      requestId: string;
      payload: {
        command?: string;
        description?: string;
        pattern_keys?: string[];
        [k: string]: unknown;
      };
    }
  | {
      kind: "clarify";
      requestId: string;
      payload: { question?: string; choices?: string[]; [k: string]: unknown };
    }
  | {
      kind: "sudo";
      requestId: string;
      payload: Record<string, unknown>;
    }
  | {
      kind: "secret";
      requestId: string;
      payload: {
        prompt?: string;
        env_var?: string;
        metadata?: Record<string, unknown>;
        [k: string]: unknown;
      };
    };

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number; nextRetryMs: number }
  | { kind: "failed"; reason: string };

export interface ChatStreamingState {
  streamingMessage: StreamingMessage | null;
  reasoningText: string;
  isStreaming: boolean;
  error: string | null;
  pendingPrompt: PendingPrompt | null;
  connectionStatus: ConnectionStatus;
  /** True when the gateway WS is open AND session.resume succeeded. */
  ready: boolean;
  sendMessage: (text: string) => Promise<void>;
  cancelTurn: () => Promise<void>;
  respondToPrompt: (answer: string) => Promise<void>;
  respondToApproval: (choice: "allow" | "deny", all?: boolean) => Promise<void>;
  manualRetry: () => void;
  clearStreamingMessage: () => void;
  /** Run a slash command. Routes through slash.exec (separate from prompt.submit). */
  runSlash: (command: string) => Promise<unknown>;
  /** Fetch slash-command completions for the popover. Empty array on error. */
  completeSlash: (text: string) => Promise<SlashCompletion[]>;
  /** Upload an image to the session. Returns the gateway's metadata so the
   *  caller can build a thumbnail; the image is auto-included on the next
   *  prompt.submit. */
  attachImageBytes: (
    base64: string,
    opts?: { filename?: string },
  ) => Promise<AttachmentMeta>;
}

export interface SlashCompletion {
  text: string;
  display: string;
  meta: string;
}

export interface AttachmentMeta {
  attached: boolean;
  path: string;
  count: number;
  text?: string;
  width?: number;
  height?: number;
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

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 30_000];

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

function pickToolId(p: ToolStartPayload | ToolCompletePayload): string | null {
  return (p.tool_id ?? p.id) || null;
}

export function useChatStreaming(sessionId: string | null | undefined): ChatStreamingState {
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessage | null>(null);
  const [reasoningText, setReasoningText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ kind: "idle" });

  const gwRef = useRef<GatewayClient | null>(null);
  const turnResolverRef = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  // Bumping this token triggers the connect effect to retry. Used for both
  // manual retries and the auto-reconnect timer callback.
  const [retryToken, setRetryToken] = useState(0);
  const reconnectAttemptRef = useRef(0);

  // Open + bind the gateway. Re-runs when sessionId changes or retryToken bumps.
  useEffect(() => {
    if (!sessionId) {
      setConnectionStatus({ kind: "idle" });
      return;
    }

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const gw = new GatewayClient();
    gwRef.current = gw;
    setConnectionStatus({ kind: "connecting" });

    const unsubscribers: Array<() => void> = [];

    // ── streaming events ─────────────────────────────────────────────
    unsubscribers.push(
      gw.on("message.start", () => {
        const id = `stream-${Date.now()}`;
        setStreamingMessage({ id, text: "", tools: [] });
        setReasoningText("");
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

    // ── reasoning / thinking ─────────────────────────────────────────
    const onReasoningDelta = (ev: GatewayEvent<{ text?: string }>) => {
      const delta = ev.payload?.text ?? "";
      if (!delta) return;
      setReasoningText((prev) => prev + delta);
    };
    unsubscribers.push(gw.on("reasoning.delta", onReasoningDelta));
    unsubscribers.push(gw.on("thinking.delta", onReasoningDelta));
    unsubscribers.push(
      gw.on("reasoning.available", (ev: GatewayEvent<{ text?: string }>) => {
        const t = ev.payload?.text ?? "";
        if (t && t !== reasoningText) setReasoningText(t);
      }),
    );

    // ── interactive prompts ──────────────────────────────────────────
    type PromptPayload = { request_id?: string } & Record<string, unknown>;
    const onPromptRequest = (kind: PendingPrompt["kind"]) => (ev: GatewayEvent<PromptPayload>) => {
      const p = ev.payload ?? {};
      const requestId = String(p.request_id ?? "");
      // approval flow uses session_key, not request_id; keep requestId
      // for the other three so respondToPrompt can echo it back.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setPendingPrompt({ kind, requestId, payload: p } as any);
    };
    unsubscribers.push(gw.on("approval.request", onPromptRequest("approval")));
    unsubscribers.push(gw.on("clarify.request", onPromptRequest("clarify")));
    unsubscribers.push(gw.on("sudo.request", onPromptRequest("sudo")));
    unsubscribers.push(gw.on("secret.request", onPromptRequest("secret")));

    // ── errors ───────────────────────────────────────────────────────
    unsubscribers.push(
      gw.on("error", (ev: GatewayEvent<{ message?: string }>) => {
        const msg = ev.payload?.message ?? "gateway error";
        setError(msg);
        setIsStreaming(false);
        turnResolverRef.current?.reject(new Error(msg));
        turnResolverRef.current = null;
      }),
    );

    // ── connection-state transitions: handle drops + reconnect ───────
    const unsubState = gw.onState((s) => {
      if (cancelled) return;
      if (s === "closed" || s === "error") {
        // If we were "ready" or "connecting", the WS dropped. Try to reconnect.
        const attempt = reconnectAttemptRef.current + 1;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          setConnectionStatus({
            kind: "failed",
            reason: "Connection lost — click to retry",
          });
          return;
        }
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)];
        reconnectAttemptRef.current = attempt;
        setConnectionStatus({ kind: "reconnecting", attempt, nextRetryMs: delay });
        reconnectTimer = setTimeout(() => {
          if (!cancelled) setRetryToken((t) => t + 1);
        }, delay);
      }
    });
    unsubscribers.push(unsubState);

    gw.connect()
      .then(async () => {
        if (cancelled) return;
        try {
          await gw.request("session.resume", { session_id: sessionId });
          if (cancelled) return;
          reconnectAttemptRef.current = 0;
          setConnectionStatus({ kind: "ready" });
          setError(null);
        } catch (e) {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : String(e));
            setConnectionStatus({
              kind: "failed",
              reason: "session.resume failed: " + (e instanceof Error ? e.message : String(e)),
            });
          }
        }
      })
      .catch(() => {
        // Open failed — the onState("error"/"closed") branch will schedule a retry.
      });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const u of unsubscribers) u();
      gw.close();
      gwRef.current = null;
    };
  // We deliberately exclude reasoningText from deps — it's referenced inside
  // reasoning.available handler only to skip duplicate full-text emissions,
  // and re-subscribing on every delta would be a perf bug.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, retryToken]);

  const ready = connectionStatus.kind === "ready";

  const sendMessage = useCallback(
    (text: string): Promise<void> => {
      if (!gwRef.current || !ready) {
        return Promise.reject(new Error("gateway not ready"));
      }
      if (!sessionId) return Promise.reject(new Error("no session id"));
      if (isStreaming) return Promise.reject(new Error("turn already in progress"));

      setError(null);
      setReasoningText("");
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

  const cancelTurn = useCallback(async (): Promise<void> => {
    if (!gwRef.current || !sessionId) return;
    if (!isStreaming) return;
    try {
      await gwRef.current.request("session.interrupt", { session_id: sessionId });
    } catch (e) {
      // Best-effort. The interrupt may race with completion; surface error
      // only if it's not the benign "no session" case.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no session|not found/i.test(msg)) setError(msg);
    } finally {
      setIsStreaming(false);
      turnResolverRef.current?.resolve();
      turnResolverRef.current = null;
    }
  }, [sessionId, isStreaming]);

  const respondToPrompt = useCallback(
    async (answer: string): Promise<void> => {
      if (!gwRef.current || !pendingPrompt || !sessionId) return;
      const method =
        pendingPrompt.kind === "clarify"
          ? "clarify.respond"
          : pendingPrompt.kind === "sudo"
          ? "sudo.respond"
          : "secret.respond";
      const key =
        pendingPrompt.kind === "clarify"
          ? "answer"
          : pendingPrompt.kind === "sudo"
          ? "password"
          : "value";
      try {
        await gwRef.current.request(method, {
          session_id: sessionId,
          request_id: pendingPrompt.requestId,
          [key]: answer,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingPrompt(null);
      }
    },
    [pendingPrompt, sessionId],
  );

  const respondToApproval = useCallback(
    async (choice: "allow" | "deny", all = false): Promise<void> => {
      if (!gwRef.current || !sessionId) return;
      try {
        await gwRef.current.request("approval.respond", {
          session_id: sessionId,
          choice,
          all,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingPrompt(null);
      }
    },
    [sessionId],
  );

  const manualRetry = useCallback(() => {
    reconnectAttemptRef.current = 0;
    setError(null);
    setRetryToken((t) => t + 1);
  }, []);

  const clearStreamingMessage = useCallback(() => {
    setStreamingMessage(null);
  }, []);

  const runSlash = useCallback(
    async (command: string): Promise<unknown> => {
      if (!gwRef.current || !sessionId || !ready) {
        throw new Error("gateway not ready");
      }
      return gwRef.current.request("slash.exec", { session_id: sessionId, command });
    },
    [sessionId, ready],
  );

  const completeSlash = useCallback(
    async (text: string): Promise<SlashCompletion[]> => {
      if (!gwRef.current || !ready) return [];
      try {
        const res = (await gwRef.current.request("complete.slash", { text })) as {
          items?: SlashCompletion[];
        };
        return res?.items ?? [];
      } catch {
        return [];
      }
    },
    [ready],
  );

  const attachImageBytes = useCallback(
    async (
      base64: string,
      opts?: { filename?: string },
    ): Promise<AttachmentMeta> => {
      if (!gwRef.current || !sessionId || !ready) {
        throw new Error("gateway not ready");
      }
      const params: Record<string, unknown> = {
        session_id: sessionId,
        content_base64: base64,
      };
      if (opts?.filename) params.filename = opts.filename;
      return (await gwRef.current.request("image.attach_bytes", params)) as AttachmentMeta;
    },
    [sessionId, ready],
  );

  return {
    streamingMessage,
    reasoningText,
    isStreaming,
    error,
    pendingPrompt,
    connectionStatus,
    ready,
    sendMessage,
    cancelTurn,
    respondToPrompt,
    respondToApproval,
    manualRetry,
    clearStreamingMessage,
    runSlash,
    completeSlash,
    attachImageBytes,
  };
}
