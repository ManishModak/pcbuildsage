import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isHostedMode,
  setCachedDeploymentMode,
  resetCachedDeploymentMode
} from "@/lib/api-client";
import {
  getMarketPreference,
  setMarketPreference,
  setLocalStorageForTesting,
  resetMarketStoreForTesting
} from "@/lib/market/client-market-store";
import {
  getByokKey,
  setByokKey,
  clearByokKey,
  getByokModel,
  setByokModel,
  clearByokModel,
  getByokReasoningEffort,
  setByokReasoningEffort,
  clearByokReasoningEffort,
  getActiveByokProvider,
  setActiveByokProvider,
  maskApiKey,
  injectByokHeaders,
  setByokStorageForTesting,
  resetByokStoreForTesting
} from "@/lib/llm/client-byok-store";
import {
  SettingsView,
  settingsTabFromSearch,
  LOCAL_NAV_ITEMS,
  HOSTED_NAV_ITEMS
} from "../settings-view";
import { MarketPreferenceSection } from "../market-preference-section";
import { ByokSection } from "../byok-section";
import { AppProvider } from "@/components/app/app-provider";

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

describe("Settings & UI Adaptation for Hosted-Demo Mode", () => {
  let mockSession: MockStorage;
  let mockLocal: MockStorage;

  beforeEach(() => {
    mockSession = new MockStorage();
    mockLocal = new MockStorage();
    resetCachedDeploymentMode();
    resetMarketStoreForTesting();
    resetByokStoreForTesting();
    setLocalStorageForTesting(mockLocal);
    setByokStorageForTesting(mockSession, mockLocal);
  });

  describe("1. Mode Detection", () => {
    it("detects hosted-demo mode when cached deployment mode is hosted-demo", () => {
      setCachedDeploymentMode("hosted-demo");
      expect(isHostedMode()).toBe(true);
    });

    it("detects local mode when cached deployment mode is local", () => {
      setCachedDeploymentMode("local");
      expect(isHostedMode()).toBe(false);
    });

    it("falls back to local mode when unconfigured", () => {
      resetCachedDeploymentMode();
      expect(isHostedMode()).toBe(false);
    });
  });

  describe("2. Navigation and URL Routing", () => {
    it("hides scraper database tab while exposing web research in hosted-demo mode", () => {
      const hostedTabIds = HOSTED_NAV_ITEMS.map((item) => item.id);
      expect(hostedTabIds).toEqual(["market", "llm", "search", "personalization"]);
      expect(hostedTabIds).not.toContain("database");
      expect(hostedTabIds).toContain("search");
    });

    it("keeps all existing tabs in local mode navigation items", () => {
      const localTabIds = LOCAL_NAV_ITEMS.map((item) => item.id);
      expect(localTabIds).toEqual(["llm", "search", "personalization", "database"]);
    });

    it("redirects deep links to ?tab=database to market in hosted-demo mode", () => {
      const resolved = settingsTabFromSearch("?tab=database", true);
      expect(resolved).toBe("market");
    });

    it("routes deep links to ?tab=search to search tab in hosted-demo mode", () => {
      const resolved = settingsTabFromSearch("?tab=search", true);
      expect(resolved).toBe("search");
    });

    it("permits ?tab=database in local mode", () => {
      const resolved = settingsTabFromSearch("?tab=database", false);
      expect(resolved).toBe("database");
    });

    it("routes ?tab=byok to llm tab in hosted-demo mode", () => {
      const resolved = settingsTabFromSearch("?tab=byok", true);
      expect(resolved).toBe("llm");
    });

    it("routes ?tab=market to market tab in hosted-demo mode", () => {
      const resolved = settingsTabFromSearch("?tab=market", true);
      expect(resolved).toBe("market");
    });
  });

  describe("3. Market Preference Section", () => {
    it("renders Market Preference section with country and currency selection controls", () => {
      const html = renderToStaticMarkup(<MarketPreferenceSection />);

      expect(html).toContain("Market Preference");
      expect(html).toContain("Country / Region");
      expect(html).toContain("Currency");
      expect(html).toContain("Browser Storage");
      expect(html).toContain("data-testid=\"country-select\"");
      expect(html).toContain("data-testid=\"currency-select\"");
    });

    it("reads current market preference from client-market-store", () => {
      setMarketPreference({ countryCode: "UK", currencyCode: "GBP", locale: "en-GB" });
      const html = renderToStaticMarkup(<MarketPreferenceSection />);

      expect(html).toContain("United Kingdom");
      expect(html).toContain("GBP");
    });

    it("persists updated country and default currency via setMarketPreference", () => {
      const updated = setMarketPreference({
        countryCode: "US",
        currencyCode: "USD",
        locale: "en-US"
      });

      expect(updated.countryCode).toBe("US");
      expect(updated.currencyCode).toBe("USD");
      expect(getMarketPreference().countryCode).toBe("US");
      expect(getMarketPreference().currencyCode).toBe("USD");
    });

    it("updates currency while preserving country preference", () => {
      setMarketPreference({ countryCode: "UK", currencyCode: "GBP", locale: "en-GB" });
      const updated = setMarketPreference({ currencyCode: "EUR" });

      expect(updated.countryCode).toBe("UK");
      expect(updated.currencyCode).toBe("EUR");
    });
  });

  describe("4. Bring Your Own Key (BYOK) Section", () => {
    it("renders BYOK section with Gemini and OpenRouter provider cards", () => {
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain("Bring Your Own Key (BYOK)");
      expect(html).toContain("Google Gemini");
      expect(html).toContain("OpenRouter");
      expect(html).toContain("data-testid=\"byok-card-gemini\"");
      expect(html).toContain("data-testid=\"byok-card-openrouter\"");
      expect(html).toContain("Privacy Guarantee");
    });

    it("shows unconfigured state with input and save button when no key is set", () => {
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain("Not Configured");
      expect(html).toContain("data-testid=\"byok-gemini-input\"");
      expect(html).toContain("data-testid=\"byok-gemini-save\"");
      expect(html).toContain("Remember for this browser");
    });

    it("shows masked key and Clear Key button when a provider key is set", () => {
      setByokKey("gemini", "AIzaSyFakeGeminiKey123456");
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain("Configured");
      expect(html).toContain(maskApiKey("AIzaSyFakeGeminiKey123456"));
      expect(html).toContain("Clear Key");
      expect(html).toContain("Replace Key");
      expect(html).toContain("data-testid=\"byok-gemini-clear\"");
      expect(html).toContain("data-testid=\"byok-gemini-masked\"");
    });

    it("clears stored BYOK key from client store when clearByokKey is invoked", () => {
      setByokKey("gemini", "AIzaSyKeyToBeCleared");
      expect(getByokKey("gemini")).toBe("AIzaSyKeyToBeCleared");

      clearByokKey("gemini");
      expect(getByokKey("gemini")).toBeUndefined();
    });

    it("masks OpenRouter keys appropriately for safe display", () => {
      setByokKey("openrouter", "sk-or-v1-abcdef1234567890xyz");
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain(maskApiKey("sk-or-v1-abcdef1234567890xyz"));
      expect(html).toContain("data-testid=\"byok-openrouter-clear\"");
    });

    it("renders Configured Model section and Auto-Detect Models button when key is present", () => {
      setByokKey("gemini", "AIzaSyFakeGeminiKey123456");
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain("Configured Model");
      expect(html).toContain("Auto-Detect Models");
      expect(html).toContain("data-testid=\"byok-gemini-detect\"");
      expect(html).toContain("data-testid=\"byok-gemini-model-select\"");
    });

    it("persists and retrieves configured model via setByokModel and getByokModel", () => {
      expect(getByokModel("gemini")).toBeUndefined();

      setByokModel("gemini", "gemini-2.5-pro");
      expect(getByokModel("gemini")).toBe("gemini-2.5-pro");

      clearByokModel("gemini");
      expect(getByokModel("gemini")).toBeUndefined();
    });

    it("renders reasoning effort pills when provider is configured", () => {
      setByokKey("groq", "gsk_test_key_12345678");
      setByokReasoningEffort("groq", "high");
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain("Reasoning Effort");
      expect(html).toContain("data-testid=\"byok-groq-reasoning-effort\"");
      expect(html).toContain("data-testid=\"byok-groq-effort-default\"");
      expect(html).toContain("data-testid=\"byok-groq-effort-low\"");
      expect(html).toContain("data-testid=\"byok-groq-effort-medium\"");
      expect(html).toContain("data-testid=\"byok-groq-effort-high\"");
    });

    it("persists and retrieves reasoning effort via setByokReasoningEffort and getByokReasoningEffort", () => {
      expect(getByokReasoningEffort("groq")).toBeUndefined();

      setByokReasoningEffort("groq", "medium");
      expect(getByokReasoningEffort("groq")).toBe("medium");

      setByokReasoningEffort("groq", "high", true);
      expect(getByokReasoningEffort("groq")).toBe("high");

      clearByokReasoningEffort("groq");
      expect(getByokReasoningEffort("groq")).toBeUndefined();
    });

    it("manages active provider selection via setActiveByokProvider and getActiveByokProvider", () => {
      setActiveByokProvider("openrouter");
      expect(getActiveByokProvider()).toBe("openrouter");

      setActiveByokProvider("gemini");
      expect(getActiveByokProvider()).toBe("gemini");
    });

    it("masks Groq keys appropriately for safe display", () => {
      setByokKey("groq", "gsk_1234567890abcdef12345678");
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain(maskApiKey("gsk_1234567890abcdef12345678"));
      expect(html).toContain("data-testid=\"byok-groq-clear\"");
    });

    it("renders Active Chat Provider card when both Gemini and OpenRouter are configured", () => {
      setByokKey("gemini", "AIzaSyGeminiKey");
      setByokKey("openrouter", "sk-or-v1-OpenRouterKey");
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain("Active Chat Provider");
      expect(html).toContain("data-testid=\"byok-active-provider-card\"");
      expect(html).toContain("data-testid=\"byok-active-gemini\"");
      expect(html).toContain("data-testid=\"byok-active-openrouter\"");
    });

    it("renders Active Chat Provider buttons for all configured providers including Groq", () => {
      setByokKey("gemini", "AIzaSyGeminiKey");
      setByokKey("groq", "gsk_GroqKey123");
      const html = renderToStaticMarkup(<ByokSection />);

      expect(html).toContain("Active Chat Provider");
      expect(html).toContain("data-testid=\"byok-active-gemini\"");
      expect(html).toContain("data-testid=\"byok-active-groq\"");
    });
  });

  describe("5. SettingsView in Hosted-Demo Mode vs Local Mode", () => {
    it("renders Market Preference tab in hosted-demo mode and hides scraping wizard", () => {
      setCachedDeploymentMode("hosted-demo");
      const html = renderToStaticMarkup(
        <AppProvider>
          <SettingsView isModal initialTabProp="market" />
        </AppProvider>
      );

      // Market tab and section present
      expect(html).toContain("Market Preference");
      expect(html).toContain("Country / Region");

      // Scraper management and wizard button completely absent
      expect(html).not.toContain("Launch Scraping &amp; Setup Wizard");
      expect(html).not.toContain("Launch Scraping & Setup Wizard");
      expect(html).not.toContain("Scraping &amp; Local Catalog Setup");
      expect(html).not.toContain("Scraping & Local Catalog Setup");
    });

    it("renders BYOK section in LLM tab in hosted-demo mode and hides provider chain", () => {
      setCachedDeploymentMode("hosted-demo");
      const html = renderToStaticMarkup(
        <AppProvider>
          <SettingsView isModal initialTabProp="llm" />
        </AppProvider>
      );

      expect(html).toContain("Bring Your Own Key (BYOK)");
      expect(html).toContain("Google Gemini");
      expect(html).toContain("Groq");
      expect(html).toContain("OpenRouter");
      expect(html).not.toContain("LLM provider chain");
    });

    it("renders Scraping & Local Catalog tab in local mode", () => {
      setCachedDeploymentMode("local");
      const html = renderToStaticMarkup(
        <AppProvider>
          <SettingsView isModal initialTabProp="database" />
        </AppProvider>
      );

      expect(html).toContain("Scraping &amp; Local Catalog");
      expect(html).toContain("Launch Scraping &amp; Setup Wizard");
    });
  });

  describe("6. Chat Request Headers and Context", () => {
    it("injects BYOK headers into request headers when keys are configured", () => {
      setByokKey("gemini", "AIzaSyGeminiChatKey");
      setByokKey("openrouter", "sk-or-v1-OpenRouterChatKey");

      const baseHeaders: Record<string, string> = {
        "content-type": "application/json"
      };

      const injected = injectByokHeaders(baseHeaders) as Record<string, string>;

      expect(injected["x-pcbuildsage-api-key-gemini"]).toBe("AIzaSyGeminiChatKey");
      expect(injected["x-gemini-api-key"]).toBe("AIzaSyGeminiChatKey");
      expect(injected["x-pcbuildsage-api-key-openrouter"]).toBe("sk-or-v1-OpenRouterChatKey");
      expect(injected["x-openrouter-api-key"]).toBe("sk-or-v1-OpenRouterChatKey");
      expect(injected["content-type"]).toBe("application/json");
    });

    it("includes active MarketPreference in chat configuration payload", () => {
      setMarketPreference({
        countryCode: "CA",
        currencyCode: "CAD",
        locale: "en-CA"
      });

      const pref = getMarketPreference();
      const chatPayload = {
        sessionId: "test-session-123",
        config: {
          countryCode: pref.countryCode,
          currency: pref.currencyCode,
          locale: pref.locale,
          marketPreference: pref
        }
      };

      expect(chatPayload.config.countryCode).toBe("CA");
      expect(chatPayload.config.currency).toBe("CAD");
      expect(chatPayload.config.locale).toBe("en-CA");
      expect(chatPayload.config.marketPreference).toEqual(pref);
    });
  });
});
