import json

import pytest

from pydantic_ai_trace._html import inject_trace_data

INDEX_HTML = "<html><head><style>b{}</style><script>bundle();</script></head></html>"


class TestInjectTraceData:
    def test_payload_lands_before_the_bundle_script(self):
        result = inject_trace_data(INDEX_HTML, "[]", trace_name="t.json", transcript="")
        assert result.index("__TRACE_DATA__") < result.index("bundle();")
        assert result.index("__TRACE_TEXT__") < result.index("bundle();")

    def test_injected_json_round_trips(self):
        trace = json.dumps([{"kind": "request", "parts": [{"content": "a</b>c"}]}])
        result = inject_trace_data(INDEX_HTML, trace, trace_name="t.json", transcript="")
        payload = result.split("window.__TRACE_DATA__ = ", 1)[1].split(";window.__TRACE_NAME__")[0]
        assert json.loads(payload) == trace

    def test_script_close_tag_in_content_cannot_break_out(self):
        trace = json.dumps([{"content": "</script><script>alert(1)</script>"}])
        result = inject_trace_data(INDEX_HTML, trace, trace_name="t.json", transcript="")
        injection = result.split("<script>bundle();")[0]
        assert "</script><script>alert(1)" not in injection

    def test_trace_name_is_injected_as_string(self):
        result = inject_trace_data(INDEX_HTML, "[]", trace_name="my trace.json", transcript="")
        assert 'window.__TRACE_NAME__ = "my trace.json"' in result

    def test_html_without_script_tag_is_rejected(self):
        with pytest.raises(ValueError, match="no <script>"):
            inject_trace_data(
                "<html><body>empty</body></html>", "[]", trace_name="t", transcript=""
            )


class TestTraceDocument:
    def test_transcript_is_precomputed_by_the_python_formatter(self, packaged_index_html: None):
        from pydantic_ai_trace._html import trace_document

        result = trace_document("[]", trace_name="t.json")
        payload = result.split("window.__TRACE_TEXT__ = ", 1)[1].split(";</script>")[0]
        assert json.loads(payload).startswith("========== TRACE ==========")

    def test_renders_traces_the_public_api_would_reject(self, packaged_index_html: None):
        from pydantic_ai_trace._html import trace_document

        # The CLI exports whatever `scan` loaded, without revalidating it.
        result = trace_document('[{"cost": NaN}]', trace_name="t.json")
        assert "__TRACE_DATA__" in result


@pytest.fixture
def packaged_index_html(monkeypatch: pytest.MonkeyPatch) -> None:
    import pydantic_ai_trace._html as html_module

    monkeypatch.setattr(html_module, "packaged_index_html", lambda: INDEX_HTML)
