"""`paitrace --skill` and the recipes it teaches."""

import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from traces import eval_set

from pydantic_ai_trace import cli

SKILL = Path(cli.__file__).with_name("skill.md").read_text(encoding="utf-8")
BASH_BLOCKS = re.findall(r"^```bash\n(.*?)^```$", SKILL, flags=re.MULTILINE | re.DOTALL)


class _PipedStdin:
    def isatty(self) -> bool:
        return False

    def read(self, *args) -> str:
        raise AssertionError("--skill must not read stdin")


def _serve(*args, **kwargs):
    raise AssertionError("--skill must not start a server")


def test_skill_prints_markdown_without_frontmatter(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    monkeypatch.setattr(sys, "stdin", _PipedStdin())
    monkeypatch.setattr("pydantic_ai_trace.server.serve", _serve)

    assert cli.main(["--skill"]) == 0

    out = capsys.readouterr().out
    assert out == SKILL
    assert out.startswith("# ")


@pytest.mark.skipif(shutil.which("jq") is None, reason="needs jq")
@pytest.mark.parametrize("recipe", BASH_BLOCKS, ids=lambda block: block.splitlines()[0][:40])
def test_skill_recipe_prints_a_result(tmp_path: Path, recipe: str):
    traces = eval_set()
    (tmp_path / "evals.jsonl").write_text(traces)
    (tmp_path / "trace.json").write_text(traces.splitlines()[0])
    (tmp_path / "traces").mkdir()
    (tmp_path / "traces" / "evals.jsonl").write_text(traces)
    paitrace = f'paitrace() {{ "{sys.executable}" -m pydantic_ai_trace.cli "$@"; }}'

    result = subprocess.run(
        ["bash", "-c", f"set -euo pipefail\n{paitrace}\n{recipe}"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    # A renamed field makes a recipe print nothing rather than fail.
    assert result.stdout.strip() not in {"", "null", "[]"}
