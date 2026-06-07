/**
 * ChatPromptModal — renders the in-flight pending prompt from useChatStreaming.
 *
 * One component handles all four prompt types the gateway emits mid-turn:
 *   - approval.request   → Allow / Allow-always / Deny (resolves via approval.respond)
 *   - clarify.request    → free-text answer (clarify.respond)
 *   - sudo.request       → masked password (sudo.respond)
 *   - secret.request     → masked secret input (secret.respond)
 *
 * The widget's composer is disabled while a pending prompt is open — the
 * agent thread blocks on the answer, so trying to submit another message
 * would be a no-op anyway.
 */

import { ShieldAlert, KeySquare, MessageSquare, Lock } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { PendingPrompt } from "@/lib/useChatStreaming";

export interface ChatPromptModalProps {
  prompt: PendingPrompt;
  onSubmit: (answer: string) => void;
  /** Used by approval prompts only. */
  onApprovalChoice: (choice: "allow" | "deny", all?: boolean) => void;
}

const META: Record<
  PendingPrompt["kind"],
  { title: string; Icon: typeof ShieldAlert; tone: string }
> = {
  approval: { title: "Approval required", Icon: ShieldAlert, tone: "border-warning/50" },
  clarify: { title: "Agent needs clarification", Icon: MessageSquare, tone: "border-primary/40" },
  sudo: { title: "Sudo password needed", Icon: Lock, tone: "border-warning/50" },
  secret: { title: "Secret value needed", Icon: KeySquare, tone: "border-primary/40" },
};

export function ChatPromptModal({ prompt, onSubmit, onApprovalChoice }: ChatPromptModalProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { title, Icon, tone } = META[prompt.kind];

  useEffect(() => {
    setValue("");
    // Focus the input once the modal mounts so the user can type immediately.
    inputRef.current?.focus();
  }, [prompt]);

  const submit = () => {
    if (prompt.kind === "approval") return;
    if (!value.trim() && prompt.kind === "clarify") return;
    onSubmit(value);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && prompt.kind === "approval") {
      e.preventDefault();
      onApprovalChoice("deny");
    }
  };

  const masked = prompt.kind === "sudo" || prompt.kind === "secret";

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-prompt-modal-title"
    >
      <div
        className={`flex w-full max-w-md flex-col gap-3 rounded-lg border ${tone} bg-card p-4 shadow-xl`}
      >
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-foreground" aria-hidden />
          <h2
            id="chat-prompt-modal-title"
            className="text-sm font-semibold text-foreground"
          >
            {title}
          </h2>
        </div>

        {prompt.kind === "approval" && (
          <ApprovalBody
            payload={prompt.payload}
            onChoice={onApprovalChoice}
          />
        )}

        {prompt.kind === "clarify" && (
          <ClarifyBody
            payload={prompt.payload}
            value={value}
            setValue={setValue}
            inputRef={inputRef}
            onKey={onKey}
            onSubmit={submit}
          />
        )}

        {(prompt.kind === "sudo" || prompt.kind === "secret") && (
          <SecretBody
            kind={prompt.kind}
            payload={prompt.payload}
            value={value}
            setValue={setValue}
            inputRef={inputRef}
            onKey={onKey}
            onSubmit={submit}
            masked={masked}
          />
        )}
      </div>
    </div>
  );
}

function ApprovalBody({
  payload,
  onChoice,
}: {
  payload: Extract<PendingPrompt, { kind: "approval" }>["payload"];
  onChoice: (choice: "allow" | "deny", all?: boolean) => void;
}) {
  return (
    <>
      {payload.description && (
        <p className="text-sm text-muted-foreground">{payload.description}</p>
      )}
      {payload.command && (
        <pre className="max-h-40 overflow-auto rounded border border-border bg-background/60 p-2 font-mono text-xs text-foreground">
          {payload.command}
        </pre>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => onChoice("allow", false)}
          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/15 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/25"
        >
          Allow once
        </button>
        <button
          type="button"
          onClick={() => onChoice("allow", true)}
          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-foreground hover:bg-primary/20"
        >
          Allow always
        </button>
        <button
          type="button"
          onClick={() => onChoice("deny", false)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/20"
        >
          Deny
        </button>
      </div>
    </>
  );
}

function ClarifyBody({
  payload,
  value,
  setValue,
  inputRef,
  onKey,
  onSubmit,
}: {
  payload: Extract<PendingPrompt, { kind: "clarify" }>["payload"];
  value: string;
  setValue: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
}) {
  return (
    <>
      {payload.question && (
        <p className="text-sm text-foreground">{payload.question}</p>
      )}
      {payload.choices && payload.choices.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {payload.choices.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        placeholder="Type your answer…"
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary/60 focus:outline-none"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!value.trim()}
        className="self-end rounded-md border border-primary/40 bg-primary/15 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/25 disabled:opacity-40"
      >
        Submit
      </button>
    </>
  );
}

function SecretBody({
  kind,
  payload,
  value,
  setValue,
  inputRef,
  onKey,
  onSubmit,
  masked,
}: {
  kind: "sudo" | "secret";
  payload: Record<string, unknown>;
  value: string;
  setValue: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
  masked: boolean;
}) {
  const promptText =
    kind === "sudo"
      ? "Hermes needs your sudo password to run a privileged command."
      : (payload.prompt as string | undefined) ?? "Provide the requested secret.";
  const envVar = payload.env_var as string | undefined;
  return (
    <>
      <p className="text-sm text-foreground">{promptText}</p>
      {envVar && (
        <p className="text-xs text-muted-foreground">
          Stored as <code className="font-mono">{envVar}</code>
        </p>
      )}
      <input
        ref={inputRef}
        type={masked ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        autoComplete="off"
        placeholder={kind === "sudo" ? "sudo password" : "secret value"}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary/60 focus:outline-none"
      />
      <button
        type="button"
        onClick={onSubmit}
        className="self-end rounded-md border border-primary/40 bg-primary/15 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/25"
      >
        Send
      </button>
    </>
  );
}
