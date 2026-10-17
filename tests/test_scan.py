import json
import shutil
import subprocess
from pathlib import Path

import pytest
from traces import minimal_trace

from pydantic_ai_trace import scan


def find_node(tree: dict, path: str) -> dict:
    """Return the node at `path`, failing the test if it is missing."""
    node = _search(tree, path)
    assert node is not None, f"node not found in tree: {path}"
    return node


def _search(tree: dict, path: str) -> dict | None:
    if tree.get("path") == path:
        return tree
    for child in tree.get("children", []):
        if (found := _search(child, path)) is not None:
            return found
    return None


class TestResolveWithin:
    def test_resolves_nested_relative_paths(self, tmp_path: Path):
        (tmp_path / "a").mkdir()
        (tmp_path / "a" / "t.json").write_text("[]")
        assert scan.resolve_within(tmp_path, "a/t.json") == tmp_path / "a" / "t.json"

    @pytest.mark.parametrize("bad", ["../secret.json", "a/../../secret.json", "/etc/passwd", ""])
    def test_rejects_paths_escaping_root(self, tmp_path: Path, bad: str):
        with pytest.raises(scan.TraceLookupError) as exc_info:
            scan.resolve_within(tmp_path, bad)
        assert exc_info.value.status_code == 400


class TestBuildTree:
    def test_directory_tree_mirrors_filesystem(self, fixtures_copy: Path):
        tree = scan.build_tree(fixtures_copy)
        assert tree["type"] == "dir"
        assert find_node(tree, "full_trace.json")["format"] == "json"
        assert find_node(tree, "runs")["type"] == "dir"
        assert find_node(tree, "runs/multi.jsonl")["trace_count"] == 2

    def test_broken_file_is_flagged_not_hidden(self, fixtures_copy: Path):
        tree = scan.build_tree(fixtures_copy)
        broken = find_node(tree, "broken.json")
        assert broken["error"] is True
        assert "not valid JSON" in broken["error_message"]
        assert find_node(tree, "full_trace.json")["error"] is False

    def test_jsonl_flags_each_invalid_trace_not_the_file(self, tmp_path: Path):
        (tmp_path / "log.jsonl").write_text(
            f'{minimal_trace()}\n\n[{{"kind": "telepathy"}}]\n{minimal_trace()}\n'
        )
        node = scan.build_tree(tmp_path / "log.jsonl")
        assert (node["trace_count"], node["error"]) == (3, False)
        assert [trace["error"] for trace in node["traces"]] == [False, True, False]
        assert node["traces"][1]["line"] == 2
        assert node["traces"][1]["error_message"]

    def test_jsonl_with_one_invalid_trace_is_flagged(self, tmp_path: Path):
        (tmp_path / "log.jsonl").write_text('[{"kind": "telepathy"}]\n')
        node = scan.build_tree(tmp_path / "log.jsonl")
        assert (node["trace_count"], node["error"]) == (1, True)
        assert node["error_message"].startswith("line 1: ")

    def test_traces_are_summarized_by_prompt_answer_and_models(self, tmp_path: Path):
        long_prompt = "What is\n  the capital " + "of Australia " * 30
        second_trace = minimal_trace(model_name="gpt-5-nano")
        (tmp_path / "log.jsonl").write_text(f"{minimal_trace(long_prompt)}\n{second_trace}\n")
        node = scan.build_tree(tmp_path / "log.jsonl")
        first, second = node["traces"]
        assert first["prompt"].startswith("What is the capital of Australia of")
        assert first["prompt"].endswith("…")
        assert len(first["prompt"]) == scan.PREVIEW_CHARS
        assert (first["models"], second["models"]) == ([], ["gpt-5-nano"])
        assert (second["line"], second["prompt"], second["answer"]) == (2, "hello", "ok")

    def test_trajectory_summary_takes_the_first_run_prompt(self, fixtures_copy: Path):
        [trace] = scan.build_tree(fixtures_copy / "trajectory.json")["traces"]
        assert (trace["prompt"], trace["models"]) == ("Plan the task.", ["gpt-4o"])
        assert trace["answer"] == "summary"

    def test_directory_scan_leaves_out_json_that_is_not_a_trace(self, tmp_path: Path):
        (tmp_path / "app").mkdir()
        (tmp_path / "app" / "package.json").write_text('{"name": "app"}')
        (tmp_path / "events.jsonl").write_text('{"event": "start"}\n')
        (tmp_path / "broken.json").write_text('{"runs": []}')
        (tmp_path / "good.json").write_text(minimal_trace())

        tree = scan.build_tree(tmp_path)

        assert [child["path"] for child in tree["children"]] == ["broken.json", "good.json"]
        assert find_node(tree, "broken.json")["error"] is True

    def test_named_file_that_is_not_a_trace_says_so(self, tmp_path: Path):
        (tmp_path / "package.json").write_text('{"name": "app"}')
        (tmp_path / "events.jsonl").write_text('{"event": "start"}\n')
        collection = scan.TraceCollection.from_paths(
            [tmp_path / "package.json", tmp_path / "events.jsonl"]
        )

        single = scan.build_tree(tmp_path / "package.json")
        selected = scan.build_collection_tree(collection)

        assert single["error"] is True
        assert single["error_message"].startswith("not a trace: ")
        assert find_node(selected, "events.jsonl")["error_message"].startswith(
            "line 1: not a trace: "
        )

    def test_single_file_root_yields_single_node(self, fixtures_copy: Path):
        tree = scan.build_tree(fixtures_copy / "full_trace.json")
        assert tree["type"] == "file"
        assert tree["trace_count"] == 1

    def test_directories_sort_before_files(self, fixtures_copy: Path):
        names = [child["type"] for child in scan.build_tree(fixtures_copy)["children"]]
        assert names == sorted(names, key=lambda t: t != "dir")

    def test_dirs_without_traces_are_pruned(self, tmp_path: Path):
        (tmp_path / "empty").mkdir()
        (tmp_path / "t.json").write_text("[]")
        tree = scan.build_tree(tmp_path)
        assert [child["name"] for child in tree["children"]] == ["t.json"]

    def test_hidden_and_foreign_files_are_ignored(self, tmp_path: Path):
        (tmp_path / ".hidden.json").write_text("[]")
        (tmp_path / "notes.txt").write_text("hi")
        (tmp_path / "t.json").write_text("[]")
        tree = scan.build_tree(tmp_path)
        assert [child["name"] for child in tree["children"]] == ["t.json"]

    def test_symlinks_are_not_followed_or_read(self, tmp_path: Path):
        outside = tmp_path.parent / f"{tmp_path.name}-outside"
        outside.mkdir()
        (outside / "secret.json").write_text("[]")
        try:
            (tmp_path / "linked-dir").symlink_to(outside, target_is_directory=True)
            (tmp_path / "linked.json").symlink_to(outside / "secret.json")
        except OSError as exc:
            pytest.skip(f"symlinks unavailable: {exc}")

        tree = scan.build_tree(tmp_path)

        assert tree["children"] == []


