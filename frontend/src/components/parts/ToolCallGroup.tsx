import { Check, PackageCheck, SquarePlay, Wrench } from "lucide-preact";
import { compactJson, markdownPreview } from "../../format";
import type { RunEntry, RunIndex } from "../../runIndex";
import {
  CAPABILITY_LOAD_KIND,
  TOOL_SEARCH_KIND,
  type AnyToolCallPart,
  type AnyToolReturnPart,
  type LoadCapabilityReturn,
  type Part,
  type PartRef,
  type ToolSearchReturnContent,
} from "../../types";
import { Block, MoreHint } from "../Block";
import { ChildRunCard } from "../ChildRunCard";
import { focusPart } from "../KeyboardNav";
import { ToolReturnValue, ValueView } from "./common";

/** The call a tool return or retry prompt answers, as its header shows it. */
export interface CallLink {
  number: number;
  ref: PartRef;
  argsPreview: string;
  /** The call is the run's accepted output call; see `ToolCallInfo.is_output`. */
  isOutput: boolean;
}

export function pairedCall(run: RunIndex, message: number, part: number): CallLink | null {
  const call = run.resultOf(message, part);
  if (call === undefined) return null;
  const callPart = run.part(call.info.call) as AnyToolCallPart;
  return {
    number: call.number,
    ref: call.info.call,
    argsPreview: callPreview(callPart, call.info.args),
    isOutput: call.info.is_output,
  };
}

/**
 * A tool call annotated with its number, a link to its paired return/retry and
 * that result's status, and the runs it started. The result itself remains in
 * its original message so the trace mirrors the source JSON.
 */
export function ToolCallGroup({
  part,
  number,
  args,
  result,
  childRuns,
  onOpenRun,
}: {
  part: AnyToolCallPart;
  /** 1-based position among the run's tool calls; the paired result shows the same number. */
  number: number;
  /** The call's arguments, parsed from a JSON string where possible. */
  args: unknown;
  result: { ref: PartRef; part: Part } | null;
  childRuns: RunEntry[];
  onOpenRun: (runId: string) => void;
}) {
  const argsPreview = callPreview(part, args);
  return (
    <details class="content-block tone-tool tool-group">
      <summary>
        <span class="block-label">
          <Wrench size={13} /> Tool call
        </span>
        <ToolSignature name={part.tool_name} args={argsPreview} />
        {part.part_kind === "builtin-tool-call" ? <span class="badge">builtin</span> : null}
        {part.tool_kind ? <span class="badge">{part.tool_kind}</span> : null}
        {result !== null ? <ResultBadge result={result.part} /> : null}
        <MoreHint text={argsPreview} />
        <span class="pair-end">
          {childRuns.map((child) => (
            <ChildRunLink key={child.run.id} entry={child} onOpen={onOpenRun} />
          ))}
          {result === null ? <span class="pair-missing">no return recorded</span> : null}
          <PairNumber
            number={number}
            to={result?.ref ?? null}
            label={`Jump to result of call #${number}`}
          />
        </span>
      </summary>
      <div class="tool-group-section">
        <div class="part-label">arguments</div>
        <ToolCallArgs part={part} args={args} />
      </div>
      <StartedRuns childRuns={childRuns} onOpenRun={onOpenRun} />
    </details>
  );
}

/**
 * The output tool call Pydantic AI accepted: its arguments are the run's structured
 * output, so they show open, as the answer rather than as a tool invocation. It keeps
 * its call number, linking to the acceptance, so the run's numbering has no gaps.
 */
export function OutputCall({
  part,
  number,
  result,
  args,
  childRuns,
  onOpenRun,
}: {
  part: AnyToolCallPart;
  number: number;
  result: PartRef | null;
  args: unknown;
  childRuns: RunEntry[];
  onOpenRun: (runId: string) => void;
}) {
  return (
    <Block
      label={
        <>
          <PackageCheck size={13} /> Output
        </>
      }
      tone="assistant"
      badges={<span class="tool-name">{part.tool_name}</span>}
      preview={compactJson(args)}
      trailing={
        <span class="pair-end">
          <PairNumber number={number} to={result} label={`Jump to result of call #${number}`} />
        </span>
      }
      defaultOpen
    >
      <ValueView value={args} />
      <StartedRuns childRuns={childRuns} onOpenRun={onOpenRun} />
    </Block>
  );
}

/** Pydantic AI's fixed status return for the accepted output call; boilerplate, so muted. */
export function OutputAccepted({ part, call }: { part: AnyToolReturnPart; call: CallLink }) {
  return (
    <div class="output-accepted" title={compactJson(part.content)}>
      <Check size={13} /> Output accepted <span class="tool-name">{part.tool_name}</span>
      <CallEnd call={call} />
    </div>
  );
}

function StartedRuns({
  childRuns,
  onOpenRun,
}: {
  childRuns: RunEntry[];
  onOpenRun: (runId: string) => void;
}) {
  if (childRuns.length === 0) return null;
  return (
    <div class="tool-group-section">
      <div class="part-label">started</div>
      {childRuns.map((child) => (
        <ChildRunCard key={child.run.id} entry={child} onOpen={onOpenRun} />
      ))}
    </div>
  );
}

