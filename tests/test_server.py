import asyncio
import json
import shutil
import socket
import subprocess
from pathlib import Path

import pytest
from starlette.testclient import TestClient
from traces import minimal_trace

from pydantic_ai_trace import scan
from pydantic_ai_trace.server import (
    ServerStartError,
    _collection_change_events,
    create_app,
    serve,
)


def client_for(root: Path) -> TestClient:
    return TestClient(create_app(root))


class TestMeta:
    def test_directory_mode(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/api/meta")
        assert response.json() == {"mode": "dir", "root": "fixtures"}

    def test_file_mode(self, fixtures_copy: Path):
        response = client_for(fixtures_copy / "full_trace.json").get("/api/meta")
        assert response.json() == {"mode": "file", "root": "full_trace.json"}

    def test_collection_uses_directory_mode(self, fixtures_copy: Path):
        collection = scan.TraceCollection.from_paths(
            [fixtures_copy / "full_trace.json", fixtures_copy / "runs" / "multi.jsonl"]
        )
        response = TestClient(create_app(collection)).get("/api/meta")
        assert response.json() == {"mode": "dir", "root": "selected traces"}


class TestTree:
    def test_returns_tree_for_directory(self, fixtures_copy: Path):
        tree = client_for(fixtures_copy).get("/api/tree").json()
        assert tree["type"] == "dir"
        child_names = {child["name"] for child in tree["children"]}
        assert {"full_trace.json", "broken.json", "runs"} <= child_names

    @pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
    def test_reads_gitignore_on_each_listing(self, tmp_path: Path):
        subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
        (tmp_path / "out").mkdir()
        (tmp_path / "out" / "a.json").write_text(minimal_trace())
        client = client_for(tmp_path)
        assert [child["path"] for child in client.get("/api/tree").json()["children"]] == ["out"]

        (tmp_path / ".gitignore").write_text("out/\n")

        assert client.get("/api/tree").json()["children"] == []

    def test_returns_single_node_for_file(self, fixtures_copy: Path):
        tree = client_for(fixtures_copy / "full_trace.json").get("/api/tree").json()
        assert tree["type"] == "file"
        assert tree["name"] == "full_trace.json"

    def test_collection_tree_contains_only_selected_files(self, fixtures_copy: Path):
        collection = scan.TraceCollection.from_paths(
            [fixtures_copy / "full_trace.json", fixtures_copy / "runs" / "multi.jsonl"]
        )

        tree = TestClient(create_app(collection)).get("/api/tree").json()

        assert tree["name"] == "selected traces"
        assert [child["name"] for child in tree["children"]] == ["runs", "full_trace.json"]


class TestTrace:
    def test_serves_a_message_list_as_a_one_run_payload(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/api/trace", params={"path": "full_trace.json"})
        assert response.status_code == 200
        payload = response.json()
        assert payload["name"] == "full_trace.json"
        [run] = payload["trajectory"]["runs"]
        assert run["id"] == "run"
        assert len(run["messages"]) == 6
        assert payload["analysis"]["totals"]["llm_calls"] == 3
        assert payload["transcript"] == (fixtures_copy / "full_trace.txt").read_text()

    def test_serves_a_trajectory(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/api/trace", params={"path": "trajectory.json"})
        payload = response.json()
        assert [run["name"] for run in payload["trajectory"]["runs"]] == [
            "planner",
            "subagent",
            "worker",
            "summarizer",
        ]

    def test_serves_a_trajectory_from_a_jsonl_line(self, fixtures_copy: Path, tmp_path: Path):
        trajectory = json.dumps(json.loads((fixtures_copy / "trajectory.json").read_text()))
        root = tmp_path / "traces"  # `fixtures_copy` also lives in `tmp_path`
        root.mkdir()
        (root / "runs.jsonl").write_text(f"{minimal_trace()}\n{trajectory}\n")
        client = client_for(root)

        tree = client.get("/api/tree").json()
        payload = client.get("/api/trace", params={"path": "runs.jsonl", "line": 2}).json()

        [node] = tree["children"]
        assert (node["trace_count"], node["error"]) == (2, False)
        assert payload["name"] == "runs.jsonl · trace 2"
        assert len(payload["trajectory"]["runs"]) == 4

    def test_an_out_of_range_number_is_400_not_500(self, tmp_path: Path):
        trace = json.loads(minimal_trace())
        trace[1]["parts"] = [
            {"part_kind": "tool-call", "tool_name": "t", "args": {"x": 0}, "tool_call_id": "c"}
        ]
        text = json.dumps(trace).replace('{"x": 0}', '{"x": 1e400}')
        (tmp_path / "huge.json").write_text(text)

        response = client_for(tmp_path).get("/api/trace", params={"path": "huge.json"})

        assert response.status_code == 400
        assert "number out of range: 1e400" in response.json()["error"]

    def test_invalid_trace_is_400_with_the_validation_error(self, tmp_path: Path):
        (tmp_path / "bad.json").write_text('[{"kind": "telepathy", "parts": []}]')

        response = client_for(tmp_path).get("/api/trace", params={"path": "bad.json"})

        assert response.status_code == 400
        assert response.json()["error"].startswith("bad.json: 0: Input tag 'telepathy'")

    def test_invalid_trace_error_lists_every_validation_error(self, tmp_path: Path):
        (tmp_path / "bad.json").write_text('{"runs": [{"name": "r"}]}')

        response = client_for(tmp_path).get("/api/trace", params={"path": "bad.json"})

        body = response.json()
        assert response.status_code == 400
        assert len(body["details"]) > 1
        assert body["error"] == f"bad.json: {body['details'][0]} (+{len(body['details']) - 1} more)"

    def test_json_that_is_not_a_trace_is_400_in_plain_words(self, tmp_path: Path):
        (tmp_path / "package.json").write_text('{"name": "app"}')

        response = client_for(tmp_path / "package.json").get(
            "/api/trace", params={"path": "package.json"}
        )

        assert response.status_code == 400
        assert response.json()["error"].startswith("package.json: not a trace: ")

    def test_invalid_later_jsonl_trace_is_400_when_opened(self, tmp_path: Path):
        (tmp_path / "log.jsonl").write_text(f'{minimal_trace()}\n[{{"kind": "telepathy"}}]\n')

        response = client_for(tmp_path).get("/api/trace", params={"path": "log.jsonl", "line": 2})

        assert response.status_code == 400
        assert "Input tag 'telepathy'" in response.json()["error"]

    def test_serves_selected_jsonl_line(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get(
            "/api/trace", params={"path": "runs/multi.jsonl", "line": 2}
        )
        payload = response.json()
        assert payload["name"] == "runs/multi.jsonl · trace 2"
        assert "NAME: runs/multi.jsonl · trace 2" in payload["transcript"]

    def test_escapes_lone_surrogates_in_transcript(self, tmp_path: Path):
        trace = (
            r'[{"kind":"request","parts":[{"part_kind":"user-prompt","content":"\ud800",'
            r'"timestamp":"2026-01-01T00:00:00Z"}]}]'
        )
        (tmp_path / "surrogate.json").write_text(trace, encoding="utf-8")

        response = client_for(tmp_path).get("/api/trace", params={"path": "surrogate.json"})

        assert response.status_code == 200
        assert b"\\ud800" in response.content
        assert "\ud800" in response.json()["transcript"]

    def test_file_mode_serves_the_root_file(self, fixtures_copy: Path):
        client = client_for(fixtures_copy / "full_trace.json")
        response = client.get("/api/trace", params={"path": "full_trace.json"})
        assert response.status_code == 200

    def test_file_mode_does_not_expose_siblings(self, fixtures_copy: Path):
        client = client_for(fixtures_copy / "runs" / "media_and_builtins.json")
        sibling = client.get("/api/trace", params={"path": "multi.jsonl", "line": 1})
        assert sibling.status_code == 404
        escape = client.get("/api/trace", params={"path": "../full_trace.json"})
        assert escape.status_code == 404

    def test_missing_file_is_404(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/api/trace", params={"path": "ghost.json"})
        assert response.status_code == 404

    def test_traversal_attempt_is_400(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/api/trace", params={"path": "../../etc/passwd"})
        assert response.status_code == 400

    def test_non_numeric_line_is_400(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get(
            "/api/trace", params={"path": "runs/multi.jsonl", "line": "abc"}
        )
        assert response.status_code == 400

    def test_broken_file_is_400_with_message(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/api/trace", params={"path": "broken.json"})
        assert response.status_code == 400
        assert "broken.json" in response.json()["error"]

    def test_collection_serves_selected_file_and_denies_sibling(self, fixtures_copy: Path):
        collection = scan.TraceCollection.from_paths(
            [fixtures_copy / "full_trace.json", fixtures_copy / "runs" / "multi.jsonl"]
        )
        client = TestClient(create_app(collection))

        selected = client.get("/api/trace", params={"path": "full_trace.json"})
        selected_jsonl = client.get("/api/trace", params={"path": "runs/multi.jsonl", "line": 2})
        sibling = client.get("/api/trace", params={"path": "broken.json"})

        assert selected.status_code == 200
        assert selected_jsonl.status_code == 200
        assert "hello from line two" in selected_jsonl.json()["transcript"]
        assert sibling.status_code == 404


class TestSelectedFileReplacedBySymlink:
    """A selected file swapped for a symlink out of the root is neither read nor served."""

    @pytest.fixture
    def outside(self, tmp_path: Path) -> Path:
        outside = tmp_path / "outside.json"
        outside.write_text(minimal_trace("outside secret"), encoding="utf-8")
        return outside

    def test_file_mode(self, tmp_path: Path, outside: Path):
        root = tmp_path / "root"
        root.mkdir()
        selected = root / "selected.json"
        selected.write_text(minimal_trace("inside"), encoding="utf-8")
        client = client_for(selected)
        _replace_with_symlink(selected, outside)

        tree = client.get("/api/tree")
        trace = client.get("/api/trace", params={"path": "selected.json"})

        assert "outside secret" not in tree.text
        assert tree.json()["error"] is True
        assert "escapes root" in tree.json()["error_message"]
        assert trace.status_code == 400
        assert "outside secret" not in trace.text

    def test_collection(self, tmp_path: Path, outside: Path):
        root = tmp_path / "root"
        root.mkdir()
        selected = root / "selected.json"
        selected.write_text(minimal_trace("inside"), encoding="utf-8")
        kept = root / "kept.jsonl"
        kept.write_text(minimal_trace("kept") + "\n", encoding="utf-8")
        client = TestClient(create_app(scan.TraceCollection.from_paths([selected, kept])))
        _replace_with_symlink(selected, outside)

        tree = client.get("/api/tree")
        trace = client.get("/api/trace", params={"path": "selected.json"})

        nodes = {child["path"]: child for child in tree.json()["children"]}
        assert "outside secret" not in tree.text
        assert nodes["selected.json"]["error"] is True
        assert "escapes root" in nodes["selected.json"]["error_message"]
        assert nodes["kept.jsonl"]["traces"][0]["prompt"] == "kept"
        assert trace.status_code == 400
        assert "outside secret" not in trace.text


def _replace_with_symlink(path: Path, target: Path) -> None:
    path.unlink()
    try:
        path.symlink_to(target)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable: {exc}")


def test_collection_changes_only_report_selected_files(
    fixtures_copy: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    collection = scan.TraceCollection.from_paths(
        [fixtures_copy / "full_trace.json", fixtures_copy / "runs" / "multi.jsonl"]
    )

    async def fake_awatch(*paths, **kwargs):
        yield {
            (object(), str(fixtures_copy / "full_trace.json")),
            (object(), str(fixtures_copy / "broken.json")),
        }

    monkeypatch.setattr("watchfiles.awatch", fake_awatch)

    async def read_events():
        events = _collection_change_events(collection, stop_event=None)
        retry = await anext(events)
        changed = await anext(events)
        await events.aclose()
        return retry, changed

    retry, changed = asyncio.run(read_events())

    assert retry == "retry: 1000\n\n"
    assert json.loads(changed.removeprefix("data: ")) == {
        "type": "changed",
        "paths": ["full_trace.json"],
    }


class TestIndex:
    def test_serves_html(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]


def test_server_bind_failure_does_not_report_started(fixtures_copy: Path):
    started = False

    def on_bound(port: int):
        nonlocal started
        started = True

    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        port = blocker.getsockname()[1]

        with pytest.raises(ServerStartError):
            serve(fixtures_copy, host="127.0.0.1", ports=[port], on_bound=on_bound)

    assert started is False