class TestReadTrace:
    def test_json_file_returns_raw_bytes(self, fixtures_copy: Path):
        original = (fixtures_copy / "full_trace.json").read_text()
        assert scan.read_trace(fixtures_copy, "full_trace.json", line=None) == original

    def test_jsonl_line_selection_is_one_based(self, fixtures_copy: Path):
        second = scan.read_trace(fixtures_copy, "runs/multi.jsonl", line=2)
        assert "trace two" in second
        assert isinstance(json.loads(second), list)

    def test_multiline_jsonl_without_line_is_rejected(self, fixtures_copy: Path):
        with pytest.raises(scan.TraceLookupError) as exc_info:
            scan.read_trace(fixtures_copy, "runs/multi.jsonl", line=None)
        assert exc_info.value.status_code == 400

    def test_jsonl_selection_stops_reading_at_the_requested_line(self, tmp_path: Path):
        # Undecodable bytes far past line 1 prove the rest of the file is never read.
        log = b"[]\n" + b"[1]\n" * 100_000 + b"\xff\n"
        (tmp_path / "big.jsonl").write_bytes(log)
        assert scan.read_trace(tmp_path, "big.jsonl", line=1) == "[]"

    def test_single_line_jsonl_defaults_to_its_only_trace(self, tmp_path: Path):
        (tmp_path / "one.jsonl").write_text('[{"kind": "request", "parts": []}]\n')
        assert "request" in scan.read_trace(tmp_path, "one.jsonl", line=None)

    @pytest.mark.parametrize("line", [0, 3, -1])
    def test_out_of_range_line_is_rejected(self, fixtures_copy: Path, line: int):
        with pytest.raises(scan.TraceLookupError):
            scan.read_trace(fixtures_copy, "runs/multi.jsonl", line=line)

    def test_missing_file_is_404(self, fixtures_copy: Path):
        with pytest.raises(scan.TraceLookupError) as exc_info:
            scan.read_trace(fixtures_copy, "nope.json", line=None)
        assert exc_info.value.status_code == 404

    def test_non_trace_extension_is_404(self, fixtures_copy: Path):
        (fixtures_copy / "secrets.txt").write_text("[]")
        with pytest.raises(scan.TraceLookupError) as exc_info:
            scan.read_trace(fixtures_copy, "secrets.txt", line=None)
        assert exc_info.value.status_code == 404

    def test_unparseable_json_is_400(self, fixtures_copy: Path):
        with pytest.raises(scan.TraceLookupError) as exc_info:
            scan.read_trace(fixtures_copy, "broken.json", line=None)
        assert exc_info.value.status_code == 400

    def test_json_scalar_is_400(self, tmp_path: Path):
        (tmp_path / "scalar.json").write_text('"request"')
        with pytest.raises(scan.TraceLookupError) as exc_info:
            scan.read_trace(tmp_path, "scalar.json", line=None)
        assert exc_info.value.status_code == 400


