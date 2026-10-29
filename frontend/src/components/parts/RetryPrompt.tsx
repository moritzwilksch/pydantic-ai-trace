import { TriangleAlert } from "lucide-preact";
import { compactJson } from "../../format";
import type { RetryPromptPart } from "../../types";
import { Block } from "../Block";
import { ValueView } from "./common";
import { CallEnd, type CallLink, PAIR_ARROW_CLASS, ToolSignature } from "./ToolCallGroup";

/** A retry prompt; one with a tool name answers a tool call and links to it. */
export function RetryPrompt({ part, call }: { part: RetryPromptPart; call: CallLink | null }) {
  return (
    <Block
      label={
        <>
          <TriangleAlert size={13} /> Retry prompt
        </>
      }
      tone="error"
      badges={
        part.tool_name ? (
          <>
            <ToolSignature name={part.tool_name} args={call?.argsPreview ?? null} />
            <span class={PAIR_ARROW_CLASS}>→</span>
          </>
        ) : null
      }
      preview={typeof part.content === "string" ? part.content : compactJson(part.content)}
      trailing={part.tool_name || call ? <CallEnd call={call} /> : null}
    >
      <RetryContent content={part.content} />
    </Block>
  );
}

export function RetryContent({ content }: { content: RetryPromptPart["content"] }) {
  if (typeof content === "string") return <ValueView value={content} />;
  return (
    <table class="font-mono text-[12.5px] [&_:is(td,th)]:border [&_:is(td,th)]:px-2 [&_:is(td,th)]:py-0.75 [&_:is(td,th)]:text-left">
      <thead>
        <tr>
          <th>loc</th>
          <th>type</th>
          <th>message</th>
        </tr>
      </thead>
      <tbody>
        {content.map((detail, i) => (
          <tr key={i}>
            <td>{detail.loc.join(".")}</td>
            <td>{detail.type}</td>
            <td>{detail.msg}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
