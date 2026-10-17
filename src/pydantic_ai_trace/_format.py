"""Human-readable numbers for the text renderers. Machine output (`json`) keeps raw values."""

from __future__ import annotations

import unicodedata
from decimal import ROUND_HALF_UP, Decimal


def format_count(count: int) -> str:
    """A count with thousands separators, e.g. `20,459,704`."""
    return f"{count:,}"


def format_usd(amount: Decimal) -> str:
    """A cost rounded half-up to four decimals, e.g. `$0.0028`."""
    return f"${amount.quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP)}"


def format_duration(seconds: float) -> str:
    """Tenths of a second below a minute (`6.0s`), else whole units (`14m 23s`, `2h 5m 0s`)."""
    if round(seconds, 1) < 60:
        return f"{seconds:.1f}s"
    minutes, secs = divmod(round(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m {secs}s" if hours else f"{minutes}m {secs}s"


def format_bytes(size: int) -> str:
    """A byte size in B, KB, or MB, e.g. `1.5 KB`."""
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / 1024 / 1024:.1f} MB"


def display_width(text: str) -> int:
    """Terminal columns: wide East Asian characters take two, combining marks none."""
    return sum(
        0
        if unicodedata.combining(char)
        else 2
        if unicodedata.east_asian_width(char) in {"W", "F"}
        else 1
        for char in text
    )


def ljust(text: str, width: int) -> str:
    return text + " " * (width - display_width(text))


def rjust(text: str, width: int) -> str:
    return " " * (width - display_width(text)) + text
