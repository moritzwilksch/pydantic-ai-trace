import json
from pathlib import Path

import pytest

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

    def test_json_object_instead_of_array_is_400(self, tmp_path: Path):
        (tmp_path / "obj.json").write_text('{"kind": "request"}')
        with pytest.raises(scan.TraceLookupError) as exc_info:
            scan.read_trace(tmp_path, "obj.json", line=None)
        assert exc_info.value.status_code == 400


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
            scan.validate_trace_data("[]\n{}\n", format="jsonl", name="stdin")

    def test_iterates_valid_jsonl_without_buffering_blank_lines_as_traces(self):
        traces = list(scan.iter_jsonl_traces(["\n", "[]\n", "  \n", "[1]\n"], name="runs"))
        assert traces == [(1, "[]\n"), (2, "[1]\n")]

    def test_iterating_empty_jsonl_is_rejected(self):
        with pytest.raises(scan.TraceLookupError, match="contains no traces"):
            list(scan.iter_jsonl_traces(["\n", "  \n"], name="runs"))
