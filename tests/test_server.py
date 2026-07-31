import json
import socket
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from pydantic_ai_trace.server import ServerStartError, create_app, serve


def client_for(root: Path) -> TestClient:
    return TestClient(create_app(root))


class TestMeta:
    def test_directory_mode(self, fixtures_copy: Path):
        response = client_for(fixtures_copy).get("/api/meta")
        assert response.json() == {"mode": "dir", "root": "fixtures"}

    def test_file_mode(self, fixtures_copy: Path):
        response = client_for(fixtures_copy / "full_trace.json").get("/api/meta")
        assert response.json() == {"mode": "file", "root": "full_trace.json"}


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