class TestTraceCollection:
    def test_tree_contains_only_selected_files(self, fixtures_copy: Path):
        collection = scan.TraceCollection.from_paths(
            [
                fixtures_copy / "full_trace.json",
                fixtures_copy / "runs" / "multi.jsonl",
            ]
        )

        tree = scan.build_collection_tree(collection)

        assert tree["name"] == "selected traces"
        assert find_node(tree, "full_trace.json")["format"] == "json"
        assert find_node(tree, "runs/multi.jsonl")["trace_count"] == 2
        assert _search(tree, "broken.json") is None
        assert _search(tree, "runs/media_and_builtins.json") is None

    def test_reads_selected_file_and_rejects_sibling(self, fixtures_copy: Path):
        collection = scan.TraceCollection.from_paths(
            [
                fixtures_copy / "full_trace.json",
                fixtures_copy / "runs" / "multi.jsonl",
            ]
        )

        assert "precise research assistant" in scan.read_collection_trace(
            collection, "full_trace.json", line=None
        )
        with pytest.raises(scan.TraceLookupError) as exc_info:
            scan.read_collection_trace(collection, "broken.json", line=None)
        assert exc_info.value.status_code == 404

    def test_duplicate_resolved_paths_are_rejected(self, fixtures_copy: Path):
        path = fixtures_copy / "full_trace.json"
        with pytest.raises(ValueError, match="duplicate"):
            scan.TraceCollection.from_paths([path, path])


class TestInMemoryTraceData:
    def test_detects_complete_json_before_jsonl(self):
        assert scan.detect_trace_format('[\n  {"kind": "request", "parts": []}\n]') == "json"
        assert scan.detect_trace_format("[]\n[]\n") == "jsonl"

    def test_selects_one_based_jsonl_line(self):
        selected = scan.select_trace(
            '[]\n[{"kind":"request","parts":[]}]\n',
            format="jsonl",
            name="stdin",
            line=2,
        )
        assert json.loads(selected)[0]["kind"] == "request"

    def test_validates_every_jsonl_trace(self):
        with pytest.raises(scan.TraceLookupError, match="line 2"):
            scan.validate_trace_data("[]\n1\n", format="jsonl", name="stdin")

    def test_iterates_valid_jsonl_without_buffering_blank_lines_as_traces(self):
        traces = list(scan.iter_jsonl_traces(["\n", "[]\n", "  \n", "[1]\n"], name="runs"))
        assert traces == [(1, "[]"), (2, "[1]")]

    def test_jsonl_line_keeps_an_unescaped_line_separator_in_a_string(self):
        traces = list(scan.iter_jsonl_traces(['["a\u2028b"]\n[]\n'], name="runs"))
        assert traces == [(1, '["a\u2028b"]'), (2, "[]")]

    def test_iterating_empty_jsonl_is_rejected(self):
        with pytest.raises(scan.TraceLookupError, match="contains no traces"):
            list(scan.iter_jsonl_traces(["\n", "  \n"], name="runs"))


needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")


def git_repo(path: Path, gitignore: str) -> Path:
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    (path / ".gitignore").write_text(gitignore)
    return path


def write_traces(root: Path, *relative_paths: str) -> None:
    for relative_path in relative_paths:
        (root / relative_path).parent.mkdir(parents=True, exist_ok=True)
        (root / relative_path).write_text(minimal_trace())


def tree_paths(root: Path) -> list[str]:
    return [
        str(file.relative_to(root))
        for file in scan.iter_trace_files(root, ignored=scan.git_ignored(root))
    ]


class TestScanExclusions:
    @needs_git
    def test_skips_what_git_ignores(self, tmp_path: Path):
        root = git_repo(tmp_path, "out/\n*.tmp.json\n")
        write_traces(root, "out/a.json", "keep/b.json", "keep/c.tmp.json")

        tree = scan.build_tree(root, ignored=scan.git_ignored(root))

        assert [child["path"] for child in tree["children"]] == ["keep"]
        assert tree_paths(root) == ["keep/b.json"]

    def test_skips_vendored_and_build_directories_without_git(self, tmp_path: Path):
        write_traces(tmp_path, "node_modules/pkg/a.json", "build/b.json", ".venv/c.json", "d.json")

        assert scan.git_ignored(tmp_path) == frozenset()
        assert tree_paths(tmp_path) == ["d.json"]

    @needs_git
    def test_skips_vendored_directories_that_git_does_not_ignore(self, tmp_path: Path):
        root = git_repo(tmp_path, "")
        write_traces(root, "node_modules/a.json", "b.json")

        assert tree_paths(root) == ["b.json"]

    @needs_git
    def test_reads_an_explicitly_named_ignored_directory(self, tmp_path: Path):
        root = git_repo(tmp_path, "out/\n")
        write_traces(root, "out/a.json", "node_modules/pkg/b.json")

        assert tree_paths(root / "out") == ["a.json"]
        assert tree_paths(root / "node_modules" / "pkg") == ["b.json"]
