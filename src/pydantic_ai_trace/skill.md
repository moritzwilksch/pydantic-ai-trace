# Inspect Pydantic AI traces with paitrace

Use `paitrace` to answer questions about Pydantic AI agent runs saved as JSON: what a run did,
why it failed, which tool calls went wrong, what it output, and what it cost. A trace is a
`.json` file (a message list or a trajectory of runs) or one line of a `.jsonl` eval set.
`paitrace PATH` and `paitrace export` render traces for humans in a browser; use the commands
below instead.

## Pick a command

| Need | Command |
| --- | --- |
| Calls, tokens, cost, wall time per trace and run | `paitrace stats PATHS [--json]` |
| Structured data to query with jq | `paitrace json INPUT [--line N \| --all]` |
| A readable transcript to skim or grep | `paitrace text INPUT [--line N]` |

- `stats` also takes directories. It skips git-ignored, hidden, and dependency or build
  directories, and JSON that is not a trace. It prints a table, or JSONL
  `{name, stats, runs: [{id, name, parent, stats}]}` with `--json`. Invalid traces are listed
  with their error, and the exit status is 1.
- `json` and `text` read one trace. A `.jsonl` file with several traces needs `--line N`
  (counting traces from 1); `json --all` prints one compact document per line for every trace.
  `json` rejects directories: pass a glob such as `traces/*.json --all`. `--pretty` indents a
  single document, at a cost in tokens.
- With no input, or `-`, a command reads stdin: `cat trace.json | paitrace json`.

## Work in small reads

Traces get large. Find the trace, then the run, then the parts, and read only those.

1. Survey: `paitrace stats DIR` or `paitrace json INPUT | jq '.stats'`.
2. Narrow to a trace with a recipe below; open it with `--line N`.
3. Project with jq before reading. Print one object per line with `jq -c`, and cap long strings:
   `jq 'walk(if type == "string" and length > 300 then .[:300] + "..." else . end)'`.
4. For a quick look, grep the transcript: `paitrace text INPUT | grep -n -C3 PATTERN`.
   Headings name each item: `RUN:`, `OUTCOME:`, `TOOL CALL: name`, `TOOL RETURN: name [FAILED]`,
   `RETRY PROMPT:`, `OUTPUT: name`.

## `paitrace json` shape

```text
{name, stats, runs: [run]}       name: file name, or "evals.jsonl · trace N" for line N
run      {id, name, parent?, outcome, started_at, ended_at, stats, messages: [message]}
parent   {run_id, tool_call_id?}  absent on a top-level run
outcome  {status: "completed", output} | {status: "failed", error_type, detail}
         | {status: "cancelled"}
stats    {llm_calls, tokens: {input, cache_read?, cache_write?, output}, cost_usd?,
          unpriced_calls?, wall_time_seconds}
message  {type: "request" | "response", parts: [part]}; a response adds model?, provider?,
          finish_reason?, usage: {input, cache_read?, cache_write?, output}
part     by type:
  system | user | text | thinking   {content}
  tool_call     {name, args, id?, builtin?}
  tool_result   {name, result, id?, outcome?}   outcome: "failed" | "denied" | "interrupted";
                                                absent means success
  retry         {content, name?, id?}           the model is asked to fix a call or its output
  tools_available | compaction | file | other   rarer kinds; other keeps {original_type, data}
```

- Runs are in the order they ended, not tree order. A subagent's `parent.tool_call_id` is the
  `id` of the tool call that started it.
- A message-list trace is one run named after the trace, with `outcome.output` null.
- A tool call's result is the next `tool_result` or `retry` with the same `id` in the same run.
- An output tool's result is `"Final result processed."`; its call's `args` are the output.
- A run's `stats` count only its own calls; the top-level `stats` count every run. `cost_usd` is
  missing when no model has a known price.

## Recipes

Each recipe reads `trace.json`, `evals.jsonl`, or `./traces/`; substitute your paths.

List runs with parent, outcome, and cost:

```bash
paitrace json trace.json \
  | jq -c '.runs[] | {id, name, parent: .parent.run_id, status: .outcome.status, cost_usd: .stats.cost_usd}'
```

Find failed or cancelled runs across an eval set:

```bash
paitrace json evals.jsonl --all \
  | jq -c '.name as $trace | .runs[] | select(.outcome.status != "completed") | {trace: $trace, run: .name, outcome}'
```

Find failed tool calls and retries:

```bash
paitrace json trace.json | jq -c '
  .runs[] | .name as $run | .messages[].parts[]
  | select(.type == "tool_call" and (has("outcome") or has("retry")))
  | {run: $run, name, args, outcome, result, retry}'
```

Get each call of one tool with its result (`--arg tool final_result` gives the output tool's
args):

```bash
paitrace json trace.json | jq -c --arg tool lookup_order '
  .runs[] | .name as $run | [.messages[].parts[]] as $parts
  | $parts[] | select(.type == "tool_call" and .name == $tool) | .id as $id
  | {run: $run, args,
     result: ([$parts[] | select((.type == "tool_result" or .type == "retry") and .id == $id)] | first)}'
```

Get each trace's final output, falling back to the last text when no output was recorded:

```bash
paitrace json evals.jsonl --all | jq -c '
  {trace: .name} + (.runs[] | select(.parent == null)
  | {run: .name, output: (.outcome.output // ([.messages[].parts[] | select(.type == "text") | .content] | last))})'
```

Sum calls and cost per agent across traces (a message-list run counts as `(unnamed)`):

```bash
paitrace stats ./traces/ --json | jq -c -s '
  [.[] | .name as $trace | .runs[]? | .agent = (if .name == $trace then "(unnamed)" else .name end)]
  | group_by(.agent)
  | map({agent: .[0].agent, runs: length, llm_calls: (map(.stats.llm_calls) | add),
         cost_usd: (map(.stats.cost_usd // 0) | add)})
  | sort_by(-.cost_usd)'
```

Print the `--line` number of every trace in an eval set that mentions a string:

```bash
paitrace json evals.jsonl --all \
  | jq --arg q 'refund' 'select([.. | strings] | any(test($q; "i"))) | input_line_number'
```

Then read one match:

```bash
paitrace text evals.jsonl --line 3 | grep -n -i -C3 'refund'
```
