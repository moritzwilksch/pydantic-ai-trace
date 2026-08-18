import io
import json
import sys
from pathlib import Path

import pytest

from pydantic_ai_trace import cli


@pytest.fixture
def serve_captures_app(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Stub the server and the browser so `paitrace PATH` returns immediately."""
    captured: dict = {}

    def fake_serve(root, host, port, on_bound):
        captured.update({"app": root, "root": root, "host": host, "port": port})
        if root.is_file():
            captured["trace_text"] = root.read_text(encoding="utf-8")
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

    def test_serves_piped_json_from_a_temporary_file(
        self,
        fixtures_copy: Path,
        serve_captures_app: dict,
        monkeypatch: pytest.MonkeyPatch,
    ):
        trace = (fixtures_copy / "full_trace.json").read_text(encoding="utf-8")
        monkeypatch.setattr(sys, "stdin", io.StringIO(trace))

        assert cli.main(["--no-open"]) == 0
        assert serve_captures_app["root"].name == "stdin.json"
        assert serve_captures_app["trace_text"] == trace
        assert not serve_captures_app["root"].exists()

    def test_serves_piped_jsonl_without_selecting_one_trace(
        self,
        serve_captures_app: dict,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setattr(sys, "stdin", io.StringIO("[]\n[]\n"))

        assert cli.main(["--no-open"]) == 0
        assert serve_captures_app["root"].name == "stdin.jsonl"
        assert serve_captures_app["trace_text"] == "[]\n[]\n"


class TestExportCommand:
    def test_export_writes_html(
        self, fixtures_copy: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(
            "pydantic_ai_trace.export.write_export_html",
            lambda trace_json, out, trace_name: out.write_text("<html>fake</html>"),
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
            "pydantic_ai_trace.export.write_export_html",
            lambda trace_json, out, trace_name: written.append(out),
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

    def test_exports_stdin_when_output_is_explicit(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ):
        captured: dict[str, object] = {}
        monkeypatch.setattr(sys, "stdin", io.StringIO("[]"))
        monkeypatch.setattr(
            "pydantic_ai_trace.export.write_export_html",
            lambda trace_json, out, trace_name: captured.update(
                {"trace": trace_json, "output": out, "name": trace_name}
            ),
        )
        output = tmp_path / "stdin.html"

        assert cli.main(["export", "-o", str(output)]) == 0
        assert captured == {"trace": "[]", "output": output, "name": "stdin"}

    def test_exporting_stdin_requires_output(self, capsys: pytest.CaptureFixture):
        assert cli.main(["export"]) == 1
        assert "--output is required" in capsys.readouterr().err


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

    def test_reads_omitted_input_from_stdin(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        trace = (fixtures_copy / "full_trace.json").read_text(encoding="utf-8")
        monkeypatch.setattr(sys, "stdin", io.StringIO(trace))

        assert cli.main(["text"]) == 0
        assert "NAME: stdin" in capsys.readouterr().out


class TestJsonCommand:
    def test_writes_compact_json_to_stdout(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        assert cli.main(["json", str(fixtures_copy / "full_trace.json")]) == 0
        captured = capsys.readouterr()
        document = json.loads(captured.out)
        assert document["name"] == "full_trace.json"
        assert [message["type"] for message in document["messages"]] == [
            "request",
            "response",
            "request",
            "response",
            "request",
            "response",
        ]
        assert captured.err == ""

    def test_reads_jsonl_line_from_stdin(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        source = (fixtures_copy / "runs" / "multi.jsonl").read_text(encoding="utf-8")
        monkeypatch.setattr(sys, "stdin", io.StringIO(source))

        assert cli.main(["json", "--line", "2"]) == 0
        document = json.loads(capsys.readouterr().out)
        assert document["name"] == "stdin"
        assert document["messages"][0]["parts"][0]["content"] == "hello from line two"

    def test_explicit_dash_reads_stdin(
        self,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setattr(sys, "stdin", io.StringIO("[]"))

        assert cli.main(["json", "-"]) == 0
        assert json.loads(capsys.readouterr().out)["messages"] == []

    def test_omitted_input_on_a_terminal_prints_usage(
        self,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        class TerminalInput(io.StringIO):
            def isatty(self) -> bool:
                return True

        monkeypatch.setattr(sys, "stdin", TerminalInput())

        assert cli.main(["json"]) == 1
        captured = capsys.readouterr()
        assert "usage: paitrace json" in captured.err
        assert "input is required" in captured.err

    def test_directory_error_explains_that_a_trace_file_is_required(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        assert cli.main(["json", str(fixtures_copy)]) == 1
        assert (
            f"expected a .json or .jsonl trace file, got directory: {fixtures_copy}"
            in capsys.readouterr().err
        )

    def test_all_renders_each_jsonl_trace_as_one_output_line(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        source = fixtures_copy / "runs" / "multi.jsonl"

        assert cli.main(["json", str(source), "--all"]) == 0
        captured = capsys.readouterr()
        documents = [json.loads(line) for line in captured.out.splitlines()]
        assert [document["name"] for document in documents] == [
            "multi.jsonl · trace 1",
            "multi.jsonl · trace 2",
        ]
        assert documents[0]["messages"][0]["parts"][0]["content"] == "hello from line one"
        assert documents[1]["messages"][0]["parts"][0]["content"] == "hello from line two"
        assert captured.err == ""

    def test_all_streams_jsonl_from_stdin(
        self,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setattr(sys, "stdin", io.StringIO("[]\n[]\n"))

        assert cli.main(["json", "--all"]) == 0
        documents = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        assert [document["name"] for document in documents] == [
            "stdin · trace 1",
            "stdin · trace 2",
        ]

    def test_all_can_write_compact_jsonl_to_a_file(
        self,
        fixtures_copy: Path,
        tmp_path: Path,
        capsys: pytest.CaptureFixture,
    ):
        source = fixtures_copy / "runs" / "multi.jsonl"
        output = tmp_path / "compact.jsonl"

        assert cli.main(["json", str(source), "--all", "-o", str(output)]) == 0
        assert len(output.read_text(encoding="utf-8").splitlines()) == 2
        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == f"wrote {output}\n"

    @pytest.mark.parametrize(
        ("arguments", "message"),
        [
            (["--all", "--line", "1"], "--all and --line cannot be used together"),
            (["--all", "--pretty"], "--all and --pretty cannot be used together"),
        ],
    )
    def test_all_rejects_incompatible_options(
        self,
        arguments: list[str],
        message: str,
        capsys: pytest.CaptureFixture,
    ):
        assert cli.main(["json", *arguments]) == 1
        assert message in capsys.readouterr().err

    def test_all_requires_jsonl_for_file_input(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        source = fixtures_copy / "full_trace.json"

        assert cli.main(["json", str(source), "--all"]) == 1
        assert f"--all requires .jsonl input: {source}" in capsys.readouterr().err

    def test_all_rejects_overwriting_its_streaming_input(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        source = fixtures_copy / "runs" / "multi.jsonl"
        original = source.read_text(encoding="utf-8")

        assert cli.main(["json", str(source), "--all", "-o", str(source)]) == 1
        assert "--output must differ" in capsys.readouterr().err
        assert source.read_text(encoding="utf-8") == original

    def test_all_does_not_replace_output_when_a_later_trace_is_invalid(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture,
    ):
        source = tmp_path / "broken.jsonl"
        source.write_text("[]\n{}\n", encoding="utf-8")
        output = tmp_path / "compact.jsonl"
        output.write_text("existing output\n", encoding="utf-8")

        assert cli.main(["json", str(source), "--all", "-o", str(output)]) == 1
        assert "line 2" in capsys.readouterr().err
        assert output.read_text(encoding="utf-8") == "existing output\n"

    def test_pretty_indents_single_trace_output(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        source = fixtures_copy / "full_trace.json"

        assert cli.main(["json", str(source), "--pretty"]) == 0
        rendered = capsys.readouterr().out
        assert rendered.startswith('{\n  "name": "full_trace.json",\n')
        assert json.loads(rendered)["stats"]["llm_calls"] == 3
