"""Hatch build hook that refuses to build a package without frontend assets."""

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CheckStaticAssetsHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if version == "editable":  # dev installs run against the Vite dev server instead
            return
        index = Path(self.root) / "src" / "pydantic_ai_trace" / "static" / "index.html"
        if not index.is_file():
            raise RuntimeError(
                f"Frontend assets missing: {index} not found. "
                "Run `pixi run build-frontend` before building the package."
            )
