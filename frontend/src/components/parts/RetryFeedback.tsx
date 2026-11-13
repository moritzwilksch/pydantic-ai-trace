import { TriangleAlert } from "lucide-preact";
import { compactJson } from "../../format";
import type { ErrorDetails, RetryFeedbackPart } from "../../types";
import { Block } from "../Block";
import { ValueView } from "./common";

/** Feedback asking the model to try again that answers no tool call, such as invalid output. */
export function RetryFeedback({ part }: { part: RetryFeedbackPart }) {
  const { content } = part;
  return (
    <Block
      label={
        <>
          <TriangleAlert size={13} /> Retry feedback
        </>
      }
      tone="error"
      preview={typeof content === "string" ? content : compactJson(content)}
    >
      {typeof content === "string" ? (
        <ValueView value={content} />
      ) : (
        <ErrorDetailsTable details={content} />
      )}
    </Block>
  );
}

/** The fields of a validation error a reader needs to fix the input. */
export type ErrorDetail = Pick<ErrorDetails, "loc" | "type" | "msg">;

/** Validation errors, one row each. */
export function ErrorDetailsTable({ details }: { details: ErrorDetail[] }) {
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
        {details.map((detail, i) => (
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
