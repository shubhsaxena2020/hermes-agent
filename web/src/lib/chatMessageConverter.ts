/**
 * Convert Hermes session messages (from /api/sessions/{id}/messages) into
 * assistant-ui's ThreadMessageLike format, plus a sidecar map of tool entries
 * keyed by the assistant message's stable id.
 *
 * Hermes wire format pairs an assistant.tool_calls entry with a later
 * role:"tool" message carrying that call's result (linked by
 * tool_call_id). assistant-ui's primitive Thread doesn't natively know
 * about this pairing, so we walk the message list, build a real
 * ToolEntry[] per assistant message (re-using the rich <ToolCall>
 * component the rest of the dashboard uses), and stash them in a Map.
 * The widget then renders them inline under the assistant text via a
 * React Context, instead of inlining a flat "_Used:_ name(args)" string.
 *
 * Scope:
 *   - user / assistant text → rendered as before
 *   - system messages → dropped
 *   - role:"tool" messages → consumed as results for their parent
 *     assistant message, then dropped from the visible thread
 *   - assistant.tool_calls → ToolEntry[] in the sidecar, rendered by
 *     the widget as <ToolCall>
 */

import type { ThreadMessageLike } from "@assistant-ui/react";

import type { SessionMessage } from "@/lib/api";
import type { ToolEntry } from "@/components/ToolCall";

export interface ConvertedThread {
  /** Renderable user/assistant messages. Every message has a stable `id`
   *  so the widget can correlate it with tool entries below. */
  messages: ThreadMessageLike[];
  /** assistant-message-id → tool entries to render under that bubble. */
  toolsByMessageId: Map<string, ToolEntry[]>;
}

/** Stringify tool args as a short context line ("path=/foo, mode=r")
 *  matching the Ink ToolTrail / dashboard style. Falls back to a placeholder
 *  if the arguments aren't valid JSON. */
function formatArgsContext(rawArgs: string | undefined): string {
  if (!rawArgs) return "";
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(parsed)) {
        let valStr: string;
        if (typeof v === "string") {
          valStr = v.length > 60 ? v.slice(0, 57) + "…" : v;
        } else if (v === null || typeof v === "number" || typeof v === "boolean") {
          valStr = String(v);
        } else {
          // Nested object/array — show a placeholder rather than dumping JSON.
          valStr = Array.isArray(v) ? `[${v.length}]` : "{…}";
        }
        parts.push(`${k}=${valStr}`);
      }
      return parts.join(", ");
    }
    return String(parsed);
  } catch {
    return "…";
  }
}

/** Heuristically classify a tool result string as success vs. error.
 *  Hermes's tool message format is a plain string (no structured status),
 *  so we look for common error prefixes/markers used by built-in tools. */
function classifyResult(content: string | null | undefined): {
  status: "done" | "error";
  summary?: string;
  error?: string;
} {
  if (content == null || content === "") return { status: "done" };
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const looksLikeError =
    lower.startsWith("error:") ||
    lower.startsWith("error ") ||
    lower.startsWith("traceback") ||
    lower.startsWith("exception:") ||
    /^[a-z_]*error: /i.test(lower);
  // Cap displayed text to avoid blowing up the bubble height with multi-MB results.
  const MAX = 4000;
  const truncated =
    trimmed.length > MAX ? trimmed.slice(0, MAX) + "\n…(truncated)" : trimmed;
  return looksLikeError
    ? { status: "error", error: truncated }
    : { status: "done", summary: truncated };
}

export function convertSessionMessages(
  raw: SessionMessage[],
): ConvertedThread {
  // Pre-scan: build tool_call_id → tool-result message for quick lookup.
  const toolResultsById = new Map<string, SessionMessage>();
  for (const m of raw) {
    if (m.role === "tool" && m.tool_call_id) {
      toolResultsById.set(m.tool_call_id, m);
    }
  }

  const messages: ThreadMessageLike[] = [];
  const toolsByMessageId = new Map<string, ToolEntry[]>();
  let counter = 0;

  for (const m of raw) {
    if (m.role !== "user" && m.role !== "assistant") continue;

    const text = (m.content ?? "").trim();
    const hasTools = m.role === "assistant" && !!m.tool_calls?.length;

    // Drop completely empty messages (no text AND no tool calls).
    if (!text && !hasTools) continue;

    const id = `hermes-msg-${counter++}`;
    messages.push({
      id,
      role: m.role,
      content: text
        ? [{ type: "text", text }]
        : // No text but has tools — emit a zero-width text part so the
          // bubble still renders with the tool entries below it.
          [{ type: "text", text: "" }],
    });

    if (hasTools) {
      const entries: ToolEntry[] = (m.tool_calls ?? []).map((tc) => {
        const result = toolResultsById.get(tc.id);
        const { status, summary, error } = classifyResult(result?.content);
        return {
          kind: "tool" as const,
          id: tc.id,
          tool_id: tc.id,
          name: tc.function?.name ?? "tool",
          context: formatArgsContext(tc.function?.arguments),
          summary,
          error,
          // Historical replay: timestamps unknown → ToolCall.tsx hides the
          // elapsed badge when startedAt === 0 (per its own comment).
          status,
          startedAt: 0,
        };
      });
      toolsByMessageId.set(id, entries);
    }
  }

  return { messages, toolsByMessageId };
}
