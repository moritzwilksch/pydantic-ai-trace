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
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

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

// Sanitize even though the server is local: exported HTML files get shared.
function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }));
}

/** Markdown with code highlighting and a toggle to the raw text. */
export function Markdown({ source }: { source: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (showRaw ? "" : renderMarkdown(source)), [source, showRaw]);

  useEffect(() => {
    if (showRaw || !container.current) return;
    for (const block of container.current.querySelectorAll("pre code")) {
      hljs.highlightElement(block as HTMLElement);
    }
  }, [source, showRaw]);

  return (
    <div>
      <button
        class="md-toggle"
        title={showRaw ? "Render markdown" : "Show raw text"}
        onClick={() => setShowRaw(!showRaw)}
      >
        {showRaw ? "md" : "raw"}
      </button>
      {showRaw ? (
        <pre class="raw-text">{source}</pre>
      ) : (
        <div ref={container} class="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
