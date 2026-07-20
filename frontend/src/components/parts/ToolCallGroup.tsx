import { Wrench } from "lucide-preact";
import { compactJson } from "../../parse";
import type { ToolResult } from "../../pairing";
import type { ToolCallPart, ToolReturnPart } from "../../types";
import { Block } from "../Block";
import { ToolReturnValue, ValueView } from "./common";

/**
 * A tool call annotated with the status of its paired return/retry. The result
 * itself remains in its original message so the trace mirrors the source JSON.
 */
export function ToolCallGroup({ part, result }: { part: ToolCallPart; result: ToolResult | null }) {
  const argsPreview = part.parsedArgs != null ? compactJson(part.parsedArgs) : "";
  const hasTruncatedPreview = argsPreview.length > 96 || argsPreview.endsWith("…");
  return (
    <details class="content-block tone-tool tool-group">
      <summary aria-label={hasTruncatedPreview ? "Expand to view full tool arguments" : undefined}>
        <span class="block-label">
          <Wrench size={13} /> Tool call
        </span>
        <span class="tool-name">{part.tool_name}</span>
        {part.part_kind === "builtin-tool-call" ? <span class="badge">builtin</span> : null}
        {part.tool_kind ? <span class="badge">{part.tool_kind}</span> : null}
        <ResultBadge result={result} />
        {argsPreview ? (
          <span
            class="block-preview"
            title={hasTruncatedPreview ? "Expand to view full tool arguments" : argsPreview}
          >
            {argsPreview}
          </span>
        ) : null}
        {hasTruncatedPreview ? (
          <span class="preview-more" title="Expand to view full tool arguments">
            more
          </span>
        ) : null}
      </summary>
      <div class="tool-group-section">
        <div class="part-label">arguments</div>
        <ValueView value={part.parsedArgs ?? null} />
      </div>
    </details>
  );
}

/** A tool return rendered in its original message position. */
export function ToolReturn({
  part,
  hasMatchingCall,
}: {
  part: ToolReturnPart;
  hasMatchingCall: boolean;
}) {
  return (
    <Block
      label={
        <>
          <Wrench size={13} /> Tool return
        </>
      }
      tone="tool"
      badges={
        <>
          <span class="tool-name">{part.tool_name}</span>
          {!hasMatchingCall ? <span class="badge warn">no matching call</span> : null}
        </>
      }
      preview={compactJson(part.content)}
    >
      <ToolReturnValue content={part.content} />
    </Block>
  );
}

/** Only problems are badged — success is the unremarkable default. */
function ResultBadge({ result }: { result: ToolResult | null }) {
  if (result === null) return <span class="badge warn">no return recorded</span>;
  if (result.kind === "retry") return <span class="badge error">retry</span>;
  const outcome = (result.part as ToolReturnPart).outcome;
  if (outcome === "failed" || outcome === "denied") {
    return <span class="badge error">{outcome}</span>;
  }
  return null;
}
