import { ExternalLink, FileText, MessageSquare } from "lucide-preact";
import { compactJson, markdownPreview, parseJsonContainer } from "../../format";
import type { Citation, TextPart as TextPartType } from "../../types";
import { Block } from "../Block";
import { Badge } from "../ui/badge";
import { linkableUrl, ValueView } from "./common";

export function TextPart({ part }: { part: TextPartType }) {
  const json = parseJsonContainer(part.content);
  const citations = part.citations ?? [];
  return (
    <Block
      label={
        <>
          <MessageSquare size={13} /> Text
        </>
      }
      tone="assistant"
      badges={
        citations.length > 0 ? <Badge variant="outline">{citations.length} citations</Badge> : null
      }
      preview={json === null ? markdownPreview(part.content) : compactJson(json)}
    >
      <ValueView value={json ?? part.content} markdown={json === null} />
      {citations.length > 0 ? <Citations content={part.content} citations={citations} /> : null}
    </Block>
  );
}

/** Each citation's anchor in the text, then the sources that back it. */
function Citations({ content, citations }: { content: string; citations: Citation[] }) {
  // Anchors count Unicode code points, as Python indexes strings; JS strings index UTF-16 units.
  const codePoints = Array.from(content);
  return (
    <ol class="citations mt-2 flex list-none flex-col gap-2 border-t pt-2 text-xs">
      {citations.map((citation, i) => {
        const anchor = citation.anchor;
        const cited = anchor ? codePoints.slice(anchor.start, anchor.end).join("") : null;
        return (
          <li key={i}>
            <span class="font-mono text-muted-foreground">{i + 1}.</span>{" "}
            {cited === null ? null : anchor?.kind === "marker" ? (
              <span class="font-mono">{cited}</span>
            ) : (
              <q class="italic">{cited}</q>
            )}
            <ul class="mt-1 ml-4 flex flex-col gap-1">
              {citation.sources.map((source, j) => (
                <li key={j}>
                  <CitationSource source={source} />
                  {source.excerpts.map((excerpt, k) => (
                    <blockquote key={k} class="mt-0.5 border-l-2 pl-2 text-muted-foreground">
                      {excerpt}
                    </blockquote>
                  ))}
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

function CitationSource({ source }: { source: Citation["sources"][number] }) {
  if (source.kind === "web") {
    const href = linkableUrl(source.url);
    const label = source.title ?? source.url;
    return (
      <span class="inline-flex items-center gap-1">
        <ExternalLink size={12} aria-hidden="true" />
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            class="underline"
            title={source.url}
          >
            {label}
          </a>
        ) : (
          <span title={source.url}>{label}</span>
        )}
      </span>
    );
  }
  const names = [source.title, source.document_id].filter((name) => name !== null);
  return (
    <span class="inline-flex items-center gap-1">
      <FileText size={12} aria-hidden="true" />
      {names.length > 0 ? names.join(" · ") : "document"}
    </span>
  );
}
