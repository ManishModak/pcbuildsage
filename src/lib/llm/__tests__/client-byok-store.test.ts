import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BYOK_PREFIX,
  getByokKey,
  setByokKey,
  clearByokKey,
  clearAllByokKeys,
  hasByokKey,
  isByokKeyPersistent,
  injectByokHeaders,
  maskApiKey,
  setByokStorageForTesting,
  resetByokStoreForTesting
} from "../client-byok-store";

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe("client-byok-store", () => {
  let mockSessionStorage: MockStorage;
  let mockLocalStorage: MockStorage;

  beforeEach(() => {
    mockSessionStorage = new MockStorage();
    mockLocalStorage = new MockStorage();
    setByokStorageForTesting(mockSessionStorage, mockLocalStorage);
  });

  afterEach(() => {
    resetByokStoreForTesting();
  });

  describe("Ephemeral sessionStorage by default", () => {
    it("stores keys in sessionStorage without writing to localStorage by default", () => {
      setByokKey("gemini", "AIzaSyEphemeralKey123");

      expect(getByokKey("gemini")).toBe("AIzaSyEphemeralKey123");
      expect(hasByokKey("gemini")).toBe(true);

      // Verify stored under expected key prefix in sessionStorage
      expect(mockSessionStorage.getItem(`${BYOK_PREFIX}gemini`)).toBe("AIzaSyEphemeralKey123");

      // Verify zero leakage to localStorage
      expect(mockLocalStorage.getItem(`${BYOK_PREFIX}gemini`)).toBeNull();
      expect(mockLocalStorage.length).toBe(0);
    });

    it("returns undefined for unset keys", () => {
      expect(getByokKey("openrouter")).toBeUndefined();
      expect(hasByokKey("openrouter")).toBe(false);
    });
  });

  describe("Persistent localStorage option", () => {
    it("stores key in both sessionStorage and localStorage when persist is true", () => {
      setByokKey("openrouter", "sk-or-v1-persistent-key", true);

      expect(getByokKey("openrouter")).toBe("sk-or-v1-persistent-key");
      expect(mockSessionStorage.getItem(`${BYOK_PREFIX}openrouter`)).toBe("sk-or-v1-persistent-key");
      expect(mockLocalStorage.getItem(`${BYOK_PREFIX}openrouter`)).toBe("sk-or-v1-persistent-key");
    });

    it("falls back to localStorage if sessionStorage is empty (e.g. new browser tab)", () => {
      mockLocalStorage.setItem(`${BYOK_PREFIX}gemini`, "AIzaSyPersistentTabKey");

      // Session storage is completely empty
      expect(mockSessionStorage.getItem(`${BYOK_PREFIX}gemini`)).toBeNull();

      // getByokKey resolves from persistent storage
      expect(getByokKey("gemini")).toBe("AIzaSyPersistentTabKey");
      expect(hasByokKey("gemini")).toBe(true);
    });

    it("removes persistent copy from localStorage when set with persist=false", () => {
      // First save with persist = true
      setByokKey("gemini", "AIzaSyFirstPersisted", true);
      expect(mockLocalStorage.getItem(`${BYOK_PREFIX}gemini`)).toBe("AIzaSyFirstPersisted");

      // Now set without persist
      setByokKey("gemini", "AIzaSyNowEphemeral", false);
      expect(mockSessionStorage.getItem(`${BYOK_PREFIX}gemini`)).toBe("AIzaSyNowEphemeral");
      expect(mockLocalStorage.getItem(`${BYOK_PREFIX}gemini`)).toBeNull();
    });

    it("reports persistence accurately via isByokKeyPersistent", () => {
      expect(isByokKeyPersistent("gemini")).toBe(false);

      setByokKey("gemini", "AIzaSyEphemeralKey", false);
      expect(isByokKeyPersistent("gemini")).toBe(false);

      setByokKey("gemini", "AIzaSyPersistentKey", true);
      expect(isByokKeyPersistent("gemini")).toBe(true);

      clearByokKey("gemini");
      expect(isByokKeyPersistent("gemini")).toBe(false);
    });
  });

  describe("Key clearing and lifecycle", () => {
    it("clears keys from both sessionStorage and localStorage on clearByokKey", () => {
      setByokKey("gemini", "AIzaSyKeyToClear", true);
      expect(hasByokKey("gemini")).toBe(true);

      clearByokKey("gemini");

      expect(getByokKey("gemini")).toBeUndefined();
      expect(hasByokKey("gemini")).toBe(false);
      expect(mockSessionStorage.getItem(`${BYOK_PREFIX}gemini`)).toBeNull();
      expect(mockLocalStorage.getItem(`${BYOK_PREFIX}gemini`)).toBeNull();
    });

    it("clears all keys across providers on clearAllByokKeys", () => {
      setByokKey("gemini", "gemini-key", true);
      setByokKey("openrouter", "openrouter-key", true);
      setByokKey("openai-compatible", "custom-key", false);

      expect(hasByokKey("gemini")).toBe(true);
      expect(hasByokKey("openrouter")).toBe(true);
      expect(hasByokKey("openai-compatible")).toBe(true);

      clearAllByokKeys();

      expect(hasByokKey("gemini")).toBe(false);
      expect(hasByokKey("openrouter")).toBe(false);
      expect(hasByokKey("openai-compatible")).toBe(false);
      expect(mockSessionStorage.length).toBe(0);
      expect(mockLocalStorage.length).toBe(0);
    });

    it("clears key when passed empty string or whitespace only", () => {
      setByokKey("gemini", "AIzaSyExistingKey");
      expect(hasByokKey("gemini")).toBe(true);

      setByokKey("gemini", "   ");
      expect(hasByokKey("gemini")).toBe(false);
      expect(getByokKey("gemini")).toBeUndefined();
    });
  });

  describe("Whitespace trimming and provider normalization", () => {
    it("trims whitespace from stored keys", () => {
      setByokKey("gemini", "  AIzaSyTrimmedKey  ");
      expect(getByokKey("gemini")).toBe("AIzaSyTrimmedKey");
    });

    it("normalizes provider names (case-insensitive, underscores to hyphens)", () => {
      setByokKey("Gemini", "AIzaSyCaseInsensitive");
      expect(getByokKey("gemini")).toBe("AIzaSyCaseInsensitive");
      expect(getByokKey("GEMINI")).toBe("AIzaSyCaseInsensitive");

      setByokKey("openai_compatible", "sk-custom-key");
      expect(getByokKey("openai-compatible")).toBe("sk-custom-key");
      expect(getByokKey("OPENAI_COMPATIBLE")).toBe("sk-custom-key");
    });
  });

  describe("maskApiKey", () => {
    it("masks typical long API keys showing first 4 and last 4 characters", () => {
      expect(maskApiKey("AIzaSy1234567890abcdef4X9Z")).toBe("AIza...4X9Z");
      expect(maskApiKey("sk-or-v1-abcdef1234567890xy")).toBe("sk-o...90xy");
    });

    it("masks medium length keys (4 to 8 characters)", () => {
      expect(maskApiKey("12345678")).toBe("12...78");
      expect(maskApiKey("ABCD")).toBe("AB...CD");
    });

    it("masks short keys (< 4 characters)", () => {
      expect(maskApiKey("123")).toBe("...123");
      expect(maskApiKey("ab")).toBe("...ab");
    });

    it("returns empty string for empty, whitespace, or invalid keys", () => {
      expect(maskApiKey("")).toBe("");
      expect(maskApiKey("   ")).toBe("");
      // @ts-expect-error test non-string
      expect(maskApiKey(null)).toBe("");
    });
  });

  describe("injectByokHeaders", () => {
    it("injects both x-pcbuildsage-api-key-<provider> and x-<provider>-api-key headers", () => {
      setByokKey("gemini", "AIzaSyGeminiKey");
      setByokKey("openrouter", "sk-or-OpenRouterKey");

      const injected = injectByokHeaders({ "content-type": "application/json" }) as Record<string, string>;

      expect(injected["content-type"]).toBe("application/json");
      expect(injected["x-pcbuildsage-api-key-gemini"]).toBe("AIzaSyGeminiKey");
      expect(injected["x-gemini-api-key"]).toBe("AIzaSyGeminiKey");
      expect(injected["x-pcbuildsage-api-key-openrouter"]).toBe("sk-or-OpenRouterKey");
      expect(injected["x-openrouter-api-key"]).toBe("sk-or-OpenRouterKey");
    });

    it("supports standard Headers instance", () => {
      setByokKey("gemini", "AIzaSyGeminiHeadersKey");

      const baseHeaders = new Headers({ "authorization": "Bearer token" });
      const result = injectByokHeaders(baseHeaders) as Headers;

      expect(result.get("authorization")).toBe("Bearer token");
      expect(result.get("x-gemini-api-key")).toBe("AIzaSyGeminiHeadersKey");
      expect(result.get("x-pcbuildsage-api-key-gemini")).toBe("AIzaSyGeminiHeadersKey");
    });

    it("supports [string, string][] array headers", () => {
      setByokKey("gemini", "AIzaSyGeminiArrayKey");

      const baseHeaders: [string, string][] = [["accept", "text/event-stream"]];
      const result = injectByokHeaders(baseHeaders) as [string, string][];

      const resultMap = new Map(result);
      expect(resultMap.get("accept")).toBe("text/event-stream");
      expect(resultMap.get("x-gemini-api-key")).toBe("AIzaSyGeminiArrayKey");
    });

    it("omits headers when no keys are stored", () => {
      const injected = injectByokHeaders({ "content-type": "application/json" }) as Record<string, string>;
      expect(injected).toEqual({ "content-type": "application/json" });
    });

    it("preserves explicit caller-provided headers without clobbering", () => {
      setByokKey("gemini", "AIzaSyStoredKey");

      const baseHeaders = {
        "x-gemini-api-key": "AIzaSyExplicitOverrideKey"
      };

      const result = injectByokHeaders(baseHeaders) as Record<string, string>;
      expect(result["x-gemini-api-key"]).toBe("AIzaSyExplicitOverrideKey");
    });
  });
});
