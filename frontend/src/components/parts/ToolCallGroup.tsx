import { Check, PackageCheck, SquarePlay, Wrench } from "lucide-preact";
import type { ComponentChildren } from "preact";
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
import { Block, BlockSummary, blockClass, MoreHint } from "../Block";
import { ChildRunCard } from "../ChildRunCard";
import { focusPart } from "../KeyboardNav";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ToolReturnValue, ValueView } from "./common";

const TOOL_NAME_CLASS = "tool-name font-mono text-xs font-semibold text-tool";
export const PAIR_ARROW_CLASS = "pair-arrow shrink-0 text-muted-foreground";
/** Named values a tool part carries as structure rather than free-form JSON:
    search queries, discovered tools, revealed tool names. */
export const CHIPS_CLASS = "flex flex-wrap gap-1.5";
/** The call's number (a link to the other end of the pair) at the header's right edge. */
const PAIR_END_CLASS = "ml-auto inline-flex shrink-0 gap-2 text-[11px] text-muted-foreground";
/** Header links: inline text sized like the header around them. */
const PAIR_LINK_CLASS =
  "pair-link h-auto p-0 text-[11px] font-normal text-inherit sm:h-auto sm:text-[11px]";
const SECTION_CLASS = "border-t px-2.5 py-2";
const SECTION_LABEL_CLASS = "mb-1.5 text-[11px] font-semibold text-muted-foreground";

export function ToolChip({ children }: { children: ComponentChildren }) {
  return (
    <Badge variant="secondary" className="tool-chip font-mono font-normal text-tool">
      {children}
    </Badge>
  );
}

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
    <details class={blockClass("tool", "tool-group")}>
      <BlockSummary
        tone="tool"
        label={
          <>
            <Wrench size={13} /> Tool call
          </>
        }
      >
        <ToolSignature name={part.tool_name} args={argsPreview} />
        {part.part_kind === "builtin-tool-call" ? <Badge variant="outline">builtin</Badge> : null}
        {part.tool_kind ? <Badge variant="outline">{part.tool_kind}</Badge> : null}
        {result !== null ? <ResultBadge result={result.part} /> : null}
        <MoreHint text={argsPreview} />
        <span class={PAIR_END_CLASS}>
          {childRuns.map((child) => (
            <ChildRunLink key={child.run.id} entry={child} onOpen={onOpenRun} />
          ))}
          {result === null ? <span>no return recorded</span> : null}
          <PairNumber
            number={number}
            to={result?.ref ?? null}
            label={`Jump to result of call #${number}`}
          />
        </span>
      </BlockSummary>
      <div class={SECTION_CLASS}>
        <div class={SECTION_LABEL_CLASS}>arguments</div>
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
      badges={<span class={TOOL_NAME_CLASS}>{part.tool_name}</span>}
      preview={compactJson(args)}
      trailing={
        <span class={PAIR_END_CLASS}>
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
    <div
      class="output-accepted flex items-center gap-1.5 px-2.5 py-0.5 text-xs text-muted-foreground"
      title={compactJson(part.content)}
    >
      <Check size={13} /> Output accepted{" "}
      <span class="tool-name font-mono text-xs font-medium">{part.tool_name}</span>
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
    <div class={SECTION_CLASS}>
      <div class={SECTION_LABEL_CLASS}>started</div>
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
    <Button
      variant="link"
      size="xs"
      className={`${PAIR_LINK_CLASS} max-w-[28ch] gap-[0.5ch]`}
      title={`Open run ${run.name}`}
      onClick={(event) => {
        event.preventDefault(); // a click inside <summary> would also toggle the call
        event.stopPropagation();
        onOpen(run.id);
      }}
    >
      → <span class="truncate font-mono">{run.name}</span>
      {run.outcome.status !== "completed" ? ` ${run.outcome.status}` : null}
    </Button>
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
          {part.tool_kind ? <Badge variant="outline">{part.tool_kind}</Badge> : null}
          {preview ? <span class={PAIR_ARROW_CLASS}>→</span> : null}
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
    <span class="tool-signature inline-flex min-w-0 font-mono text-xs">
      <span class={`${TOOL_NAME_CLASS} shrink-0`}>{name}</span>
      {args !== null ? <span class="min-w-0 truncate text-muted-foreground">({args})</span> : null}
    </span>
  );
}

/** The right edge of a result header: its call's number as a link, or an unpaired mark. */
export function CallEnd({ call }: { call: CallLink | null }) {
  return (
    <span class={PAIR_END_CLASS}>
      {call === null ? (
        <span>no matching call</span>
      ) : (
        <PairNumber number={call.number} to={call.ref} label={`Jump to call #${call.number}`} />
      )}
    </span>
  );
}

/** A call's number; a link to the other end of the pair when that end exists. */
function PairNumber({ number, to, label }: { number: number; to: PartRef | null; label: string }) {
  if (to === null) return <span class="pair-number font-mono">#{number}</span>;
  return (
    <Button
      variant="link"
      size="xs"
      className={`pair-number ${PAIR_LINK_CLASS} font-mono`}
      aria-label={label}
      title={label}
      onClick={(event) => {
        // The link sits in a <summary>; jumping must not also toggle the block.
        event.preventDefault();
        focusPart(to);
      }}
    >
      #{number}
    </Button>
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
      <div class={CHIPS_CLASS}>
        {queries.map((query, i) => (
          <ToolChip key={i}>{query}</ToolChip>
        ))}
      </div>
    );
  }
  const capability = capabilityId(part, args);
  if (capability !== null) return <ToolChip>{capability}</ToolChip>;
  return <ValueView value={args} />;
}

function ToolReturnContent({ part }: { part: AnyToolReturnPart }) {
  const search = toolSearchContent(part);
  if (search !== null) {
    const discovered = discoveredTools(search);
    return (
      <div>
        {discovered.length > 0 ? (
          <div class={CHIPS_CLASS}>
            {discovered.map((name) => (
              <ToolChip key={name}>{name}</ToolChip>
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
  if (result.part_kind === "retry-prompt") return <Badge variant="error">retry</Badge>;
  const outcome = "outcome" in result ? result.outcome : undefined;
  if (outcome === "failed" || outcome === "denied") {
    return <Badge variant="error">{outcome}</Badge>;
  }
  return null;
}
