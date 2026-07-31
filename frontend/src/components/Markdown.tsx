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

// Sanitize even though the server is local: exported HTML files get shared.
function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false, renderer }));
}

/** Markdown with code highlighting and a toggle to the raw text. */
export function Markdown({ source }: { source: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const html = useMemo(() => (showRaw ? "" : renderMarkdown(source)), [source, showRaw]);

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
        <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
