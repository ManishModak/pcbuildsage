from __future__ import annotations

import sys
from types import SimpleNamespace

from scraper.llm_client import LLMClient, LLMConfig


def test_gemini_extraction_accepts_fenced_json(monkeypatch) -> None:
    class FakeModels:
        def generate_content(self, model: str, contents: str) -> SimpleNamespace:
            return SimpleNamespace(
                text='```json\n{"products": [{"title": "GPU", "price_text": "100", "url": "/gpu"}]}\n```'
            )

    class FakeClient:
        def __init__(self, api_key: str, **_kwargs: object) -> None:
            self.models = FakeModels()

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "google", SimpleNamespace(genai=SimpleNamespace(Client=FakeClient)))

    products = LLMClient(LLMConfig(provider="gemini", model="gemini-test")).extract_products(["<div>GPU</div>"])

    assert products == [{"title": "GPU", "price_text": "100", "url": "/gpu"}]


def test_extraction_accepts_json_fence_after_preamble() -> None:
    text = """
    Here are the extracted products:

    ```json
    {"products": [{"title": "GPU", "price_text": "100", "url": "/gpu"}]}
    ```
    """

    products = LLMClient(LLMConfig())._parse_extraction_text(text)

    assert products == [{"title": "GPU", "price_text": "100", "url": "/gpu"}]


def test_extraction_accepts_json_fence_with_preamble_and_postamble() -> None:
    text = """
    Sure, here is the requested data:
    ```json
    {
      "products": [{"title": "CPU", "price_text": "200", "url": "/cpu"}]
    }
    ```
    I hope this helps!
    """

    products = LLMClient(LLMConfig())._parse_extraction_text(text)

    assert products == [{"title": "CPU", "price_text": "200", "url": "/cpu"}]



def test_gemini_timeout_returns_without_waiting_for_hung_call(monkeypatch) -> None:
    import threading
    import time

    import scraper.llm_client as llm_module

    release = threading.Event()

    class HungModels:
        def generate_content(self, model: str, contents: str) -> SimpleNamespace:
            release.wait(5)
            return SimpleNamespace(text="[]")

    seen_options: list[object] = []

    class HungClient:
        def __init__(self, api_key: str, http_options: object = None) -> None:
            seen_options.append(http_options)
            self.models = HungModels()

    monkeypatch.setattr(llm_module, "GEMINI_TIMEOUT_S", 0.2)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "google", SimpleNamespace(genai=SimpleNamespace(Client=HungClient)))

    started = time.monotonic()
    try:
        products = LLMClient(LLMConfig(provider="gemini", model="gemini-test")).extract_products(["<div/>"])
        elapsed = time.monotonic() - started
    finally:
        release.set()

    assert products == []
    assert elapsed < 1.5
    assert seen_options == [{"timeout": 200}]
