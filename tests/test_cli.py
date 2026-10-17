import io
import json
import socket
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from traces import minimal_trace

from pydantic_ai_trace import cli, scan


@pytest.fixture
def serve_captures_app(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Stub the server and the browser so `paitrace PATH` returns immediately."""
    captured: dict = {}

    def fake_serve(root, host, ports, on_bound):
        captured.update({"app": root, "root": root, "host": host, "ports": ports})
        if isinstance(root, Path) and root.is_file():
            captured["trace_text"] = root.read_text(encoding="utf-8")
        on_bound(ports[0])

    monkeypatch.setattr("pydantic_ai_trace.server.serve", fake_serve)
    monkeypatch.setattr(
        "threading.Timer", lambda *a, **k: type("T", (), {"start": lambda s: None})()
    )
    return captured


@pytest.fixture
def busy_port() -> Iterator[int]:
    """A loopback port another socket is listening on."""
    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        yield blocker.getsockname()[1]


class TestServeCommand:
    def test_serves_existing_directory(self, fixtures_copy: Path, serve_captures_app: dict):
        assert cli.main([str(fixtures_copy), "--no-open"]) == 0
        assert serve_captures_app["ports"] == [cli.DEFAULT_PORT, 0]

    def test_port_and_host_flags_are_forwarded(self, fixtures_copy: Path, serve_captures_app: dict):
        cli.main([str(fixtures_copy), "--port", "9999", "--host", "0.0.0.0", "--no-open"])
        assert serve_captures_app["ports"] == [9999]
        assert serve_captures_app["host"] == "0.0.0.0"

    @pytest.mark.parametrize(("host", "warned"), [("0.0.0.0", True), ("127.0.0.1", False)])
    def test_warns_when_serving_beyond_loopback(
        self,
        fixtures_copy: Path,
        serve_captures_app: dict,
        capsys: pytest.CaptureFixture,
        host: str,
        warned: bool,
    ):
        cli.main([str(fixtures_copy), "--host", host, "--no-open"])
        assert ("without authentication" in capsys.readouterr().err) is warned

    def test_missing_path_fails_with_message(self, capsys: pytest.CaptureFixture):
        assert cli.main(["/definitely/not/here"]) == 1
        assert "does not exist" in capsys.readouterr().err

    def test_non_trace_file_is_rejected(self, tmp_path: Path, capsys: pytest.CaptureFixture):
        target = tmp_path / "notes.txt"
        target.write_text("hi")
        assert cli.main([str(target)]) == 1
        assert "expected .json or .jsonl" in capsys.readouterr().err

    def test_busy_explicit_port_fails_with_one_line_error(
        self,
        fixtures_copy: Path,
        busy_port: int,
        capsys: pytest.CaptureFixture,
    ):
        assert cli.main([str(fixtures_copy), "--port", str(busy_port), "--no-open"]) == 1
        captured = capsys.readouterr()
        assert captured.err == (
            f"error: cannot bind 127.0.0.1:{busy_port}: Address already in use; "
            "pick another port with --port\n"
        )

    def test_busy_default_port_falls_back_to_a_free_port(
        self,
        fixtures_copy: Path,
        busy_port: int,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        import uvicorn

        bound: list[int] = []

        def record_port(server: uvicorn.Server, sockets: list[socket.socket]) -> None:
            bound.append(sockets[0].getsockname()[1])
            sockets[0].close()

        monkeypatch.setattr(cli, "DEFAULT_PORT", busy_port)
        monkeypatch.setattr(uvicorn.Server, "run", record_port)

        assert cli.main([str(fixtures_copy), "--no-open"]) == 0
        [port] = bound
        assert port != busy_port
        assert f"http://127.0.0.1:{port}/" in capsys.readouterr().err

    def test_bare_command_on_a_terminal_prints_help(
        self,
        serve_captures_app: dict,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        class TerminalInput(io.StringIO):
            def isatty(self) -> bool:
                return True

        monkeypatch.setattr(sys, "stdin", TerminalInput())

        assert cli.main([]) == 0
        assert "Browse Pydantic AI traces" in capsys.readouterr().out
        assert serve_captures_app == {}

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

    def test_serves_multiple_files_as_an_explicit_collection(
        self,
        fixtures_copy: Path,
        serve_captures_app: dict,
    ):
        first = fixtures_copy / "full_trace.json"
        second = fixtures_copy / "runs" / "multi.jsonl"

        assert cli.main([str(first), str(second), "--no-open"]) == 0

        collection = serve_captures_app["root"]
        assert isinstance(collection, scan.TraceCollection)
        assert [item.key for item in collection.files] == [
            "full_trace.json",
            "runs/multi.jsonl",
        ]

    def test_multiple_viewer_inputs_reject_directories(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        trace = fixtures_copy / "full_trace.json"

        assert cli.main([str(trace), str(fixtures_copy), "--no-open"]) == 1
        assert "got directory" in capsys.readouterr().err


@pytest.mark.parametrize("command", ["export", "text", "json"])
@pytest.mark.parametrize("alias", ["dotdot", "symlink"])
def test_output_naming_the_input_file_is_refused(
    command: str, alias: str, fixtures_copy: Path, capsys: pytest.CaptureFixture
):
    source = fixtures_copy / "full_trace.json"
    original = source.read_text(encoding="utf-8")
    if alias == "dotdot":
        output = fixtures_copy / "runs" / ".." / "full_trace.json"
    else:
        output = fixtures_copy / "link.json"
        output.symlink_to(source)

    assert cli.main([command, str(source), "-o", str(output)]) == 1
    assert "--output must differ from the input" in capsys.readouterr().err
    assert source.read_text(encoding="utf-8") == original


class TestExportCommand:
    @pytest.fixture(autouse=True)
    def _stub_bundle(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import pydantic_ai_trace._html as html_module

        monkeypatch.setattr(
            html_module,
            "packaged_index_html",
            lambda: "<html><head><script>bundle();</script></head></html>",
        )

    def test_export_writes_selfcontained_html(self, fixtures_copy: Path, tmp_path: Path):
        output = tmp_path / "out.html"
        code = cli.main(["export", str(fixtures_copy / "full_trace.json"), "-o", str(output)])
        assert code == 0
        document = output.read_text(encoding="utf-8")
        assert "__TRACE_PAYLOAD__" in document
        assert document.index("__TRACE_PAYLOAD__") < document.index("bundle();")

    def test_default_output_is_input_with_html_suffix(
        self, fixtures_copy: Path, capsys: pytest.CaptureFixture
    ):
        cli.main(["export", str(fixtures_copy / "full_trace.json")])
        output = fixtures_copy / "full_trace.html"
        assert output.exists()
        assert capsys.readouterr() == ("", f"wrote {output}\n")

    def test_invalid_trace_is_not_exported(self, tmp_path: Path, capsys: pytest.CaptureFixture):
        source = tmp_path / "nan.json"
        source.write_text('[{"cost": NaN}]')
        output = tmp_path / "nan.html"

        assert cli.main(["export", str(source), "-o", str(output)]) == 1
        assert "non-standard JSON constant" in capsys.readouterr().err
        assert not output.exists()

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
        monkeypatch.setattr(sys, "stdin", io.StringIO(minimal_trace()))
        output = tmp_path / "stdin.html"

        assert cli.main(["export", "-o", str(output)]) == 0
        document = output.read_text(encoding="utf-8")
        assert 'window.__TRACE_PAYLOAD__ = "{\\"name\\":\\"stdin\\"' in document

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
        assert [message["type"] for message in document["runs"][0]["messages"]] == [
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
        assert document["runs"][0]["messages"][0]["parts"][0]["content"] == "hello from line two"

    def test_explicit_dash_reads_stdin(
        self,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setattr(sys, "stdin", io.StringIO(minimal_trace()))

        assert cli.main(["json", "-"]) == 0
        assert json.loads(capsys.readouterr().out)["name"] == "stdin"

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
        assert (
            documents[0]["runs"][0]["messages"][0]["parts"][0]["content"] == "hello from line one"
        )
        assert (
            documents[1]["runs"][0]["messages"][0]["parts"][0]["content"] == "hello from line two"
        )
        assert captured.err == ""

    def test_all_renders_trajectory_lines_alongside_message_lists(
        self,
        fixtures_copy: Path,
        tmp_path: Path,
        capsys: pytest.CaptureFixture,
    ):
        trajectory = json.dumps(json.loads((fixtures_copy / "trajectory.json").read_text()))
        source = tmp_path / "mixed.jsonl"
        source.write_text(f"{trajectory}\n{minimal_trace()}\n", encoding="utf-8")

        assert cli.main(["json", str(source), "--all"]) == 0

        documents = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        assert [[run["name"] for run in document["runs"]] for document in documents] == [
            ["planner", "subagent", "worker", "summarizer"],
            ["mixed.jsonl · trace 2"],
        ]

    def test_all_streams_jsonl_from_stdin(
        self,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setattr(sys, "stdin", io.StringIO(f"{minimal_trace()}\n{minimal_trace()}\n"))

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

    def test_all_accepts_one_json_file_as_a_one_record_batch(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        source = fixtures_copy / "full_trace.json"

        assert cli.main(["json", str(source), "--all"]) == 0
        documents = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        assert [document["name"] for document in documents] == ["full_trace.json"]

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
        source.write_text(f"{minimal_trace()}\n{{}}\n", encoding="utf-8")
        output = tmp_path / "compact.jsonl"
        output.write_text("existing output\n", encoding="utf-8")

        assert cli.main(["json", str(source), "--all", "-o", str(output)]) == 1
        assert "broken.jsonl · trace 2: runs: Field required" in capsys.readouterr().err
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

    def test_multiple_json_files_emit_compact_jsonl(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        first = fixtures_copy / "full_trace.json"
        second = fixtures_copy / "text_edge_cases.json"

        assert cli.main(["json", str(first), str(second)]) == 0

        documents = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        assert [document["name"] for document in documents] == [
            "full_trace.json",
            "text_edge_cases.json",
        ]

    def test_multiple_files_with_the_same_basename_keep_relative_names(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture,
    ):
        first = tmp_path / "a" / "run.json"
        second = tmp_path / "b" / "run.json"
        first.parent.mkdir()
        second.parent.mkdir()
        first.write_text(minimal_trace(), encoding="utf-8")
        second.write_text(minimal_trace(), encoding="utf-8")

        assert cli.main(["json", str(first), str(second)]) == 0

        documents = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        assert [document["name"] for document in documents] == ["a/run.json", "b/run.json"]

    def test_multiple_inputs_expand_jsonl_with_all(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        first = fixtures_copy / "full_trace.json"
        second = fixtures_copy / "runs" / "multi.jsonl"

        assert cli.main(["json", str(first), str(second), "--all"]) == 0

        documents = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        assert [document["name"] for document in documents] == [
            "full_trace.json",
            "runs/multi.jsonl · trace 1",
            "runs/multi.jsonl · trace 2",
        ]

    def test_multiple_inputs_require_all_to_expand_jsonl(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        first = fixtures_copy / "full_trace.json"
        second = fixtures_copy / "runs" / "multi.jsonl"

        assert cli.main(["json", str(first), str(second)]) == 1
        assert "multiple inputs containing JSONL require --all" in capsys.readouterr().err

    @pytest.mark.parametrize("option", [["--pretty"], ["--line", "1"]])
    def test_multiple_inputs_reject_single_trace_options(
        self,
        fixtures_copy: Path,
        option: list[str],
        capsys: pytest.CaptureFixture,
    ):
        first = fixtures_copy / "full_trace.json"
        second = fixtures_copy / "text_edge_cases.json"

        assert cli.main(["json", str(first), str(second), *option]) == 1
        assert "requires exactly one input" in capsys.readouterr().err

    def test_multiple_inputs_reject_stdin_and_duplicate_files(
        self,
        fixtures_copy: Path,
        capsys: pytest.CaptureFixture,
    ):
        path = fixtures_copy / "full_trace.json"

        assert cli.main(["json", str(path), "-"]) == 1
        assert "stdin cannot be combined" in capsys.readouterr().err

        assert cli.main(["json", str(path), str(path)]) == 1
        assert "duplicate trace file" in capsys.readouterr().err


class TestStatsCommand:
    def test_summarizes_every_trace_under_a_directory_and_reports_invalid_ones(
        self, fixtures_copy: Path, capsys: pytest.CaptureFixture
    ):
        assert cli.main(["stats", str(fixtures_copy)]) == 1

        lines = capsys.readouterr().out.splitlines()
        assert lines[0].split() == ["trace", "runs", "calls", "in", "cached", "out", "cost", "wall"]
        rows = {line.split()[0]: line.split() for line in lines[1:] if line and line[0] != " "}
        assert rows["trajectory.json"][1:3] == ["4", "5"]
        assert rows["full_trace.json"][-2:] == ["$0.0028", "6.0s"]
        assert "runs/multi.jsonl" in rows  # each JSONL line is its own row
        assert rows["total"][1] == "12"
        assert "  broken.json: not valid JSON" in "\n".join(lines)

    def test_json_prints_one_object_per_trace(
        self, fixtures_copy: Path, capsys: pytest.CaptureFixture
    ):
        source = fixtures_copy / "runs" / "multi.jsonl"

        assert cli.main(["stats", str(source), "--json"]) == 0

        documents = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        assert [document["name"] for document in documents] == [
            f"{source.as_posix()} · trace 1",
            f"{source.as_posix()} · trace 2",
        ]
        assert [run["name"] for run in documents[0]["runs"]] == [f"{source.as_posix()} · trace 1"]
        assert documents[0]["stats"]["llm_calls"] == 1

    def test_lists_each_run_of_a_trajectory_with_its_own_stats(
        self, fixtures_copy: Path, capsys: pytest.CaptureFixture
    ):
        source = fixtures_copy / "trajectory.json"

        assert cli.main(["stats", str(source)]) == 0
        table = capsys.readouterr().out.splitlines()
        assert cli.main(["stats", str(source), "--json"]) == 0
        [document] = [json.loads(line) for line in capsys.readouterr().out.splitlines()]

        assert [line.split()[0:2] for line in table[2:6]] == [
            ["planner", "1"],
            ["worker", "2"],
            ["subagent", "1"],
            ["summarizer", "1"],
        ]
        assert table[4].startswith("    subagent")  # indented under its parent
        runs = {run["name"]: run for run in document["runs"]}
        assert list(runs) == ["planner", "worker", "subagent", "summarizer"]
        assert runs["subagent"]["parent"] == "worker"
        # A run's stats exclude its subagents, so per-run costs add up to the trace's.
        assert runs["worker"]["stats"]["llm_calls"] == 2
        assert sum(run["stats"]["cost_usd"] for run in runs.values()) == pytest.approx(
            document["stats"]["cost_usd"]
        )

    def test_json_reports_an_invalid_trace_as_an_error_object(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ):
        source = tmp_path / "bad.json"
        source.write_text("[]")

        assert cli.main(["stats", str(source), "--json"]) == 1

        assert json.loads(capsys.readouterr().out) == {
            "name": source.as_posix(),
            "error": f"run {source.as_posix()!r} has no messages",
        }

    def test_reads_stdin(self, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(sys, "stdin", io.StringIO(minimal_trace()))

        assert cli.main(["stats"]) == 0

        assert capsys.readouterr().out.splitlines()[1].startswith("stdin ")

    def test_names_traces_by_directory_when_given_several_paths(
        self, fixtures_copy: Path, capsys: pytest.CaptureFixture
    ):
        assert (
            cli.main(
                [
                    "stats",
                    str(fixtures_copy / "runs"),
                    str(fixtures_copy / "full_trace.json"),
                    "--json",
                ]
            )
            == 0
        )

        names = [json.loads(line)["name"] for line in capsys.readouterr().out.splitlines()]
        assert names[0] == "runs/media_and_builtins.json"
        assert names[-1] == (fixtures_copy / "full_trace.json").as_posix()

    @pytest.mark.parametrize("target", ["file", "directory", "stdin"])
    def test_an_empty_jsonl_source_is_reported_as_invalid(
        self,
        target: str,
        tmp_path: Path,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        source = tmp_path / "empty.jsonl"
        source.write_text("\n")
        arguments = {"file": [str(source)], "directory": [str(tmp_path)], "stdin": []}[target]
        monkeypatch.setattr(sys, "stdin", io.StringIO(""))

        assert cli.main(["stats", *arguments, "--json"]) == 1

        [document] = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        assert document["error"] == "contains no traces"
        assert (
            document["name"]
            == {
                "file": source.as_posix(),
                "directory": "empty.jsonl",
                "stdin": "stdin",
            }[target]
        )

    @pytest.mark.parametrize("as_json", [True, False])
    def test_an_unreadable_file_is_reported_without_losing_other_rows(
        self, fixtures_copy: Path, tmp_path: Path, capsys: pytest.CaptureFixture, as_json: bool
    ):
        root = tmp_path / "traces"
        root.mkdir()
        (root / "good.json").write_text((fixtures_copy / "full_trace.json").read_text())
        (root / "bad.json").write_bytes(b"\xff")

        assert cli.main(["stats", str(root), *(["--json"] if as_json else [])]) == 1

        out = capsys.readouterr().out
        if as_json:
            documents = {json.loads(line)["name"]: json.loads(line) for line in out.splitlines()}
            assert documents["good.json"]["stats"]["llm_calls"] == 3
            assert documents["bad.json"]["error"].startswith("cannot read file: ")
        else:
            assert out.splitlines()[1].startswith("good.json")
            assert "  bad.json: cannot read file: " in out

    def test_json_escapes_a_lone_surrogate_in_a_run_name(
        self, fixtures_copy: Path, tmp_path: Path, capfdbinary: pytest.CaptureFixture
    ):
        trajectory = json.loads((fixtures_copy / "trajectory.json").read_text())
        trajectory["runs"][0]["name"] = "\ud800"
        source = tmp_path / "surrogate.json"
        source.write_text(json.dumps(trajectory))  # ASCII, so the file itself is valid UTF-8

        assert cli.main(["stats", str(source), "--json"]) == 0

        [line] = capfdbinary.readouterr().out.decode("utf-8").splitlines()
        assert json.loads(line)["runs"][0]["name"] == "\ud800"

    def test_table_groups_digits_shows_minutes_and_aligns_wide_names(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ):
        from datetime import UTC, datetime, timedelta

        from pydantic_ai.messages import (
            ModelMessagesTypeAdapter,
            ModelRequest,
            ModelResponse,
            TextPart,
            UserPromptPart,
        )
        from pydantic_ai.usage import RequestUsage

        at = datetime(2026, 1, 1, 9, 0, tzinfo=UTC)
        long_run = [
            ModelRequest(parts=[UserPromptPart(content="go", timestamp=at)]),
            ModelResponse(
                parts=[TextPart(content="ok")],
                usage=RequestUsage(input_tokens=20_459_704, output_tokens=7),
                timestamp=at + timedelta(seconds=863.2),
            ),
        ]
        root = tmp_path / "traces"
        root.mkdir()
        (root / "long.json").write_bytes(ModelMessagesTypeAdapter.dump_json(long_run))
        (root / "配達.json").write_text(minimal_trace())

        assert cli.main(["stats", str(root)]) == 0

        lines = capsys.readouterr().out.splitlines()
        rows = {line.split()[0]: line for line in lines[1:]}
        assert "20,459,704" in rows["long.json"].split()
        assert rows["long.json"].endswith("14m 23s")
        # Each wide character fills two columns, so equal widths need two fewer characters.
        assert len(rows["配達.json"]) == len(rows["long.json"]) - 2
