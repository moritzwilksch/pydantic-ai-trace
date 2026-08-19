import { Wrench } from "lucide-preact";
import { compactJson } from "../../parse";
import type { ToolResult } from "../../pairing";
import {
  CAPABILITY_LOAD_KIND,
  TOOL_SEARCH_KIND,
  type LoadCapabilityReturn,
  type ToolCallPart,
  type ToolReturnPart,
  type ToolSearchArgs,
  type ToolSearchReturnContent,
} from "../../types";
import { Block } from "../Block";
import { ToolReturnValue, ValueView } from "./common";

/**
 * A tool call annotated with the status of its paired return/retry. The result
 * itself remains in its original message so the trace mirrors the source JSON.
 */
export function ToolCallGroup({ part, result }: { part: ToolCallPart; result: ToolResult | null }) {
  const argsPreview = callPreview(part);
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
        <ToolCallArgs part={part} />
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
          {part.tool_kind ? <span class="badge">{part.tool_kind}</span> : null}
          {!hasMatchingCall ? <span class="badge warn">no matching call</span> : null}
        </>
      }
      preview={returnPreview(part)}
    >
      <ToolReturnContent part={part} />
    </Block>
  );
}

/**
 * Framework-emitted tool parts (tool search, capability loading) keep the plain
 * `tool-call` / `tool-return` discriminator and carry a typed `args` / `content`
 * payload instead; rendering that payload beats dumping its JSON. Anything whose
 * shape does not match — including a user tool that shares the name — falls
 * through to the generic rendering.
 */
function ToolCallArgs({ part }: { part: ToolCallPart }) {
  const queries = searchQueries(part);
  if (queries !== null) {
    return (
      <div class="tool-chips">
        {queries.map((query, i) => (
          <span class="tool-chip" key={i}>
            {query}
          </span>
        ))}
      </div>
    );
  }
  const capability = capabilityId(part);
  if (capability !== null) return <span class="tool-chip">{capability}</span>;
  return <ValueView value={part.parsedArgs ?? null} />;
}

function ToolReturnContent({ part }: { part: ToolReturnPart }) {
  const search = toolSearchContent(part);
  if (search !== null) {
    const discovered = discoveredTools(search);
    return (
      <div>
        {discovered.length > 0 ? (
          <div class="tool-chips">
            {discovered.map((name) => (
              <span class="tool-chip" key={name}>
                {name}
              </span>
            ))}
          </div>
        ) : null}
        {search.message ? <ValueView value={search.message} /> : null}
      </div>
    );
  }
  const instructions = capabilityInstructions(part);
  if (instructions !== null) return <ValueView value={instructions} markdown />;
  return <ToolReturnValue content={part.content} />;
}

function callPreview(part: ToolCallPart): string {
  const queries = searchQueries(part);
  if (queries !== null) return queries.join(", ");
  const capability = capabilityId(part);
  if (capability !== null) return capability;
  return part.parsedArgs != null ? compactJson(part.parsedArgs) : "";
}

function returnPreview(part: ToolReturnPart): string {
  const search = toolSearchContent(part);
  if (search !== null) {
    const discovered = discoveredTools(search);
    return discovered.length > 0 ? discovered.join(", ") : (search.message ?? "no matches");
  }
  const instructions = capabilityInstructions(part);
  if (instructions !== null) return instructions;
  return compactJson(part.content);
}

/** Search queries of a tool-search call, or null when this is not one. */
function searchQueries(part: ToolCallPart): string[] | null {
  if (part.tool_kind !== TOOL_SEARCH_KIND || !isRecord(part.parsedArgs)) return null;
  const queries = (part.parsedArgs as unknown as ToolSearchArgs).queries;
  if (!Array.isArray(queries)) return null;
  return queries.filter((query) => typeof query === "string");
}

/** The typed payload of a tool-search return, or null when the part is not one. */
function toolSearchContent(part: ToolReturnPart): ToolSearchReturnContent | null {
  if (part.tool_kind !== TOOL_SEARCH_KIND || !isRecord(part.content)) return null;
  const content = part.content as unknown as ToolSearchReturnContent;
  return Array.isArray(content.discovered_tools) ? content : null;
}

/** Names of the tools a tool-search return revealed. */
function discoveredTools(content: ToolSearchReturnContent): string[] {
  return content.discovered_tools
    .map((match) => (isRecord(match) ? match.name : undefined))
    .filter((name): name is string => typeof name === "string");
}

function capabilityId(part: ToolCallPart): string | null {
  if (part.tool_kind !== CAPABILITY_LOAD_KIND || !isRecord(part.parsedArgs)) return null;
  const id = part.parsedArgs.id;
  return typeof id === "string" ? id : null;
}

function capabilityInstructions(part: ToolReturnPart): string | null {
  if (part.tool_kind !== CAPABILITY_LOAD_KIND || !isRecord(part.content)) return null;
  const instructions = (part.content as LoadCapabilityReturn).instructions;
  return typeof instructions === "string" ? instructions : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
