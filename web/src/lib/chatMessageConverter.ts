/**
 * Convert Hermes session messages (from /api/sessions/{id}/messages) into
 * assistant-ui's ThreadMessageLike format.
 *
 * Scope (read-only history rendering — chunk 2):
 *   - user / assistant text messages → rendered
 *   - system messages → dropped (not user-visible chrome for now)
 *   - tool role messages → dropped (tool results; deferred to streaming chunk)
 *   - assistant.tool_calls → currently rendered as a short text annotation;
 *     proper inline <ToolCall> rendering is deferred to the streaming chunk
 *
 * The converter is pure so it can be unit-tested without React, and shared
 * between the read-only history loader and (eventually) the streaming
 * adapter that appends new messages as they arrive.
 */

import type { ThreadMessageLike } from "@assistant-ui/react";

import type { SessionMessage } from "@/lib/api";

/** Best-effort summary of an assistant tool_calls entry — placeholder until
 *  we wire the real <ToolCall> component into the assistant-ui Tool part. */
function summarizeToolCalls(
  toolCalls: NonNullable<SessionMessage["tool_calls"]>,
): string {
  return toolCalls
    .map((tc) => {
      const name = tc.function?.name ?? "tool";
      // Try to render a one-line arg summary without pretty-printing huge blobs.
      let argSummary = "";
      try {
        const parsed = JSON.parse(tc.function?.arguments ?? "{}");
        const keys = Object.keys(parsed);
        argSummary = keys.length ? `(${keys.join(", ")})` : "()";
      } catch {
        argSummary = "(…)";
      }
      return `\`${name}${argSummary}\``;
    })
    .join(" · ");
}

/**
 * Convert a Hermes SessionMessage[] into assistant-ui ThreadMessageLike[].
 * Returns only renderable user/assistant messages. Non-renderable rows
 * (system, tool-result, empty content) are filtered out.
 */
export function convertSessionMessages(
  raw: SessionMessage[],
): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];

  for (const m of raw) {
    if (m.role !== "user" && m.role !== "assistant") continue;

    const text = m.content ?? "";
    const toolCallsAnnotation =
      m.role === "assistant" && m.tool_calls?.length
        ? `\n\n_Used:_ ${summarizeToolCalls(m.tool_calls)}`
        : "";

    const combined = (text + toolCallsAnnotation).trim();
    if (!combined) continue; // Drop completely empty rows.

    out.push({
      role: m.role,
      content: [{ type: "text", text: combined }],
    });
  }

  return out;
}
