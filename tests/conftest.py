from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixtures_copy(tmp_path: Path) -> Path:
    """A writable copy of the fixture tree, so tests never mutate the originals."""
    import shutil

    destination = tmp_path / "fixtures"
    shutil.copytree(FIXTURES, destination)
    return destination
