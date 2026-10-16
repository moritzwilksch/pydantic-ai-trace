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

## Usage

```bash
# View one trace
pixi run paitrace trace.json

# Browse a directory tree of traces
pixi run paitrace ./my-traces/

# Browse an explicit collection of trace files with live reload
pixi run paitrace first.json second.json runs/multi.jsonl

# Write one trace to a standalone HTML file
pixi run paitrace export trace.json -o trace.html

# Choose a trace line when exporting a multi-trace JSONL file
pixi run paitrace export runs.jsonl --line 2

# Print the browser's compact text representation to stdout
pixi run paitrace text trace.json

# Print a compact, structured trajectory for jq and other tools
pixi run paitrace json trace.json

# Read a trace from stdin; `-` can also be used explicitly
curl https://example.test/my-traj.json | pixi run paitrace json | jq '.runs[].messages[]'
curl https://example.test/my-traj.json | pixi run paitrace text

# Select a trace from JSONL, or write the text to a file
pixi run paitrace text runs.jsonl --line 2
pixi run paitrace text trace.json -o trace.txt

# JSON output supports the same selection and output options
pixi run paitrace json runs.jsonl --line 2
pixi run paitrace json trace.json -o compact.json

# Convert every trace in JSONL to one compact JSON object per line
pixi run paitrace json runs.jsonl --all -o compact.jsonl

# Convert multiple JSON files to compact JSONL in argument order
pixi run paitrace json first.json second.json -o compact.jsonl

# Mix JSON and JSONL inputs; --all expands every JSONL source
pixi run paitrace json first.json runs.jsonl --all -o compact.jsonl

# Indent one compact trajectory for direct inspection
pixi run paitrace json trace.json --pretty

# Export or view a trace received on stdin
curl https://example.test/my-traj.json | pixi run paitrace export -o trace.html
curl https://example.test/my-traj.json | pixi run paitrace --no-open
```

`paitrace text` writes only the transcript to stdout by default, so it can be piped directly into
another command. Repeated request instructions are omitted until they change. Multi-trace JSONL
files require `--line`, just as HTML export does.

`paitrace json` emits a token-efficient trajectory document: `name`, aggregate `stats`, and
`runs` in recorded order. Each run carries its `id`, `name`, `parent`, `outcome`, timing, own
`stats`, and `messages`. A message list is one run. Messages preserve request and response order,
native tool arguments and results, tool-call IDs, and model and token metadata. They omit display
headings, repeated instructions, provider response identifiers, and binary payloads. Tool calls
and results remain separate events linked by `id`. `cost_usd` is present when genai-prices knows
the model; `unpriced_calls` counts the responses it could not price.

Pass `--all` to convert every trace in a JSONL file or stream. The output remains JSONL, with one
compact trajectory per line. `--all` cannot be combined with `--line` or `--pretty`. Pass
`--pretty` to indent single-trace output by two spaces.

Multiple `.json` inputs also produce compact JSONL, in argument order. When multiple inputs include
JSONL, pass `--all` to expand each JSONL source. Multiple inputs cannot use stdin, `--line`, or
`--pretty`. The browser also accepts multiple explicit `.json` and `.jsonl` files and watches each
source for changes. `text` and `export` remain single-input commands.

### Query compact JSON with jq

```bash
# Extract the final assistant text
pixi run paitrace json trace.json \
  | jq -r '[.runs[].messages[].parts[] | select(.type == "text") | .content] | last'

# Extract tool calls, results, and retries in chronological order
pixi run paitrace json trace.json \
  | jq '[.runs[].messages[].parts[] | select(.type == "tool_call" or .type == "tool_result" or .type == "retry")]'

# Pair tool calls with their result or retry by call ID
pixi run paitrace json trace.json | jq '
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

# Read aggregate model-call and token statistics
pixi run paitrace json trace.json | jq '.stats'

# Collect several compact trajectories into one JSON array
pixi run paitrace json first.json second.json | jq -s '.'
```

The viewer, `text`, `json`, and `export` commands accept a trace from piped stdin when their input
is omitted. Pass `-` to request stdin explicitly. Stdin can contain one JSON trace or JSONL traces;
use `--line` to select from multi-trace JSONL. HTML export from stdin requires `-o`.

The viewer binds to `127.0.0.1:1205` and opens your browser. Pass `--port`, `--host`, or `--no-open` to change that behavior.

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
