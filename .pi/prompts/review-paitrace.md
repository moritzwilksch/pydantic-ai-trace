---
description: Review a diff, branch, or PR for the few design and implementation violations that matter
argument-hint: "[pr | ref | range] [focus]"
---

Review a change to `paitrace` and report the few problems that will cost the most if merged: wrong behavior, broken invariants, knowledge with two owners, and work that scales badly. Stay read-only. Precision beats coverage: two verified findings beat ten plausible ones, and "no significant findings" is a valid result.

Target: ${1:-the current branch}
Caller focus (blank when none): ${@:2}

Give the caller focus extra depth, and still check every failure class.

## 1. Resolve the target

- PR number: `gh pr view <n>` for intent, `gh pr diff <n>` for the change.
- Branch or ref: `git diff origin/main...<ref>` and `git log origin/main..<ref>`.
- Range (`a..b`, `a...b`): use it as given.
- Current branch: `git diff origin/main...HEAD`, plus uncommitted and untracked files, reported separately.

Use local refs without fetching. State the comparison you used. Read the change's intent (PR description, commit messages); treat tradeoffs it states as settled unless they break an invariant.

## 2. Reconstruct the change

Read `AGENTS.md` and the parts of `README.md` the change touches. `AGENTS.md` owns the invariants; apply them from there. Read every changed file in full, then its callers, its tests, and the existing owner of each concept it touches. Trace each changed contract to its consumers: Pydantic AI types → `analysis.py` → `TracePayload` → `frontend/src/generated/payload.ts` → `runIndex.ts` → components, or loader → renderer → stdout and stderr for the CLI.

This step is done when every changed path is accounted for and each changed behavior has been followed to every consumer.

## 3. Check the failure classes

This codebase has shipped each of these and had to fix it. The example shows what it looked like here.

1. **An `AGENTS.md` invariant broken.** Check every invariant listed there against the diff, including the Pydantic AI verification rules.

2. **Hand-rolled logic where a platform mechanism exists, or a hand-rolled version that is subtly wrong.** Ask what the standard library, the browser, Pydantic, Pydantic AI, or an established tool already provides, and check the custom version against the real semantics. Here: a regex pass that recovered JSON key order restarted inside strings and went quadratic, freezing the viewer for 11 s on a 150-step trace. Pydantic AI dumps binary content as URL-safe base64, but a `data:` URL takes standard base64, so images failed to render. Gitignore-style matching was replaced by asking `git`.

3. **A derived fact computed in both Python and TypeScript.** Python derives, the payload carries, the frontend renders. Flag tool pairing, output-call detection, run ordering, cost, totals, or number and duration formatting that the frontend computes or re-sorts when the payload could carry it, and a change to one layer's copy that leaves the other behind. Here: the frontend test payload builder (`frontend/src/testing/payload.ts`) pairs every part that has a `tool_call_id`, including `tool-availability-delta`, while `analysis.py` pairs only tool returns and retry prompts, so frontend tests can pass on pairings Python never emits.

4. **Work on a hot path that scales with tree or trace size.** The hot paths are directory scans and tree listings, live reload and SSE, loading, and per-render work in the viewer. Here: scanning `node_modules` and ignored directories, validating every trace on each tree listing, a subprocess per refresh, re-parsing on every live-reload event. When a change touches a hot path, require evidence: before and after timings on a large trace or directory. A changed hot path without a measurement is a finding.

5. **A concept with no single owner.** The same formatting, path check, error message, or selection rule implemented at several call sites. Name the owner it belongs in.

6. **Tests that pin the bug or cannot fail.** Expected values must come from the contract, not from current output. Here: a test asserted escaped `\n` in rendered text, encoding the bug as expected behavior. Golden fixtures regenerated in the same change as the code that produces them, with no reviewed diff of what changed. Layout behavior (overflow, wrapping, narrow panes) claimed as verified in jsdom, which does no layout.

7. **Comments that state false rationale.** Check each new comment's claim against the code. Here: "keep the DOM small" on a construct that did not.

8. **CLI contract slips.** Data goes to stdout; status, progress, and errors go to stderr. User-facing errors name the file and the problem in the user's terms, not raw errno text or internal vocabulary such as "trajectory" for a plain message list. Exception handlers catch what they can handle; a catch-all that swallows `BrokenPipeError` (`paitrace json | head`), `KeyboardInterrupt`, or programming errors is a finding.

9. **Reliance on private upstream details.** An underscore name, an internal constant, or undocumented serialization from Pydantic AI or another dependency is acceptable only when documented at the use site, owned in one place, and failing safe when upstream changes.

Then ask whether a shorter design would remove a concept, flag, or layer this change introduced. Report it only as a bounded redesign with the concrete cost it avoids.

## 4. Verify each candidate

- Read the actual lines and their callers at the target revision.
- A bug needs the triggering input or state. Without one, it is a question.
- A structural finding needs the location and the target state, e.g. "move X into `analysis.py` and carry it on the payload".
- A performance finding needs the input size that triggers it. Measure when it is cheap.
- Run a focused test or script when it can confirm or refute the claim. Write scratch files outside the worktree.
- A completion claim backed only by a check that does not exercise the changed path is itself a finding.
- Merge symptoms of one root cause into one finding.

Drop style and naming nits, anything ruff, eslint, prettier, pyright, or tsc catches, risks with no failure scenario, and points the change's intent settled. A defect the change neither introduced nor worsened gets one line under `## Pre-existing` at most.

## 5. Report

Lead with the verdict: `ready`, `needs changes`, or `not fully reviewed`, with the main reason. Then one line naming the comparison and the checks you ran with their results.

List findings by severity, most severe first:

- **high**: wrong output, a crash or freeze, a read outside the configured root, or a broken `AGENTS.md` invariant.
- **medium**: knowledge with two owners, an unmeasured hot-path change, a test that cannot fail, a CLI contract slip, an undocumented private upstream dependency.

Anything below medium is dropped. More than five findings means you are listing symptoms or nits: merge or cut. Write each finding as:

```
### <high|medium>: <short title>
`path:line`
Violates: <invariant or failure class>
Failure: <concrete scenario or cost>
Fix: <bounded repair another coding agent can carry out>
Done when: <checkable condition>
```

After the findings, add only when non-empty: `## Questions` for intent the code cannot settle, `## Pre-existing`, and `## Not checked` for scope or evidence the verdict lacks. With no findings, write the verdict, the checks line, and "No significant findings."

On a re-review, check the previous findings' "Done when" conditions first. Report unresolved findings and regressions from the fixes; a clean pass is a success.
