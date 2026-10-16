# pydantic-ai-trace

Use `pydantic-ai-trace` when you need to inspect an agent run from a JSON dump. Give it a [pydantic-ai](https://ai.pydantic.dev) `list[ModelMessage]` dump, or a trajectory of several runs, and it opens them in a browser view.

It is a lightweight local tool. Point it at a trace or a directory of traces and it reads the files from disk, reloads them when they change, and exports individual traces as self-contained HTML files. Your traces stay on disk, with no hosted service or account.

<img width="1196" height="791" alt="image" src="https://github.com/user-attachments/assets/bfdfb570-69be-4c2f-811b-4fe8182f8601" />


## What you can inspect

- The full request and response sequence, including prompts, text, thinking, tool calls, tool results, and every other Pydantic AI part
- Tool search and capability loading rendered by what they carry: the queries asked, the tools discovered, and the tools each step made available
- Tool calls paired with their results, including results in later messages
- Model, provider, timing, token usage, and cost (from [genai-prices](https://github.com/pydantic/genai-prices))
- Trajectories: workflow steps and subagents as a tree of runs, each subagent linked from the tool call that started it, with costs summed up the tree
- A searchable directory tree for `.json` and `.jsonl` traces
- Collapsible large values, rendered Markdown, and keyboard navigation
- In-trace search with `/`, match highlighting, and automatic expansion of collapsed results
- One-click copying as a compact text transcript that preserves request and response order
- CLI rendering of the same compact transcript for use by people, scripts, and AI agents

## Run from a checkout

This project uses [pixi](https://pixi.sh). Build the bundled frontend once, then run `paitrace` with a trace file or directory.

```bash
pixi run build-frontend
pixi run paitrace trace.json
```

## Commands

| Command | Does |
| --- | --- |
| `paitrace [PATHS ...]` | Opens traces in a local web viewer that reloads when files change |
| `paitrace export [INPUT]` | Writes one trace as a self-contained HTML file |
| `paitrace text [INPUT]` | Prints one trace as a plain-text transcript |
| `paitrace json [INPUTS ...]` | Prints traces as compact JSON for jq, scripts, and AI agents |
| `paitrace stats [PATHS ...]` | Prints LLM calls, tokens, cost, and wall time per trace |

`paitrace COMMAND --help` lists every option with examples. From a checkout, prefix commands
with `pixi run`.

### Inputs

Every command reads the same traces:

- A trace is a message list or a trajectory; see [Trace files](#trace-files).
- A `.json` file holds one trace. A `.jsonl` file holds one trace per line.
- With no input, a command reads piped stdin. Pass `-` to read stdin explicitly. Stdin can hold
  one JSON trace or JSONL.
- `--line N` picks trace `N` (counting from 1) of a multi-trace JSONL input. `export`, `text`,
  and single-input `json` require it for such inputs.

A command word is still treated as a path when a file or directory with that name exists, so
`paitrace export` serves a directory named `export`.

### `paitrace` — view traces

```bash
paitrace trace.json                   # one trace
paitrace ./traces/                    # every trace under a directory
paitrace first.json runs.jsonl        # only the files you name
curl -s https://example.test/trace.json | paitrace
```

The viewer binds to `127.0.0.1:1205` and opens a browser tab. `--port`, `--host`, and
`--no-open` change that. Each line of a JSONL file appears as its own trace; a trajectory's runs
appear under their trace in the sidebar.

### `paitrace export` — write HTML

```bash
paitrace export trace.json                    # writes trace.html
paitrace export runs.jsonl --line 2 -o run2.html
curl -s https://example.test/trace.json | paitrace export -o trace.html
```

The file embeds the trace, its costs, and the viewer, and opens offline. `-o` defaults to the
input path with an `.html` suffix and is required for stdin.

### `paitrace text` — print a transcript

```bash
paitrace text trace.json | less
paitrace text runs.jsonl --line 2 -o run2.txt
```

The transcript lists every run, request, and response in order, with token usage and cost.
Instructions are printed only when they change. It goes to stdout unless `-o` names a file, and
it is the text the viewer's "Copy trace" button copies.

### `paitrace json` — print compact JSON

```bash
paitrace json trace.json --pretty                 # one indented document
paitrace json runs.jsonl --all -o compact.jsonl   # one document per JSONL line
paitrace json first.json second.json              # JSONL, in argument order
paitrace json first.json runs.jsonl --all         # --all also expands JSONL inputs
```

Each document has the trace's `name`, aggregate `stats`, and `runs` in recorded order. A run
carries its `id`, `name`, `parent`, `outcome`, timing, own `stats`, and `messages`; a message
list is one run. Messages keep request and response order, native tool arguments and results,
tool-call IDs, and model and token metadata. Tool calls and results stay separate events linked
by `id`. Display headings, repeated instructions, provider response IDs, and binary payloads are
left out. `cost_usd` is present when genai-prices knows the model; `unpriced_calls` counts the
responses it could not price.

One input prints one document. Several inputs, or `--all`, print JSONL with one document per
trace; a JSONL `-o` file is replaced only after every trace converts. `--all` cannot be combined
with `--line` or `--pretty`, and several inputs cannot use stdin, `--line`, or `--pretty`.

Query it with jq:

```bash
# The final assistant text
paitrace json trace.json \
  | jq -r '[.runs[].messages[].parts[] | select(.type == "text") | .content] | last'

# Tool calls, results, and retries in chronological order
paitrace json trace.json \
  | jq '[.runs[].messages[].parts[] | select(.type == "tool_call" or .type == "tool_result" or .type == "retry")]'

# Tool calls paired with their result or retry by call ID
paitrace json trace.json | jq '
  [.runs[].messages[].parts[]] as $parts
  | [$parts[] | select(.type == "tool_result" or .type == "retry")] as $results
  | [$parts[] | select(.type == "tool_call")
      | . as $call
      | {
          id,
          name,
          args,
          result: ($results | map(select(.id == $call.id)) | first)
        }
    ]
'

# Aggregate LLM calls, tokens, and cost
paitrace json trace.json | jq '.stats'

# Several documents as one JSON array
paitrace json first.json second.json | jq -s '.'
```

### `paitrace stats` — summarize traces

```bash
paitrace stats ./traces/
paitrace stats runs/multi.jsonl full_trace.json trajectory.json
paitrace stats ./traces/ --json | jq -s 'map(.stats.cost_usd // 0) | add'
```

```text
trace                       runs  calls    in  cached  out     cost   wall
runs/multi.jsonl · trace 1     1      1     5       0    6  $0.0004   1.0s
runs/multi.jsonl · trace 2     1      1     5       0    6  $0.0004   1.0s
full_trace.json                1      3   930       0  165  $0.0028   6.0s
trajectory.json                4      5   500       0  100  $0.0023   6.0s
total                          7     10  1440       0  277  $0.0058  14.0s
```

`stats` prints one row per trace and, for several traces, a totals row. It searches a
directory like the viewer's sidebar, and each JSONL line is its own trace. A cost marked `*`
includes responses whose model has no known price; `-` means none could be priced. Traces that
do not validate are listed with their error after the table, and the command exits with status 1.

`--json` prints JSONL instead: `{name, runs, stats}` per trace, where `stats` has the same shape
as in `paitrace json`, or `{name, error}` for an invalid trace.

## Trajectories

A trajectory is a tree of runs. Top-level runs are workflow steps; a run with a parent is a
subagent, usually started by one of its parent's tool calls. Build one from your own data and
write it as JSON for `paitrace`, or render it directly:

```python
from pathlib import Path

from pydantic_ai_trace import Run, Trajectory

# One top-level run per workflow step, from message lists or their JSON dumps.
steps = Trajectory.from_named_messages({"planner": planner_messages, "worker": worker_messages})
worker = next(run for run in steps.runs if run.name == "worker")

# A subagent, started by the worker's tool call `call_1`.
subagent = Run.from_messages(subagent_messages, name="researcher").child_of(
    worker, tool_call_id="call_1"
)

trajectory = Trajectory(runs=(*steps.runs, subagent))
Path("case-42.json").write_text(trajectory.model_dump_json())
```

`Run.from_messages` takes a run's start and end from its message timestamps and records it as
completed. Construct `Run` directly to set `started_at`, `ended_at`, or an `outcome` of
`Completed(output=...)`, `Failed(error_type=..., detail=...)`, or `Cancelled()`. A run holds only
the messages it produced, without inherited history; use `result.new_messages()`.

`Trajectory` validates that run IDs are unique, that a `tool_call_id` exists in its parent run,
and that no run is its own ancestor. A run whose parent is not in the trajectory is shown as a
top-level run marked "parent not recorded", so a file written while a workflow runs stays
viewable.

## Embed from Python

`render_html` turns a trajectory into the same self-contained HTML document produced by
`paitrace export`. It does not start a server or write a temporary file.

```python
from pydantic_ai_trace import Trajectory, render_html

html = render_html(Trajectory.from_messages(messages), name="Candidate response")
```

### Streamlit

Streamlit renders custom HTML inside an iframe:

```python
import streamlit.components.v1 as components

from pydantic_ai_trace import Trajectory, render_html

html = render_html(Trajectory.from_messages(messages), name="Candidate response")
components.html(html, height=900, scrolling=True)
```

### Python HTTP servers

Return the document from a dedicated endpoint, then show that URL in an iframe in the host page.
For example, with Starlette:

```python
from starlette.responses import HTMLResponse

from pydantic_ai_trace import Trajectory, render_html


async def trace_view(request):
    messages = load_messages(request.path_params["run_id"])
    trajectory = Trajectory.from_messages(messages)
    return HTMLResponse(render_html(trajectory, name=f"Run {request.path_params['run_id']}"))
```

```html
<iframe
  src="/runs/abc123/trace"
  title="Agent trace"
  style="width: 100%; height: 100%; border: 0"
></iframe>
```

The iframe isolates the viewer's CSS and keyboard shortcuts from the host application. The
generated document contains inline JavaScript and CSS, so applications with a strict Content
Security Policy must allow the document or serve it under a suitable policy.

## Trace files

The viewer reads two JSON shapes:

- A message list: the JSON emitted by `ModelMessagesTypeAdapter.dump_json(messages)`. It is shown
  as one run.
- A trajectory: the JSON emitted by `Trajectory.model_dump_json()`.

`.json` files hold one of these. `.jsonl` files hold one per line; when you open a directory,
each line is available as a separate trace.

Traces are validated with the installed Pydantic AI. A trace that does not validate is listed
with its first validation error instead of being rendered. A dump from a newer Pydantic AI may
need a newer install.

## Development

Run the API and frontend in separate terminals while working on the viewer.

```bash
pixi run dev-api ./trace.json  # API with reload on port 1205
pixi run dev-web               # Vite with HMR, proxying /api
```

```bash
pixi run test        # pytest and vitest
pixi run test-lowest # pytest against the lowest supported dependency versions
pixi run gen-types   # regenerate frontend/src/generated/payload.ts from the Python models
pixi run lint        # ruff, prettier, and eslint
pixi run typecheck   # pyright and TypeScript
pixi run build       # bundled frontend plus sdist and wheel
```

## Releasing

Create and publish a GitHub release with a `vX.Y.Z` tag. The package version is derived from that
tag, so no source file needs a version bump. Publishing the release triggers GitHub Actions to run
the full check suite, build the frontend into the wheel and source distribution, publish both to
PyPI using trusted publishing, and attach them to the GitHub release. Configure a `pypi`
environment in GitHub and add this repository as a trusted publisher for the `pydantic-ai-trace`
project on PyPI before the first release.
