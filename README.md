# pydantic-ai-trace

Use `pydantic-ai-trace` when you need to inspect an agent run from a JSON dump. Give it a [pydantic-ai](https://ai.pydantic.dev) `list[ModelMessage]` dump and it opens the run in a browser view.

It is a lightweight local tool. Point it at a trace or a directory of traces and it reads the files from disk, reloads them when they change, and exports individual traces as self-contained HTML files. Your traces stay on disk, with no hosted service or account.

<img width="1323" height="1008" alt="Screenshot of a trace open in pydantic-ai-trace" src="https://github.com/user-attachments/assets/cf4f0866-ae4f-449f-8967-1ff6a26a2638" />

## What you can inspect

- The full request and response sequence, including prompts, text, thinking, tool calls, tool results, and unknown parts
- Tool calls paired with their results, including results in later messages
- Model, provider, timing, and token usage
- A searchable directory tree for `.json` and `.jsonl` traces
- Collapsible large values, rendered Markdown, and keyboard navigation

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

# Write one trace to a standalone HTML file
pixi run paitrace export trace.json -o trace.html

# Choose a trace line when exporting a multi-trace JSONL file
pixi run paitrace export runs.jsonl --line 2
```

The viewer binds to `127.0.0.1:1205` and opens your browser. Pass `--port`, `--host`, or `--no-open` to change that behavior.

## Trace files

The viewer reads the JSON emitted by `ModelMessagesTypeAdapter.dump_json(messages)`:

- `.json`: one bare JSON array of `ModelMessage` objects
- `.jsonl`: one such array per line

When you open a directory, each line in a multi-trace `.jsonl` file is available as a separate trace.

## Development

Run the API and frontend in separate terminals while working on the viewer.

```bash
pixi run dev-api ./trace.json  # API with reload on port 1205
pixi run dev-web               # Vite with HMR, proxying /api
```

```bash
pixi run test        # pytest and vitest
pixi run lint        # ruff, prettier, and eslint
pixi run typecheck   # pyright and TypeScript
pixi run build       # bundled frontend plus sdist and wheel
```

## Releasing

Push a `vX.Y.Z` tag. The package version is derived from that tag, so no source file needs a
version bump. GitHub Actions runs the full check suite, builds the frontend into the wheel and
source distribution, publishes both to PyPI using trusted publishing, and creates a GitHub
release. Configure a `pypi` environment in GitHub and add this repository as a trusted publisher
for the `pydantic-ai-trace` project on PyPI before the first release.
