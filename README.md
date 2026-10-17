# pydantic-ai-trace

Inspect [Pydantic AI](https://ai.pydantic.dev) agent runs in your browser. Point `paitrace` at a `list[ModelMessage]` dump, a trajectory of several runs, or a directory of them. It reads the files from disk, reloads them when they change, and exports any trace as a self-contained HTML file. No hosted service, no account.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/moritzwilksch/pydantic-ai-trace/main/docs/screenshot-dark.png">
  <img alt="The paitrace viewer showing a research agent run, its tool calls, and the fact_checker subagent it started" src="https://raw.githubusercontent.com/moritzwilksch/pydantic-ai-trace/main/docs/screenshot-light.png" width="1400">
</picture>

## What you can inspect

- The full request and response sequence: prompts, text, thinking, tool calls, tool results, and every other Pydantic AI part
- Tool search queries, the tools they discovered, and the tools each step could use
- Tool calls paired with their results, also when a result arrives in a later message
- Model, provider, timing, token usage, and cost (from [genai-prices](https://github.com/pydantic/genai-prices))
- Trajectories: workflow steps and subagents as a tree of runs, each subagent linked from the tool call that started it, with costs summed up the tree
- A searchable directory tree of `.json` and `.jsonl` traces
- Collapsible large values, rendered Markdown, keyboard navigation, and in-trace search with `/`
- A compact text transcript, copied from the viewer or printed with `paitrace text`

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
with `pixi run`. With no input, a command reads piped stdin.

> [!WARNING]
> The viewer has no authentication. It binds to `127.0.0.1` by default; binding `--host` to any
> other address exposes every trace under the served path to whoever can reach the port.

### Query with jq

`paitrace json` prints one document per trace: its `name`, aggregate `stats`, and `runs`, each
with its own `stats` and `messages`. `paitrace stats --json` prints the same `stats` for each
trace and run, without messages.

```bash
# The last assistant text, with runs in the order they ended
paitrace json trace.json \
  | jq -r '[.runs[].messages[].parts[] | select(.type == "text") | .content] | last'

# Tool calls, results, and retries, in order within each run
paitrace json trace.json \
  | jq '[.runs[].messages[].parts[] | select(.type == "tool_call" or .type == "tool_result" or .type == "retry")]'

# Each tool call with its result or retry, within its run
# (takes the first result with the call's ID, so assumes IDs are unique within a run)
paitrace json trace.json | jq '
  [.runs[]
    | .id as $run
    | [.messages[].parts[]] as $parts
    | [$parts[] | select(.type == "tool_result" or .type == "retry")] as $results
    | $parts[]
    | select(.type == "tool_call")
    | . as $call
    | {
        run: $run,
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

# Each agent's share of the cost across traces, grouping runs by name
paitrace stats ./traces/ --json | jq -s '
  [.[] | .runs[]?]
  | group_by(.name)
  | map({name: .[0].name, cost_usd: (map(.stats.cost_usd // 0) | add)})
  | (map(.cost_usd) | add) as $total
  | map(.share = (if $total > 0 then 100 * .cost_usd / $total | round else null end))
  | sort_by(-.cost_usd)
'
```

A run's `stats` count only its own calls, not the runs it started, so summing runs by name
counts no subagent twice. `cost_usd` is missing when genai-prices knows none of the models;
`unpriced_calls` counts the responses it could not price.

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
the messages it produced, without inherited history, so pass `result.new_messages()`.

`Trajectory` validates that run IDs are unique, that a `tool_call_id` names exactly one tool call
in its parent run, and that no run is its own ancestor. A run whose parent is not in the trajectory is shown as a
top-level run marked "parent not recorded", so a file written while a workflow runs stays
viewable.

## Embed from Python

`render_html` turns a trajectory into the same self-contained HTML document that
`paitrace export` writes. It starts no server and writes no file. Show the document in an
iframe, which keeps the viewer's CSS and keyboard shortcuts out of the host page.

In Streamlit:

```python
import streamlit.components.v1 as components

from pydantic_ai_trace import Trajectory, render_html

html = render_html(Trajectory.from_messages(messages), name="Candidate response")
components.html(html, height=900, scrolling=True)
```

From a Python HTTP server, return the document from its own endpoint and point an iframe at that
URL. For example, with Starlette:

```python
from starlette.responses import HTMLResponse

from pydantic_ai_trace import Trajectory, render_html


async def trace_view(request):
    messages = load_messages(request.path_params["run_id"])
    trajectory = Trajectory.from_messages(messages)
    return HTMLResponse(render_html(trajectory, name=f"Run {request.path_params['run_id']}"))
```

The document uses inline JavaScript and CSS. Under a strict Content Security Policy, serve it with
a policy that allows them.

## Trace files

Every command reads two JSON shapes:

- A message list: the JSON from `ModelMessagesTypeAdapter.dump_json(messages)`, shown as one run.
- A trajectory: the JSON from `Trajectory.model_dump_json()`.

A `.json` file holds one trace. A `.jsonl` file holds one trace per line, and each line is its
own trace in the viewer and in `paitrace stats`.

Traces are validated with the installed Pydantic AI. A trace that does not validate is listed
with its first validation error instead. A dump from a newer Pydantic AI may need a newer install.

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
pixi run screenshots # re-render docs/screenshot-{light,dark}.png for this README
```

## Releasing

Publish a GitHub release with a `vX.Y.Z` tag. The package version comes from that tag, so no
source file needs a version bump. The release workflow runs every check, builds the frontend into
the wheel and sdist, publishes both to PyPI with trusted publishing, and attaches them to the
release. Configure a `pypi`
environment in GitHub and add this repository as a trusted publisher for the `pydantic-ai-trace`
project on PyPI before the first release.
