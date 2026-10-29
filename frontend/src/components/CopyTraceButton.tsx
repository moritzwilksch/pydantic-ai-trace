import { Check, Copy, TriangleAlert } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Hint } from "./Hint";
import { Button } from "./ui/button";

type CopyState = "idle" | "copied" | "error";

export function CopyTraceButton({ text }: { text: string }) {
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
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("error");
    }
    resetTimer.current = setTimeout(() => setState("idle"), 2_000);
  }

  const label = state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy trace";
  const title = state === "error" ? "Could not copy trace" : "Copy trace as structured plain text";

  return (
    <Hint label={title}>
      <Button variant="outline" size="sm" onClick={() => void copyTrace()}>
        {state === "copied" ? <Check /> : state === "error" ? <TriangleAlert /> : <Copy />}
        {/* A narrow header hides the label visually only: it stays the name and live region. */}
        <span class="@max-[640px]/main:sr-only" aria-live="polite">
          {label}
        </span>
      </Button>
    </Hint>
  );
}
