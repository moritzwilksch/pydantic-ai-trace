import { Check, Copy, TriangleAlert } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { formatTraceAsText } from "../formatTrace";
import type { Message } from "../types";

type CopyState = "idle" | "copied" | "error";

export function CopyTraceButton({ messages, name }: { messages: Message[]; name: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copyTrace() {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(formatTraceAsText(messages, name));
      setState("copied");
    } catch {
      setState("error");
    }
    resetTimer.current = setTimeout(() => setState("idle"), 2_000);
  }

  const label = state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy trace";
  const title = state === "error" ? "Could not copy trace" : "Copy trace as structured plain text";

  return (
    <button class="icon-button copy-trace-button" title={title} onClick={copyTrace}>
      {state === "copied" ? (
        <Check size={14} />
      ) : state === "error" ? (
        <TriangleAlert size={14} />
      ) : (
        <Copy size={14} />
      )}
      <span aria-live="polite">{label}</span>
    </button>
  );
}
