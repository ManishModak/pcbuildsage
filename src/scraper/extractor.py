from __future__ import annotations

from html.parser import HTMLParser
from typing import Any, Iterator
from urllib.parse import urljoin

from .models import RawProduct


class Node:
    def __init__(self, tag: str, attrs: dict[str, str], parent: "Node | None" = None) -> None:
        self.tag = tag
        self.attrs = attrs
        self.parent = parent
        self.children: list[Node] = []
        self.text_parts: list[str] = []

    @property
    def text(self) -> str:
        parts = list(self.text_parts)
        for child in self.children:
            child_text = child.text
            if child_text:
                parts.append(child_text)
        return " ".join(part.strip() for part in parts if part.strip()).strip()

    def html(self) -> str:
        attrs = "".join(f' {key}="{value}"' for key, value in self.attrs.items())
        inner = "".join(child.html() for child in self.children)
        text = "".join(self.text_parts)
        return f"<{self.tag}{attrs}>{text}{inner}</{self.tag}>"


class TreeParser(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("document", {})
        self.current = self.root

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag.casefold(), {key.casefold(): value or "" for key, value in attrs}, self.current)
        self.current.children.append(node)
        if tag.casefold() not in self.VOID_TAGS:
            self.current = node

    def handle_endtag(self, tag: str) -> None:
        wanted = tag.casefold()
        node: Node | None = self.current
        while node and node is not self.root:
            if node.tag == wanted:
                self.current = node.parent or self.root
                return
            node = node.parent

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.current.text_parts.append(data)


def parse_html(html: str) -> Node:
    parser = TreeParser()
    parser.feed(html)
    return parser.root


def _iter_descendants(node: Node) -> Iterator[Node]:
    stack = list(reversed(node.children))
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.children))


def _matches_simple(node: Node, selector: str) -> bool:
    selector = selector.strip()
    if not selector or selector in {">", "*"}:
        return selector == "*"
    if selector.startswith("#"):
        return node.attrs.get("id") == selector[1:]
    tag = None
    classes: list[str] = []
    if selector.startswith("."):
        classes = [part for part in selector.split(".") if part]
    elif "." in selector:
        parts = selector.split(".")
        tag = parts[0].casefold()
        classes = [part for part in parts[1:] if part]
    else:
        tag = selector.casefold()
    if tag and node.tag != tag:
        return False
    class_attr = set(node.attrs.get("class", "").split())
    return all(name in class_attr for name in classes)


def _selector_tokens(selector: str) -> list[str]:
    return [token for token in selector.replace(">", " > ").split() if token]


def select(node: Node, selector: str | None) -> list[Node]:
    if not selector:
        return []
    results: list[Node] = []
    for selector_part in selector.split(","):
        tokens = _selector_tokens(selector_part.strip())
        current = [node]
        direct_child = False
        for token in tokens:
            if token == ">":
                direct_child = True
                continue
            next_nodes: list[Node] = []
            for candidate in current:
                candidates = candidate.children if direct_child else _iter_descendants(candidate)
                next_nodes.extend(desc for desc in candidates if _matches_simple(desc, token))
            current = next_nodes
            direct_child = False
        results.extend(current)
    deduped: list[Node] = []
    seen: set[int] = set()
    for item in results:
        if id(item) not in seen:
            deduped.append(item)
            seen.add(id(item))
    return deduped


def select_one(node: Node, selector: str | None) -> Node | None:
    matches = select(node, selector)
    return matches[0] if matches else None


def attr_or_text(node: Node | None, attr_names: tuple[str, ...] = ()) -> str | None:
    if not node:
        return None
    for name in attr_names:
        value = node.attrs.get(name)
        if value:
            return value.strip()
    text = node.text.strip()
    return text or None


def extract_products(html: str, selectors: dict[str, str], base_url: str) -> list[RawProduct]:
    root = parse_html(html)
    containers = select(root, selectors.get("product_container"))
    products: list[RawProduct] = []
    for container in containers:
        title_node = select_one(container, selectors.get("title"))
        price_node = select_one(container, selectors.get("price"))
        url_node = select_one(container, selectors.get("url"))
        image_node = select_one(container, selectors.get("image"))
        stock_node = select_one(container, selectors.get("out_of_stock"))
        url = attr_or_text(url_node, ("href",))
        image = attr_or_text(image_node, ("src", "data-src"))
        products.append(
            RawProduct(
                title=attr_or_text(title_node),
                price_text=attr_or_text(price_node),
                url=urljoin(base_url, url) if url else None,
                image_url=urljoin(base_url, image) if image else None,
                in_stock=stock_node is None,
                source_html=container.html(),
            )
        )
    return products


def selector_hit_rates(html: str, selectors: dict[str, str]) -> dict[str, tuple[int, int]]:
    root = parse_html(html)
    containers = select(root, selectors.get("product_container"))
    total = len(containers)
    rates: dict[str, tuple[int, int]] = {"product_container": (total, total)}
    for key in ("title", "price", "url", "image", "out_of_stock"):
        selector = selectors.get(key)
        if not selector:
            continue
        hits = sum(1 for container in containers if select_one(container, selector) is not None)
        rates[key] = (hits, total)
    return rates


def raw_from_llm_payload(items: list[dict[str, Any]], base_url: str) -> list[RawProduct]:
    products: list[RawProduct] = []
    for item in items:
        url = item.get("url")
        image = item.get("image_url")
        products.append(
            RawProduct(
                title=item.get("title") or item.get("name"),
                price_text=item.get("price_text") or item.get("price"),
                url=urljoin(base_url, url) if url else None,
                image_url=urljoin(base_url, image) if image else None,
                in_stock=bool(item.get("in_stock", True)),
            )
        )
    return products
