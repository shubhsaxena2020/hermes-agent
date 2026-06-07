/**
 * ChatWidgetPage — rich-render chat panel built on assistant-ui v0.14.
 *
 * v3 wires up the rest of the gateway surface:
 *   - reasoning / thinking panel (collapsible) above the streaming bubble
 *   - approval / clarify / sudo / secret modals (via ChatPromptModal)
 *   - mid-turn cancel via session.interrupt
 *   - auto-reconnect status surface in the composer
 *   - slash-command autocomplete (complete.slash) + slash.exec routing
 *   - image attachments via image.attach_bytes (with thumbnail preview)
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
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Paperclip,
  Send,
  X as XIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import { ChatPromptModal } from "@/components/chat/ChatPromptModal";
import { Markdown } from "@/components/Markdown";
import { ToolCall, type ToolEntry } from "@/components/ToolCall";
import { api, type SessionMessage } from "@/lib/api";
import {
  convertSessionMessages,
  type ConvertedThread,
} from "@/lib/chatMessageConverter";
import {
  useChatStreaming,
  type AttachmentMeta,
  type SlashCompletion,
} from "@/lib/useChatStreaming";

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

interface PendingAttachment {
  /** Local-only id used for keying the chip and remove-button. */
  localId: string;
  filename: string;
  /** Tiny preview src — the raw `data:image/...;base64,...` URL. */
  previewSrc: string;
  /** Server response from image.attach_bytes. */
  meta?: AttachmentMeta;
  /** True until the server upload completes. */
  uploading: boolean;
  /** Set if upload failed; the chip renders an X/retry indicator. */
  error?: string;
}

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
  const [localMessages, setLocalMessages] = useState<ThreadMessageLike[]>([]);
  const [localTools, setLocalTools] = useState<Map<string, ToolEntry[]>>(
    () => new Map(),
  );

  const streaming = useChatStreaming(sessionId ?? null);

  // ── load historic messages ─────────────────────────────────────────
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

  // ── commit completed streamed message into local history ───────────
  const prevStreamingRef = useRef(streaming.streamingMessage);
  useEffect(() => {
    const prev = prevStreamingRef.current;
    const curr = streaming.streamingMessage;
    prevStreamingRef.current = curr;
    if (!streaming.isStreaming && prev && curr && prev.id === curr.id) {
      const id = `local-asst-${Date.now()}`;
      const finalText = curr.text;
      const finalTools = curr.tools;
      setLocalMessages((prevMsgs) => [
        ...prevMsgs,
        {
          id,
          role: "assistant",
          content: finalText
            ? [{ type: "text", text: finalText }]
            : [{ type: "text", text: "" }],
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

  // ── merge sources for the displayed thread ─────────────────────────
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
              { type: "text", text: streaming.streamingMessage?.text ?? "" },
            ],
          },
        ]
      : [];
    return [...hist, ...localMessages, ...streamPreview];
  }, [state, localMessages, streaming.isStreaming, streaming.streamingMessage]);

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
    onNew: async () => {},
  });

  // ── composer + slash + attachments ─────────────────────────────────
  const [draft, setDraft] = useState("");
  const [slashItems, setSlashItems] = useState<SlashCompletion[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Connection state is what the composer keys off of for placeholder + disabled.
  const conn = streaming.connectionStatus;
  const sessionReady = !!sessionId && conn.kind === "ready";
  const composerLocked =
    !sessionReady ||
    streaming.isStreaming ||
    streaming.pendingPrompt !== null ||
    attachments.some((a) => a.uploading);
  const canSend =
    !composerLocked && (draft.trim().length > 0 || attachments.some((a) => a.meta));

  const composerPlaceholder = (() => {
    if (conn.kind === "connecting") return "Connecting to gateway…";
    if (conn.kind === "reconnecting")
      return `Reconnecting… (attempt ${conn.attempt})`;
    if (conn.kind === "failed") return "Disconnected.";
    if (streaming.pendingPrompt) return "Waiting on prompt above…";
    if (streaming.isStreaming) return "Streaming response…";
    return "Type a message — Enter to send, Shift+Enter for newline. / for commands.";
  })();

  // Slash-completion debounce.
  useEffect(() => {
    if (!sessionReady || !draft.startsWith("/")) {
      setSlashItems([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const items = await streaming.completeSlash(draft);
      if (!cancelled) setSlashItems(items);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [draft, sessionReady, streaming]);

  const submitDraft = useCallback(() => {
    const raw = draft;
    const text = raw.trim();
    if (!canSend) return;
    setDraft("");
    setSlashItems([]);

    // Slash command path — route through slash.exec, don't echo to thread.
    if (text.startsWith("/")) {
      streaming
        .runSlash(text)
        .catch((e: unknown) => {
          // Gateway slash errors (e.g. "use command.dispatch for /snapshot
          // restore") surface in the streaming.error banner; nothing to do
          // here.
          console.warn("slash.exec failed", e);
        });
      return;
    }

    // Build the user message. If we have attachments, the gateway has already
    // stashed them in the session — the agent will pick them up automatically
    // on the next turn. We prepend their human-readable text so the bubble
    // shows "[attached: foo.png]" too.
    const attachedTexts = attachments
      .filter((a) => a.meta?.text)
      .map((a) => a.meta!.text!);
    const combined = [text, ...attachedTexts].filter(Boolean).join("\n");

    setLocalMessages((prev) => [
      ...prev,
      {
        id: `local-user-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text: combined || text }],
      },
    ]);
    setAttachments([]);

    streaming.sendMessage(combined || text).catch(() => {
      // Already surfaced via streaming.error.
    });
  }, [draft, canSend, streaming, attachments]);

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitDraft();
    }
  };

  const pickSlash = (item: SlashCompletion) => {
    setDraft(item.text + " ");
    setSlashItems([]);
  };

  // ── attachments ────────────────────────────────────────────────────
  const onFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = ""; // allow re-selecting the same file
    for (const file of files) {
      const localId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Use FileReader to get a data: URL for both preview AND base64 upload.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
        r.onerror = () => reject(r.error ?? new Error("read failed"));
        r.readAsDataURL(file);
      }).catch(() => "");
      if (!dataUrl) continue;
      const pending: PendingAttachment = {
        localId,
        filename: file.name,
        previewSrc: dataUrl,
        uploading: true,
      };
      setAttachments((prev) => [...prev, pending]);
      try {
        const meta = await streaming.attachImageBytes(dataUrl, {
          filename: file.name,
        });
        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId ? { ...a, meta, uploading: false } : a,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? { ...a, uploading: false, error: msg }
              : a,
          ),
        );
      }
    }
  };

  const removeAttachment = (localId: string) =>
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));

  // ── reasoning panel toggle ─────────────────────────────────────────
  const [reasoningOpen, setReasoningOpen] = useState(false);
  // Auto-collapse when streaming ends to keep the thread tidy.
  useEffect(() => {
    if (!streaming.isStreaming) setReasoningOpen(false);
  }, [streaming.isStreaming]);

  return (
    <div className="relative flex h-full flex-col">
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
                  {/* Reasoning panel — sits below the streaming bubble, above the composer */}
                  {streaming.reasoningText && (
                    <ReasoningPanel
                      text={streaming.reasoningText}
                      open={reasoningOpen}
                      onToggle={() => setReasoningOpen((v) => !v)}
                      streaming={streaming.isStreaming}
                    />
                  )}
                </>
              )}
            </ThreadPrimitive.Viewport>

            {/* Composer */}
            {sessionId && (
              <div className="border-t border-border bg-background/40 p-3">
                {conn.kind === "failed" && (
                  <ConnectionFailedBanner
                    reason={conn.reason}
                    onRetry={streaming.manualRetry}
                  />
                )}
                {streaming.error && conn.kind !== "failed" && (
                  <div className="mb-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
                    {streaming.error}
                  </div>
                )}

                {/* Attachments strip */}
                {attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {attachments.map((a) => (
                      <AttachmentChip
                        key={a.localId}
                        a={a}
                        onRemove={() => removeAttachment(a.localId)}
                      />
                    ))}
                  </div>
                )}

                {/* Slash-completion popover */}
                {slashItems.length > 0 && (
                  <SlashPopover items={slashItems} onPick={pickSlash} />
                )}

                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={composerLocked}
                    aria-label="Attach image"
                    title="Attach image"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={onFileChange}
                    className="hidden"
                  />
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onComposerKey}
                    rows={1}
                    placeholder={composerPlaceholder}
                    disabled={composerLocked}
                    className="min-h-[2.25rem] max-h-40 flex-1 resize-y rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none disabled:opacity-60"
                  />
                  {streaming.isStreaming ? (
                    <button
                      type="button"
                      onClick={() => void streaming.cancelTurn()}
                      aria-label="Stop response"
                      title="Stop response"
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={submitDraft}
                      disabled={!canSend}
                      aria-label="Send message"
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary/15 text-foreground transition-colors hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            )}
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </ToolEntriesContext.Provider>

      {/* Modal for any pending interactive prompt */}
      {streaming.pendingPrompt && (
        <ChatPromptModal
          prompt={streaming.pendingPrompt}
          onSubmit={(answer) => void streaming.respondToPrompt(answer)}
          onApprovalChoice={(choice, all) =>
            void streaming.respondToApproval(choice, all)
          }
        />
      )}
    </div>
  );
}

/* ── small subcomponents kept local to this page ── */

function ReasoningPanel({
  text,
  open,
  onToggle,
  streaming,
}: {
  text: string;
  open: boolean;
  onToggle: () => void;
  streaming: boolean;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="rounded-md border border-border bg-muted/20 text-xs">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/40"
      >
        <Chevron className="h-3 w-3 text-muted-foreground" />
        <Brain className="h-3 w-3 text-primary" />
        <span className="font-medium text-foreground">
          {streaming ? "Thinking…" : "Reasoning"}
        </span>
        <span className="ml-auto text-muted-foreground">
          {text.length} chars
        </span>
      </button>
      {open && (
        <div className="max-h-60 overflow-y-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function ConnectionFailedBanner({
  reason,
  onRetry,
}: {
  reason: string;
  onRetry: () => void;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
      <span>{reason}</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-destructive/40 px-2 py-0.5 text-xs hover:bg-destructive/10"
      >
        Retry
      </button>
    </div>
  );
}

function SlashPopover({
  items,
  onPick,
}: {
  items: SlashCompletion[];
  onPick: (item: SlashCompletion) => void;
}) {
  return (
    <div className="mb-2 max-h-48 overflow-y-auto rounded-md border border-border bg-card text-xs shadow">
      {items.map((item) => (
        <button
          key={item.text}
          type="button"
          onClick={() => onPick(item)}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-muted/40"
        >
          <span className="font-mono text-foreground">{item.display}</span>
          {item.meta && (
            <span className="ml-auto text-muted-foreground">{item.meta}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function AttachmentChip({
  a,
  onRemove,
}: {
  a: PendingAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="group relative inline-flex items-center gap-2 rounded-md border border-border bg-muted/30 p-1 pr-2 text-xs">
      <img
        src={a.previewSrc}
        alt={a.filename}
        className="h-8 w-8 rounded object-cover"
      />
      <span className="max-w-[10rem] truncate text-foreground">
        {a.filename}
      </span>
      {a.uploading && (
        <span className="text-muted-foreground">uploading…</span>
      )}
      {a.error && (
        <span className="text-destructive" title={a.error}>
          failed
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove attachment"
        className="rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
}
