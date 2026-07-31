from pathlib import Path

import pytest

from pydantic_ai_trace import cli


@pytest.fixture
def serve_captures_app(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Stub the server and the browser so `paitrace PATH` returns immediately."""
    captured: dict = {}

    def fake_serve(root, host, port, on_bound):
        captured.update({"app": root, "root": root, "host": host, "port": port})
        on_bound()

    monkeypatch.setattr("pydantic_ai_trace.server.serve", fake_serve)
    monkeypatch.setattr(
        "threading.Timer", lambda *a, **k: type("T", (), {"start": lambda s: None})()
    )
    return captured


class TestServeCommand:
    def test_serves_existing_directory(self, fixtures_copy: Path, serve_captures_app: dict):
        assert cli.main([str(fixtures_copy), "--no-open"]) == 0
        assert serve_captures_app["port"] == cli.DEFAULT_PORT

    def test_port_and_host_flags_are_forwarded(self, fixtures_copy: Path, serve_captures_app: dict):
        cli.main([str(fixtures_copy), "--port", "9999", "--host", "0.0.0.0", "--no-open"])
        assert serve_captures_app["port"] == 9999
        assert serve_captures_app["host"] == "0.0.0.0"

    def test_missing_path_fails_with_message(self, capsys: pytest.CaptureFixture):
        assert cli.main(["/definitely/not/here"]) == 1
        assert "does not exist" in capsys.readouterr().err

    def test_non_trace_file_is_rejected(self, tmp_path: Path, capsys: pytest.CaptureFixture):
        target = tmp_path / "notes.txt"
        target.write_text("hi")
        assert cli.main([str(target)]) == 1
        assert "expected .json or .jsonl" in capsys.readouterr().err

    def test_busy_port_fails_with_suggestion(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        from pydantic_ai_trace.server import ServerStartError

        def fail_to_bind(root, host, port, on_bound):
            raise ServerStartError(f"cannot bind {host}:{port}")

        monkeypatch.setattr("pydantic_ai_trace.server.serve", fail_to_bind)

        assert cli.main([str(fixtures_copy), "--port", "9999", "--no-open"]) == 1
        assert "--port" in capsys.readouterr().err


class TestExportCommand:
    def test_export_writes_html(
        self, fixtures_copy: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(
            "pydantic_ai_trace.export.export_html",
            lambda inp, out, line: out.write_text("<html>fake</html>"),
        )
        output = tmp_path / "out.html"
        code = cli.main(["export", str(fixtures_copy / "full_trace.json"), "-o", str(output)])
        assert code == 0
        assert output.read_text() == "<html>fake</html>"

    def test_default_output_is_input_with_html_suffix(
        self, fixtures_copy: Path, monkeypatch: pytest.MonkeyPatch
    ):
        written: list[Path] = []
        monkeypatch.setattr(
            "pydantic_ai_trace.export.export_html",
            lambda inp, out, line: written.append(out),
        )
        cli.main(["export", str(fixtures_copy / "full_trace.json")])
        assert written == [fixtures_copy / "full_trace.html"]

    def test_missing_input_fails(self, capsys: pytest.CaptureFixture):
        assert cli.main(["export", "/nope.json"]) == 1
        assert "does not exist" in capsys.readouterr().err

    def test_export_named_path_on_disk_is_served_not_exported(
        self,
        tmp_path: Path,
        serve_captures_app: dict,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.chdir(tmp_path)
        export_dir = tmp_path / "export"
        export_dir.mkdir()
        (export_dir / "t.json").write_text("[]")
        assert cli.main(["export", "--no-open"]) == 0
        assert "app" in serve_captures_app


class TestTextCommand:
    def test_writes_json_trace_to_stdout(self, fixtures_copy: Path, capsys: pytest.CaptureFixture):
        code = cli.main(["text", str(fixtures_copy / "full_trace.json")])
        captured = capsys.readouterr()
        assert code == 0
        assert captured.out == (fixtures_copy / "full_trace.txt").read_text()
        assert captured.err == ""

    def test_selects_jsonl_line(self, fixtures_copy: Path, capsys: pytest.CaptureFixture):
        code = cli.main(["text", str(fixtures_copy / "runs" / "multi.jsonl"), "--line", "2"])
        captured = capsys.readouterr()
        assert code == 0
        assert "NAME: multi.jsonl · trace 2" in captured.out
        assert "hello from line two" in captured.out
        assert "hello from line one" not in captured.out

    def test_multitrace_jsonl_requires_line(
        self, fixtures_copy: Path, capsys: pytest.CaptureFixture
    ):
        code = cli.main(["text", str(fixtures_copy / "runs" / "multi.jsonl")])
        assert code == 1
        assert "pass line 1..2" in capsys.readouterr().err

    def test_output_file_receives_text_without_polluting_stdout(
        self, fixtures_copy: Path, tmp_path: Path, capsys: pytest.CaptureFixture
    ):
        output = tmp_path / "trace.txt"
        code = cli.main(["text", str(fixtures_copy / "full_trace.json"), "--output", str(output)])
        captured = capsys.readouterr()
        assert code == 0
        assert captured.out == ""
        assert captured.err == f"wrote {output}\n"
        assert output.read_text() == (fixtures_copy / "full_trace.txt").read_text()

    def test_missing_input_fails(self, capsys: pytest.CaptureFixture):
        assert cli.main(["text", "/nope.json"]) == 1
        assert "does not exist" in capsys.readouterr().err

    def test_text_named_path_on_disk_is_served_not_formatted(
        self,
        tmp_path: Path,
        serve_captures_app: dict,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.chdir(tmp_path)
        text_dir = tmp_path / "text"
        text_dir.mkdir()
        (text_dir / "t.json").write_text("[]")
        assert cli.main(["text", "--no-open"]) == 0
        assert "app" in serve_captures_app
