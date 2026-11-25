from __future__ import annotations

from scraper.extractor import extract_products, parse_html, select


def test_child_combinator_matches_only_direct_children() -> None:
    root = parse_html("<a><x><b id='nested'>Nested</b></x><b id='direct'>Direct</b></a>")

    assert [node.attrs["id"] for node in select(root, "a > b")] == ["direct"]


def test_descendant_selector_matches_nested_and_direct_children() -> None:
    root = parse_html("<a><x><b id='nested'>Nested</b></x><b id='direct'>Direct</b></a>")

    assert [node.attrs["id"] for node in select(root, "a b")] == ["nested", "direct"]


def test_out_of_stock_matches_container_class_as_well_as_descendant() -> None:
    html = """
    <div class="wd-product instock">
      <a href="/p/1">In Stock CPU</a>
      <span class="price">₹10,000</span>
    </div>
    <div class="wd-product outofstock">
      <a href="/p/2">Sold Out CPU</a>
      <span class="price">₹12,000</span>
    </div>
    """
    products = extract_products(
        html,
        {
            "product_container": "div.wd-product",
            "title": "a",
            "price": "span.price",
            "url": "a",
            "out_of_stock": ".outofstock, .out-of-stock",
        },
        "https://shop.example/",
    )
    assert [(p.title, p.in_stock) for p in products] == [("In Stock CPU", True), ("Sold Out CPU", False)]
