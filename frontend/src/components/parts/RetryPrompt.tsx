import { TriangleAlert } from "lucide-preact";
import { compactJson } from "../../parse";
import type { ErrorDetail, RetryPromptPart } from "../../types";
import { Block } from "../Block";
import { ValueView } from "./common";

export function RetryPrompt({ part }: { part: RetryPromptPart }) {
  return (
    <Block
      label={
        <>
          <TriangleAlert size={13} /> Retry prompt
        </>
      }
      tone="error"
      badges={part.tool_name ? <span class="badge error">{part.tool_name}</span> : null}
      preview={typeof part.content === "string" ? part.content : compactJson(part.content)}
    >
      <RetryContent content={part.content} />
    </Block>
  );
}

export function RetryContent({ content }: { content: RetryPromptPart["content"] }) {
  if (typeof content === "string") return <ValueView value={content} />;
  if (Array.isArray(content) && content.every(isErrorDetail)) {
    return (
      <table class="error-table">
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
  return <ValueView value={content} />;
}

function isErrorDetail(value: unknown): value is ErrorDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "msg" in value &&
    "loc" in value &&
    Array.isArray((value as ErrorDetail).loc)
  );
}
