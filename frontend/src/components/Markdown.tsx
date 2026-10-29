import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";
import { useMemo, useState } from "preact/hooks";
import { Toggle } from "./ui/toggle";

for (const [name, lang] of Object.entries({
  bash,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, lang);
}

const renderer = new marked.Renderer();
const renderPlainCode = renderer.code.bind(renderer);
renderer.code = (token) => {
  const language = token.lang?.split(/\s+/)[0];
  if (!language || !hljs.getLanguage(language)) return renderPlainCode(token);
  const highlighted = hljs.highlight(token.text, { language }).value;
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
};

// Loading a remote image would tell its server that someone opened this trace, so
// sanitizing turns every image except an inline `data:` one into a link. The hook
// runs in DOMPurify's inert document, where no image loads.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "IMG") return;
  const src = node.getAttribute("src") ?? "";
  if (src.startsWith("data:")) return;
  const link = node.ownerDocument.createElement("a");
  link.textContent = node.getAttribute("alt") || src || "image";
  if (src) {
    link.setAttribute("href", src);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer noopener");
  }
  node.replaceWith(link);
});

// Sanitize even though the server is local: exported HTML files get shared.
function renderMarkdown(source: string, preserveNewlines: boolean): string {
  return DOMPurify.sanitize(
    marked.parse(source, { async: false, renderer, breaks: preserveNewlines }),
    {
      // Drop the remaining elements and attributes that load URLs; Markdown needs none.
      USE_PROFILES: { html: true }, // no SVG or MathML
      FORBID_TAGS: ["audio", "input", "picture", "source", "track", "video"],
      FORBID_ATTR: ["background", "poster", "srcset", "style"],
    },
  );
}

export const RAW_TEXT_CLASS =
  "raw-text m-0 font-mono text-[12.5px] break-words whitespace-pre-wrap";

/** Markdown with code highlighting and a toggle to the raw text. */
export function Markdown({
  source,
  preserveNewlines = false,
}: {
  source: string;
  preserveNewlines?: boolean;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const html = useMemo(
    () => (showRaw ? "" : renderMarkdown(source, preserveNewlines)),
    [source, showRaw, preserveNewlines],
  );

  return (
    <div>
      <Toggle
        size="sm"
        className="float-right h-5 min-w-0 px-1.5 text-[10.5px] font-normal text-muted-foreground sm:h-5 sm:min-w-0 sm:text-[10.5px]"
        title={showRaw ? "Render markdown" : "Show raw text"}
        pressed={showRaw}
        onPressedChange={setShowRaw}
      >
        raw
      </Toggle>
      {showRaw ? (
        <pre class={RAW_TEXT_CLASS}>{source}</pre>
      ) : (
        <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
