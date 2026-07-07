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
        def __init__(self, api_key: str) -> None:
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

