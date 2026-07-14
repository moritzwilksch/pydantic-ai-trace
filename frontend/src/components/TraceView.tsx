import { useMemo } from "preact/hooks";
import { cacheHitRate, computeStats, timestampsMs } from "../parse";
import { pairToolCalls } from "../pairing";
import type { Message } from "../types";
import { formatCount, MessageCard } from "./MessageCard";

export function TraceView({ messages }: { messages: Message[] }) {
  const pairing = useMemo(() => pairToolCalls(messages), [messages]);
  const traceStartMs = useMemo(() => {
    const times = timestampsMs(messages);
    return times.length > 0 ? Math.min(...times) : null;
  }, [messages]);
  return (
    <div>
      {messages.map((message, i) => (
        <MessageCard key={i} message={message} pairing={pairing} traceStartMs={traceStartMs} />
      ))}
    </div>
  );
}

export function TraceStatsBar({ messages }: { messages: Message[] }) {
  const stats = useMemo(() => computeStats(messages), [messages]);
  const hitRate = cacheHitRate(stats.inputTokens, stats.cacheReadTokens);
  return (
    <div class="trace-stats">
      <span>
        <b>{stats.requestCount}</b> LLM calls
      </span>
      <span class="trace-token-summary" aria-label="Token usage">
        <b>{formatCount(stats.inputTokens)}</b> in
      </span>
      <span class="trace-token-summary">
        <b>{formatCount(stats.cacheReadTokens)}</b> cached
        {hitRate !== null ? ` (${hitRate.toFixed(1)}%)` : ""}
      </span>
      <span class="trace-token-summary">
        <b>{formatCount(stats.outputTokens)}</b> out
      </span>
      {stats.wallTimeMs !== null ? (
        <span>
          <b>{(stats.wallTimeMs / 1000).toFixed(1)}s</b> wall time
        </span>
      ) : null}
    </div>
  );
}
