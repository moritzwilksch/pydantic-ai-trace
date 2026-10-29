# pydantic-ai-trace

Inspect [Pydantic AI](https://ai.pydantic.dev) agent runs in your browser. Point `paitrace` at a `list[ModelMessage]` dump, a run tree of several runs, or a directory of them. It reads the files from disk, reloads them when they change, and exports any trace as a self-contained HTML file. No hosted service, no account.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/moritzwilksch/pydantic-ai-trace/main/docs/screenshot-dark.png">
  <img alt="The paitrace viewer showing a research agent run, its tool calls, and the fact_checker subagent it started" src="https://raw.githubusercontent.com/moritzwilksch/pydantic-ai-trace/main/docs/screenshot-light.png" width="1400">
</picture>

## What you can inspect

- The full request and response sequence: prompts, text, thinking, tool calls, tool results, and every other Pydantic AI part
- Tool search queries, the tools they discovered, and the tools each step could use
- Tool calls paired with their results, also when a result arrives in a later message
- Model, provider, timing, token usage, and cost (from [genai-prices](https://github.com/pydantic/genai-prices))
- Run trees: workflow steps and subagents as a tree of runs, each subagent linked from the tool call that started it, with costs summed up the tree
- A collapsible directory tree of `.json` and `.jsonl` traces, each labelled by its first prompt and filterable by path, prompt, final answer, or model
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
| `paitrace --skill` | Prints an agent skill for inspecting traces with the commands above |

`paitrace COMMAND --help` lists every option with examples. From a checkout, prefix commands
with `pixi run`. With no input, a command reads piped stdin; bare `paitrace` in a terminal prints
help.

> [!WARNING]
> The viewer has no authentication. It binds to `127.0.0.1` by default; binding `--host` to any
> other address exposes every trace under the served path to whoever can reach the port.

### Query with jq

`paitrace json` prints one document per trace: its `name`, aggregate `stats`, and `runs` in tree
order, each with its own `stats` and `messages`. Each tool call carries what became of it: its
`result` and `outcome`, a `retry`, `output: true` when its arguments are the run's output, and the
`child_runs` it started. `paitrace stats --json` prints the same `stats` for each trace and run,
without messages.

```bash
paitrace json trace.json | jq '.stats'
```

A run's `stats` count only its own calls, not the runs it started, so summing runs by name
counts no subagent twice. `cost_usd` is missing when genai-prices knows none of the models;
`unpriced_calls` counts the responses it could not price.

`paitrace --skill` prints the full shape and tested jq recipes as an agent skill: runs and their
outcomes, failed tool calls, a tool's calls with their results, final outputs, cost per agent, and
searching an eval set. Install it for an agent, adding the frontmatter header its host requires:

```bash
mkdir -p .claude/skills/paitrace
paitrace --skill > .claude/skills/paitrace/SKILL.md
```

## Run trees

A run tree is a tree of runs. Top-level runs are workflow steps; a run with a parent is a
subagent, usually started by one of its parent's tool calls. Build one from your own data and
write it as JSON for `paitrace`, or render it directly:

```python
from pathlib import Path

from pydantic_ai_trace import Run, RunTree

# One top-level run per workflow step. Each value is a list of `ModelMessage`s, or the parsed
# JSON of a dump (`json.loads(...)`), not the JSON string itself.
steps = RunTree.from_named_messages({"planner": planner_messages, "worker": worker_messages})
worker = next(run for run in steps.runs if run.name == "worker")

# A subagent, started by the worker's tool call `call_1`.
subagent = Run.from_messages(subagent_messages, name="researcher").child_of(
    worker, tool_call_id="call_1"
)

run_tree = RunTree(runs=(*steps.runs, subagent))
Path("case-42.json").write_text(run_tree.model_dump_json())
```

`Run.from_messages` takes a run's start and end from its message timestamps and records it as
completed. Construct `Run` directly to set `started_at`, `ended_at`, or an `outcome` of
`Completed(output=...)`, `Failed(error_type=..., detail=...)`, or `Cancelled()`. A run holds only
the messages it produced, without inherited history, so pass `result.new_messages()`.

`RunTree` validates that run IDs are unique, that a `tool_call_id` names exactly one tool call
in its parent run, and that no run is its own ancestor. A run whose parent is not in the run tree is shown as a
top-level run marked "parent not recorded", so a file written while a workflow runs stays
viewable.

## Embed from Python

`render_html` turns a run tree into the same self-contained HTML document that
`paitrace export` writes. It starts no server and writes no file. Show the document in an
iframe, which keeps the viewer's CSS and keyboard shortcuts out of the host page.

In Streamlit:

```python
import streamlit.components.v1 as components

from pydantic_ai_trace import RunTree, render_html

html = render_html(RunTree.from_messages(messages), name="Candidate response")
components.html(html, height=900, scrolling=True)
```

From a Python HTTP server, return the document from its own endpoint and point an iframe at that
URL. For example, with Starlette:

```python
from starlette.responses import HTMLResponse

from pydantic_ai_trace import RunTree, render_html


async def trace_view(request):
    messages = load_messages(request.path_params["run_id"])
    run_tree = RunTree.from_messages(messages)
    return HTMLResponse(render_html(run_tree, name=f"Run {request.path_params['run_id']}"))
```

The document uses inline JavaScript and CSS. Under a strict Content Security Policy, serve it with
a policy that allows them.

## Trace files

Every command reads three JSON shapes:

- A message list: the JSON from `ModelMessagesTypeAdapter.dump_json(messages)`, shown as one run.
- A run tree: the JSON from `RunTree.model_dump_json()`.
- A run capture: an object with the capture's `id` and its `runs`, recorded live by
  instrumentation, with a status, a parent reference of `kind` `trajectory`, `tool_call`, or
  `agent_run`, and the full message history of each run. It is shown as a run tree:
  - Of the attempts that share a `pydantic_run_id`, only the last started is shown; earlier
    attempts and the runs they started are left out.
  - A run shows only its own messages, those whose `run_id` is its `pydantic_run_id`.
  - A run still running, or one without messages of its own, is left out; the runs it started
    show as runs whose parent is not recorded.
  - So a capture loads only once some run has ended with messages, and a retried run stays
    hidden until its latest attempt ends.
  - A failed run's error is not recorded, so it shows as `unknown`.
  - Usage per run, tool call timings, and the capture's `id` are not shown.

A `.json` file holds one trace. A `.jsonl` file holds one trace per line, and each line is its
own trace in the viewer and in `paitrace stats`.

Traces are validated with the installed Pydantic AI. A trace that does not validate is listed
with its first validation error instead. A dump from a newer Pydantic AI may need a newer install;
the error suggests one when a message or part kind is unknown to the installed version.

## Development

Run the API and frontend in separate terminals while working on the viewer.

```bash
pixi run dev-api ./trace.json  # API with reload on port 1205
pixi run dev-web               # Vite with HMR, proxying /api
```

`examples/traces/` holds realistic traces from scripted agent runs: tool retries, structured
output, subagents, a failed run, multimodal input, a 150-step run, and a JSONL eval set. Browse
them with `pixi run paitrace examples/traces`; regenerate them with `pixi run gen-examples`.

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
