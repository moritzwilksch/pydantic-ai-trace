import json
from pathlib import Path

import pytest

from pydantic_ai_trace.export import inject_trace_data

INDEX_HTML = "<html><head><style>b{}</style><script>bundle();</script></head></html>"


class TestInjectTraceData:
    def test_payload_lands_before_the_bundle_script(self):
        result = inject_trace_data(INDEX_HTML, "[]", trace_name="t.json")
        assert result.index("__TRACE_DATA__") < result.index("bundle();")
        assert result.index("__TRACE_TEXT__") < result.index("bundle();")

    def test_injected_json_round_trips(self):
        trace = json.dumps([{"kind": "request", "parts": [{"content": "a</b>c"}]}])
        result = inject_trace_data(INDEX_HTML, trace, trace_name="t.json")
        payload = result.split("window.__TRACE_DATA__ = ", 1)[1].split(";window.__TRACE_NAME__")[0]
        assert json.loads(payload) == trace

    def test_script_close_tag_in_content_cannot_break_out(self):
        trace = json.dumps([{"content": "</script><script>alert(1)</script>"}])
        result = inject_trace_data(INDEX_HTML, trace, trace_name="t.json")
        injection = result.split("<script>bundle();")[0]
        assert "</script><script>alert(1)" not in injection

    def test_trace_name_is_injected_as_string(self):
        result = inject_trace_data(INDEX_HTML, "[]", trace_name="my trace.json")
        assert 'window.__TRACE_NAME__ = "my trace.json"' in result

    def test_transcript_is_precomputed_by_the_python_formatter(self):
        result = inject_trace_data(INDEX_HTML, "[]", trace_name="t.json")
        payload = result.split("window.__TRACE_TEXT__ = ", 1)[1].split(";</script>")[0]
        assert json.loads(payload).startswith("========== TRACE ==========")

    def test_html_without_script_tag_is_rejected(self):
        with pytest.raises(ValueError, match="no <script>"):
            inject_trace_data("<html><body>empty</body></html>", "[]", trace_name="t")


class TestExportHtml:
    def test_export_writes_selfcontained_html(
        self, fixtures_copy: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        import pydantic_ai_trace.export as export_module

        class FakeResource:
            def __truediv__(self, _name: str) -> "FakeResource":
                return self

            def read_text(self, encoding: str = "utf-8") -> str:
                return INDEX_HTML

        monkeypatch.setattr(export_module, "files", lambda _pkg: FakeResource())
        output = tmp_path / "out.html"
        export_module.export_html(fixtures_copy / "full_trace.json", output, line=None)
        assert "__TRACE_DATA__" in output.read_text()
