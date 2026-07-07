from __future__ import annotations

from scraper.extractor import parse_html, select


def test_child_combinator_matches_only_direct_children() -> None:
    root = parse_html("<a><x><b id='nested'>Nested</b></x><b id='direct'>Direct</b></a>")

    assert [node.attrs["id"] for node in select(root, "a > b")] == ["direct"]


def test_descendant_selector_matches_nested_and_direct_children() -> None:
    root = parse_html("<a><x><b id='nested'>Nested</b></x><b id='direct'>Direct</b></a>")

    assert [node.attrs["id"] for node in select(root, "a b")] == ["nested", "direct"]