/** Names a started run in the collapsed header and opens it without toggling the call. */
function ChildRunLink({ entry, onOpen }: { entry: RunEntry; onOpen: (runId: string) => void }) {
  const { run } = entry;
  return (
    <button
      type="button"
      class="pair-link child-run-link"
      title={`Open run ${run.name}`}
      onClick={(event) => {
        event.preventDefault(); // a click inside <summary> would also toggle the call
        event.stopPropagation();
        onOpen(run.id);
      }}
    >
      → <span class="child-run-link-name">{run.name}</span>
      {run.outcome.status !== "completed" ? ` ${run.outcome.status}` : null}
    </button>
  );
}

/** A tool return rendered in its original message position. */
export function ToolReturn({ part, call }: { part: AnyToolReturnPart; call: CallLink | null }) {
  const preview = returnPreview(part);
  return (
    <Block
      label={
        <>
          <SquarePlay size={13} /> Tool return
        </>
      }
      tone="tool"
      badges={
        <>
          <ToolSignature name={part.tool_name} args={call?.argsPreview ?? null} />
          {part.tool_kind ? <span class="badge">{part.tool_kind}</span> : null}
          {preview ? <span class="pair-arrow">→</span> : null}
        </>
      }
      preview={preview}
      trailing={<CallEnd call={call} />}
    >
      <ToolReturnContent part={part} />
    </Block>
  );
}

/**
 * `name(args)`: a tool's name with its call's argument summary, shown on the call
 * and on its result. `args` is null when the call is unknown.
 */
export function ToolSignature({ name, args }: { name: string; args: string | null }) {
  return (
    <span class="tool-signature">
      <span class="tool-name">{name}</span>
      {args !== null ? <span class="tool-args">({args})</span> : null}
    </span>
  );
}

/** The right edge of a result header: its call's number as a link, or an unpaired mark. */
export function CallEnd({ call }: { call: CallLink | null }) {
  return (
    <span class="pair-end">
      {call === null ? (
        <span class="pair-missing">no matching call</span>
      ) : (
        <PairNumber number={call.number} to={call.ref} label={`Jump to call #${call.number}`} />
      )}
    </span>
  );
}

/** A call's number; a link to the other end of the pair when that end exists. */
function PairNumber({ number, to, label }: { number: number; to: PartRef | null; label: string }) {
  if (to === null) return <span class="pair-number">#{number}</span>;
  return (
    <button
      type="button"
      class="pair-number pair-link"
      aria-label={label}
      title={label}
      onClick={(event) => {
        // The link sits in a <summary>; jumping must not also toggle the block.
        event.preventDefault();
        focusPart(to);
      }}
    >
      #{number}
    </button>
  );
}

/**
 * Framework-emitted tool parts (tool search, capability loading) keep the plain
 * `tool-call` / `tool-return` discriminator and carry a typed `args` / `content`
 * payload instead; rendering that payload beats dumping its JSON. Anything whose
 * shape does not match — including a user tool that shares the name — falls
 * through to the generic rendering.
 */
function ToolCallArgs({ part, args }: { part: AnyToolCallPart; args: unknown }) {
  const queries = searchQueries(part, args);
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
  const capability = capabilityId(part, args);
  if (capability !== null) return <span class="tool-chip">{capability}</span>;
  return <ValueView value={args} />;
}

function ToolReturnContent({ part }: { part: AnyToolReturnPart }) {
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

function callPreview(part: AnyToolCallPart, args: unknown): string {
  const queries = searchQueries(part, args);
  if (queries !== null) return queries.join(", ");
  const capability = capabilityId(part, args);
  if (capability !== null) return capability;
  return args != null ? compactJson(args) : "";
}

function returnPreview(part: AnyToolReturnPart): string {
  const search = toolSearchContent(part);
  if (search !== null) {
    const discovered = discoveredTools(search);
    return discovered.length > 0 ? discovered.join(", ") : (search.message ?? "no matches");
  }
  const instructions = capabilityInstructions(part);
  if (instructions !== null) return markdownPreview(instructions);
  return compactJson(part.content);
}

/** Search queries of a tool-search call, or null when this is not one. */
function searchQueries(part: AnyToolCallPart, args: unknown): string[] | null {
  if (part.tool_kind !== TOOL_SEARCH_KIND || !isRecord(args)) return null;
  const queries = args.queries;
  if (!Array.isArray(queries)) return null;
  return queries.filter((query) => typeof query === "string");
}

/** The typed payload of a tool-search return, or null when the part is not one. */
function toolSearchContent(part: AnyToolReturnPart): ToolSearchReturnContent | null {
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

function capabilityId(part: AnyToolCallPart, args: unknown): string | null {
  if (part.tool_kind !== CAPABILITY_LOAD_KIND || !isRecord(args)) return null;
  const id = args.id;
  return typeof id === "string" ? id : null;
}

function capabilityInstructions(part: AnyToolReturnPart): string | null {
  if (part.tool_kind !== CAPABILITY_LOAD_KIND || !isRecord(part.content)) return null;
  const instructions = (part.content as unknown as LoadCapabilityReturn).instructions;
  return typeof instructions === "string" ? instructions : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only problems are badged — success is the unremarkable default. */
function ResultBadge({ result }: { result: Part }) {
  if (result.part_kind === "retry-prompt") return <span class="badge error">retry</span>;
  const outcome = "outcome" in result ? result.outcome : undefined;
  if (outcome === "failed" || outcome === "denied") {
    return <span class="badge error">{outcome}</span>;
  }
  return null;
}
