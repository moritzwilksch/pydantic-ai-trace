import asyncio
import json
import socket
from pathlib import Path

import pytest
from starlette.testclient import TestClient

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
    def test_serves_file_bytes_verbatim(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/api/trace", params={"path": "full_trace.json"})
        assert response.status_code == 200
        payload = response.json()
        assert payload["source"] == (fixtures_copy / "full_trace.json").read_text()
        assert payload["transcript"] == (fixtures_copy / "full_trace.txt").read_text()

    def test_serves_selected_jsonl_line(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get(
            "/api/trace", params={"path": "runs/multi.jsonl", "line": 2}
        )
        payload = response.json()
        assert "trace two" in payload["source"]
        assert isinstance(json.loads(payload["source"]), list)
        assert "NAME: runs/multi.jsonl · trace 2" in payload["transcript"]

    def test_escapes_lone_surrogates_in_transcript(self, tmp_path: Path):
        trace = r'[{"kind":"request","parts":[{"part_kind":"user-prompt","content":"\ud800"}]}]'
        (tmp_path / "surrogate.json").write_text(trace, encoding="utf-8")

        response = client_for(tmp_path).get("/api/trace", params={"path": "surrogate.json"})

        assert response.status_code == 200
        assert b"\\ud800" in response.content
        assert response.json()["source"] == trace
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

    def on_bound():
        nonlocal started
        started = True

    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        port = blocker.getsockname()[1]

        with pytest.raises(ServerStartError):
            serve(fixtures_copy, host="127.0.0.1", port=port, on_bound=on_bound)

    assert started is False
