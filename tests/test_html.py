import json
from pathlib import Path

import pytest

from pydantic_ai_trace import RunTree, render_html
from pydantic_ai_trace import _html as html_module
from pydantic_ai_trace._html import inject_payload

FIXTURES = Path(__file__).parent / "fixtures"
INDEX_HTML = "<html><head><style>b{}</style><script>bundle();</script></head></html>"


def injected_payload(document: str) -> dict:
    literal = document.split("window.__TRACE_PAYLOAD__ = ", 1)[1].split(";</script>")[0]
    return json.loads(json.loads(literal))


class TestInjectPayload:
    def test_payload_lands_before_the_bundle_script(self):
        result = inject_payload(INDEX_HTML, "{}")
        assert result.index("__TRACE_PAYLOAD__") < result.index("bundle();")

    def test_script_close_tag_in_content_cannot_break_out(self):
        payload = json.dumps({"content": "</script><script>alert(1)</script>"})
        result = inject_payload(INDEX_HTML, payload)
        injection = result.split("<script>bundle();")[0]
        assert "</script><script>alert(1)" not in injection
        assert json.loads(json.loads(injection.split(" = ", 1)[1].split(";</script>")[0])) == {
            "content": "</script><script>alert(1)</script>"
        }

    def test_html_without_script_tag_is_rejected(self):
        with pytest.raises(ValueError, match="no <script>"):
            inject_payload("<html><body>empty</body></html>", "{}")


class TestRenderHtml:
    @pytest.fixture(autouse=True)
    def stub_bundle(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(html_module, "packaged_index_html", lambda: INDEX_HTML)

    def test_embeds_run_tree_analysis_and_transcript(self):
        run_tree = RunTree.model_validate_json((FIXTURES / "run_tree.json").read_text())

        payload = injected_payload(render_html(run_tree, name="workflow"))

        assert payload["name"] == "workflow"
        assert RunTree.model_validate(payload["run_tree"]) == run_tree
        assert [run["run_id"] for run in payload["analysis"]["runs"]] == [
            "planner",
            "subagent",
            "worker",
            "summarizer",
        ]
        assert payload["transcript"].startswith("========== TRACE ==========")

    def test_messages_become_a_one_run_document(self):
        from pydantic_ai.messages import ModelMessagesTypeAdapter

        messages = ModelMessagesTypeAdapter.validate_json(
            (FIXTURES / "full_trace.json").read_text()
        )

        payload = injected_payload(render_html(RunTree.from_messages(messages)))

        assert payload["name"] == "trace"
        assert [run["name"] for run in payload["run_tree"]["runs"]] == ["run"]
