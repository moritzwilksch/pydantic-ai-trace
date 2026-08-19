from importlib.metadata import version

from .view import TraceView

__all__ = ["TraceView", "__version__"]

__version__ = version("pydantic-ai-trace")
