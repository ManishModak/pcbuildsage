from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_PROVIDER = "gemini"
DEFAULT_MODEL = "gemini-2.5-flash-lite"
ALLOWED_PROVIDERS = {"gemini", "ollama", "openrouter", "openai-compatible"}


@dataclass(frozen=True)
class LLMConfig:
    provider: str = DEFAULT_PROVIDER
    model: str = DEFAULT_MODEL


def resolve_llm_config(provider: str | None = None, model: str | None = None) -> LLMConfig:
    resolved_provider = provider or os.getenv("SCRAPER_LLM_PROVIDER") or DEFAULT_PROVIDER
    resolved_model = model or os.getenv("SCRAPER_LLM_MODEL") or DEFAULT_MODEL
    if resolved_provider not in ALLOWED_PROVIDERS:
        raise ValueError(f"unsupported scraper LLM provider: {resolved_provider}")
    return LLMConfig(provider=resolved_provider, model=resolved_model)


class LLMClient:
    def __init__(self, config: LLMConfig) -> None:
        self.config = config

    def list_models(self) -> list[str]:
        if self.config.provider == "gemini":
            return self._list_gemini_models()
        if self.config.provider == "ollama":
            return self._list_ollama_models()
        if self.config.provider == "openrouter":
            return self._list_openrouter_models()
        return self._list_openai_compatible_models()

    def extract_products(self, product_blocks: list[str]) -> list[dict[str, Any]]:
        if self.config.provider in {"openrouter", "openai-compatible"}:
            return self._extract_openai_compatible(product_blocks)
        if self.config.provider == "ollama":
            return self._extract_ollama(product_blocks)
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            logger.warning("LLM extraction skipped: GEMINI_API_KEY or GOOGLE_API_KEY is not set")
            return []
        try:
            from google import genai  # type: ignore
        except Exception as exc:
            logger.warning("LLM extraction skipped: google.genai import failed: %s", exc)
            return []
        prompt = self._extraction_prompt(product_blocks)
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(model=self.config.model, contents=prompt)
        text = getattr(response, "text", "") or ""
        return self._parse_extraction_text(text)

    def _extraction_prompt(self, product_blocks: list[str]) -> str:
        return (
            "Extract PC hardware products from these HTML snippets. Return only JSON with a "
            "top-level products array. Each product must include title, price_text, url, "
            "image_url, in_stock.\n\n"
            + "\n\n".join(product_blocks[:40])
        )

    def _post_json(self, url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=45) as response:  # noqa: S310 - user-selected local/provider endpoints
            return json.loads(response.read().decode("utf-8"))

    def _parse_extraction_text(self, text: str) -> list[dict[str, Any]]:
        text = text.strip()
        match_fence = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
        if match_fence:
            text = match_fence.group(1).strip()
        elif text.startswith("```"):
            text = text.strip("`")
            text = text.removeprefix("json").strip()
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"[\[{].*[\]}]", text, re.DOTALL)
            if not match:
                return []
            try:
                payload = json.loads(match.group(0))
            except json.JSONDecodeError:
                return []
        products = payload.get("products") if isinstance(payload, dict) else payload
        return products if isinstance(products, list) else []

    def _extract_openai_compatible(self, product_blocks: list[str]) -> list[dict[str, Any]]:
        if self.config.provider == "openrouter":
            base_url = "https://openrouter.ai/api/v1"
            api_key = os.getenv("OPENROUTER_API_KEY")
        else:
            base_url = os.getenv("OPENAI_COMPATIBLE_BASE_URL", "http://localhost:8000/v1").rstrip("/")
            api_key = os.getenv("OPENAI_COMPATIBLE_API_KEY", "dummy")
        if not api_key:
            return []
        payload = {
            "model": self.config.model,
            "messages": [{"role": "user", "content": self._extraction_prompt(product_blocks)}],
            "response_format": {"type": "json_object"},
            "temperature": 0,
        }
        try:
            response = self._post_json(
                f"{base_url}/chat/completions",
                payload,
                {"Authorization": f"Bearer {api_key}"},
            )
        except Exception as exc:
            logger.warning("LLM extraction call failed: %s", exc)
            return []
        choices = response.get("choices", [])
        if not choices:
            return []
        return self._parse_extraction_text(choices[0].get("message", {}).get("content", ""))

    def _extract_ollama(self, product_blocks: list[str]) -> list[dict[str, Any]]:
        base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
        payload = {
            "model": self.config.model,
            "messages": [{"role": "user", "content": self._extraction_prompt(product_blocks)}],
            "format": "json",
            "stream": False,
            "options": {"temperature": 0},
        }
        try:
            response = self._post_json(f"{base_url}/api/chat", payload)
        except Exception as exc:
            logger.warning("LLM extraction call failed: %s", exc)
            return []
        return self._parse_extraction_text(response.get("message", {}).get("content", ""))

    def _get_json(self, url: str, headers: dict[str, str] | None = None) -> Any:
        request = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310 - user-selected local/provider endpoints
            return json.loads(response.read().decode("utf-8"))

    def _list_gemini_models(self) -> list[str]:
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY is required to list Gemini models")
        payload = self._get_json(f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}")
        return [model["name"].removeprefix("models/") for model in payload.get("models", []) if "name" in model]

    def _list_ollama_models(self) -> list[str]:
        base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
        payload = self._get_json(f"{base_url}/api/tags")
        return [model["name"] for model in payload.get("models", []) if "name" in model]

    def _list_openrouter_models(self) -> list[str]:
        api_key = os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required to list OpenRouter models")
        payload = self._get_json("https://openrouter.ai/api/v1/models", {"Authorization": f"Bearer {api_key}"})
        return [model["id"] for model in payload.get("data", []) if "id" in model]

    def _list_openai_compatible_models(self) -> list[str]:
        base_url = os.getenv("OPENAI_COMPATIBLE_BASE_URL", "http://localhost:8000/v1").rstrip("/")
        api_key = os.getenv("OPENAI_COMPATIBLE_API_KEY", "dummy")
        try:
            payload = self._get_json(f"{base_url}/models", {"Authorization": f"Bearer {api_key}"})
        except urllib.error.URLError as exc:
            raise RuntimeError(f"failed to list models from {base_url}: {exc}") from exc
        return [model["id"] for model in payload.get("data", []) if "id" in model]
