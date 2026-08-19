import json
from dataclasses import FrozenInstanceError
from types import SimpleNamespace

import pytest

from pydantic_ai_trace import TraceCollectionView, TraceView
from pydantic_ai_trace import view as view_module

INDEX_HTML = "<html><head><style>b{}</style><script>bundle();</script></head></html>"


class TestFromJson:
    def test_accepts_text_and_preserves_it(self, monkeypatch: pytest.MonkeyPatch):
        trace = '[ {"kind": "request", "parts": []} ]'
        monkeypatch.setattr(view_module, "packaged_index_html", lambda: INDEX_HTML)

        document = TraceView.from_json(trace, title="run 7").html()

        payload = document.split("window.__TRACE_DATA__ = ", 1)[1].split(";window.__TRACE_NAME__")[
            0
        ]
        assert json.loads(payload) == trace
        assert 'window.__TRACE_NAME__ = "run 7"' in document

    def test_accepts_utf8_bytes(self):
        view = TraceView.from_json(b"[]")

        assert view.title == "trace"

    def test_rejects_invalid_utf8(self):
        with pytest.raises(ValueError, match="not valid UTF-8"):
            TraceView.from_json(b"[\xff]")

    def test_rejects_invalid_json(self):
        with pytest.raises(ValueError, match="trace JSON is invalid"):
            TraceView.from_json("[")

    def test_rejects_non_standard_json_constants(self):
        with pytest.raises(ValueError, match="non-standard JSON constant"):
            TraceView.from_json("[NaN]")

    def test_rejects_non_array_json(self):
        with pytest.raises(ValueError, match="top-level array"):
            TraceView.from_json('{"kind": "request"}')

    def test_direct_construction_is_rejected(self):
        with pytest.raises(TypeError, match="from_messages"):
            TraceView()

    def test_view_is_immutable(self):
        view = TraceView.from_json("[]")

        with pytest.raises(FrozenInstanceError):
            view.title = "changed"  # type: ignore[misc]


class TestFromMessages:
    def test_uses_pydantic_ai_canonical_adapter(self, monkeypatch: pytest.MonkeyPatch):
        captured: list[object] = []

        class FakeAdapter:
            @staticmethod
            def dump_json(messages: list[object]) -> bytes:
                captured.extend(messages)
                return b"[]"

        monkeypatch.setattr(
            view_module,
            "import_module",
            lambda name: SimpleNamespace(ModelMessagesTypeAdapter=FakeAdapter),
        )
        messages = [object(), object()]

        view = TraceView.from_messages(messages, title="objects")

        assert captured == messages
        assert view.title == "objects"

    def test_explains_missing_optional_dependency(self, monkeypatch: pytest.MonkeyPatch):
        def missing(_name: str):
            raise ModuleNotFoundError(name="pydantic_ai")

        monkeypatch.setattr(view_module, "import_module", missing)

        with pytest.raises(ImportError, match="install pydantic-ai"):
            TraceView.from_messages([])

    def test_maps_serialization_failure_to_value_error(self, monkeypatch: pytest.MonkeyPatch):
        class BrokenAdapter:
            @staticmethod
            def dump_json(_messages: list[object]) -> bytes:
                raise TypeError("unsupported")

        monkeypatch.setattr(
            view_module,
            "import_module",
            lambda name: SimpleNamespace(ModelMessagesTypeAdapter=BrokenAdapter),
        )

        with pytest.raises(ValueError, match="cannot be serialized"):
            TraceView.from_messages([object()])


class TestDocument:
    def test_html_contains_precomputed_transcript(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(view_module, "packaged_index_html", lambda: INDEX_HTML)

        document = TraceView.from_json("[]", title="empty").html()

        payload = document.split("window.__TRACE_TEXT__ = ", 1)[1].split(";</script>")[0]
        assert json.loads(payload).startswith("========== TRACE ==========")
        assert "NAME: empty" in json.loads(payload)

    def test_write_creates_utf8_document(self, tmp_path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(view_module, "packaged_index_html", lambda: INDEX_HTML)
        output = tmp_path / "trace.html"

        TraceView.from_json("[]", title="über").write(output)

        assert 'window.__TRACE_NAME__ = "\\u00fcber"' in output.read_text(encoding="utf-8")


class TestTraceCollectionView:
    def test_embeds_named_traces_in_sequence_order(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(view_module, "packaged_index_html", lambda: INDEX_HTML)
        collection = TraceCollectionView(
            [
                TraceView.from_json('[{"kind":"request","parts":[]}]', title="Original"),
                TraceView.from_json("[]", title="Candidate"),
            ],
            title="Case 42",
        )

        document = collection.html()

        payload = document.split("window.__TRACE_COLLECTION__ = ", 1)[1].split(";</script>")[0]
        data = json.loads(json.loads(payload))
        assert data["title"] == "Case 42"
        assert [trace["name"] for trace in data["traces"]] == ["Original", "Candidate"]
        assert json.loads(data["traces"][0]["source"])[0]["kind"] == "request"
        assert "NAME: Candidate" in data["traces"][1]["transcript"]

    def test_trace_content_and_names_cannot_break_out_of_script(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(view_module, "packaged_index_html", lambda: INDEX_HTML)
        collection = TraceCollectionView(
            [TraceView.from_json('[{"content":"</script>"}]', title="</script>")],
            title="</script>",
        )

        injection = collection.html().split("<script>bundle();", 1)[0]

        assert injection.count("</script>") == 1

    def test_copies_input_sequence(self):
        traces = [TraceView.from_json("[]", title="Original")]

        collection = TraceCollectionView(traces)
        traces.append(TraceView.from_json("[]", title="Later"))

        assert [trace.title for trace in collection.traces] == ["Original"]

    def test_requires_at_least_one_trace(self):
        with pytest.raises(ValueError, match="at least one"):
            TraceCollectionView([])

    def test_requires_trace_view_instances(self):
        with pytest.raises(TypeError, match="TraceView instances"):
            TraceCollectionView([object()])  # type: ignore[list-item]

    @pytest.mark.parametrize("title", ["", "  "])
    def test_rejects_empty_trace_titles(self, title: str):
        with pytest.raises(ValueError, match="must not be empty"):
            TraceCollectionView([TraceView.from_json("[]", title=title)])

    def test_rejects_duplicate_trace_titles(self):
        with pytest.raises(ValueError, match="must be unique"):
            TraceCollectionView(
                [
                    TraceView.from_json("[]", title="Candidate"),
                    TraceView.from_json("[]", title="Candidate"),
                ]
            )
