import { Wrench } from "lucide-preact";
import { compactJson } from "../../parse";
import type { ToolResult } from "../../pairing";
import type { RetryPromptPart, ToolCallPart, ToolReturnPart } from "../../types";
import { Block } from "../Block";
import { RetryContent } from "./RetryPrompt";
import { ToolReturnValue, ValueView } from "./common";

/**
 * A tool call with its paired return/retry rendered inline. Collapsed by
 * default with a compact args preview in the summary — skimming a trace reads
 * like "the agent ran tool X with these args". Expanding always shows the
 * full arguments; the (often bulky) result stays behind its own toggle.
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
      {result === null ? null : (
        <div class="tool-group-section">
          {result.kind === "return" ? (
            <Block label="result" preview={compactJson((result.part as ToolReturnPart).content)}>
              <ToolReturnValue content={(result.part as ToolReturnPart).content} />
            </Block>
          ) : (
            <Block label="retry" tone="error" defaultOpen>
              <RetryContent content={(result.part as RetryPromptPart).content} />
            </Block>
          )}
        </div>
      )}
    </details>
  );
}

/** A tool return whose call is not in the trace — shown standalone. */
export function OrphanToolReturn({ part }: { part: ToolReturnPart }) {
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
          <span class="badge warn">no matching call</span>
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
