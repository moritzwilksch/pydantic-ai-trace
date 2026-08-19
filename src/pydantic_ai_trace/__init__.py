from importlib.metadata import version

from .view import TraceCollectionView, TraceView

__all__ = ["TraceCollectionView", "TraceView", "__version__"]

__version__ = version("pydantic-ai-trace")
