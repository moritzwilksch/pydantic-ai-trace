import pytest

from pydantic_ai_trace._format import display_width, format_count, format_duration


@pytest.mark.parametrize(
    ("seconds", "expected"),
    [
        (0, "0.0s"),
        (6.04, "6.0s"),
        (59.94, "59.9s"),
        (59.96, "1m 0s"),  # rounds up to a minute rather than printing `60.0s`
        (863.2, "14m 23s"),
        (3600, "1h 0m 0s"),
        (7325.6, "2h 2m 6s"),
    ],
)
def test_format_duration(seconds: float, expected: str):
    assert format_duration(seconds) == expected


def test_format_count_groups_thousands():
    assert [format_count(n) for n in (0, 999, 1000, 20_459_704)] == [
        "0",
        "999",
        "1,000",
        "20,459,704",
    ]


def test_display_width_counts_terminal_columns():
    assert display_width("trace.json") == 10
    assert display_width("配達.json") == 9
    assert display_width("é") == 1  # e + combining acute accent
