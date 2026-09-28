/**
 * src/content/api-key-help.ts
 *
 * Single source of truth for "get a free API key" help. Rendered by the
 * Settings key-help panel (`src/features/settings/key-help-panel.tsx`) and the
 * in-app help pages (`src/app/help/**`). Static text only — no LLM calls at
 * runtime, and no build is ever called "best".
 *
 * Every provider fact carries its source ({ url, checkedOn }) so the
 * accompanying vitest can assert nothing is invented. Provider facts were
 * verified against the providers' current docs via webfetch; app-local facts
 * (how PCBuildSage stores keys) were verified against the in-repo files they
 * cite, which are named as the source instead of an external URL.
 */

/** Date every fact in this module was last verified (YYYY-MM-DD). */
export const API_KEY_HELP_CHECKED_ON = "2026-09-28";

export interface ApiKeyHelpSource {
  /** Provider doc URL, or the in-repo path for app-local facts. */
  url: string;
  /** Verification date (YYYY-MM-DD). */
  checkedOn: string;
}

export interface ApiKeyHelpStep {
  text: string;
  sources: ApiKeyHelpSource[];
}

export interface ApiKeyHelpGuide {
  id: "gemini" | "openrouter";
  provider: string;
  title: string;
  keyUrl: string;
  keyUrlLabel: string;
  steps: ApiKeyHelpStep[];
}

export interface ApiKeyHelpFact {
  id: string;
  heading: string;
  text: string;
  sources: ApiKeyHelpSource[];
}

export interface ApiKeyHelpFaq {
  question: string;
  answer: string;
  sources: ApiKeyHelpSource[];
}

/** Gemini first: it is the recommended free starting point in Settings. */
export const GEMINI_KEY_GUIDE: ApiKeyHelpGuide = {
  id: "gemini",
  provider: "Google Gemini",
  title: "Option 1 — Google Gemini (free tier)",
  keyUrl: "https://aistudio.google.com/app/apikey",
  keyUrlLabel: "aistudio.google.com/app/apikey",
  steps: [
    {
      text: "Open the Google AI Studio key page and sign in with your Google account.",
      sources: [{ url: "https://ai.google.dev/gemini-api/docs/api-key", checkedOn: API_KEY_HELP_CHECKED_ON }]
    },
    {
      text: "Choose Create API key — the key is created inside your Google Cloud project.",
      sources: [{ url: "https://ai.google.dev/gemini-api/docs/api-key", checkedOn: API_KEY_HELP_CHECKED_ON }]
    },
    {
      text: "Copy the key and paste it into the Google Gemini card in PCBuildSage Settings.",
      sources: [{ url: "src/features/settings/byok-section.tsx", checkedOn: API_KEY_HELP_CHECKED_ON }]
    }
  ]
};

export const OPENROUTER_KEY_GUIDE: ApiKeyHelpGuide = {
  id: "openrouter",
  provider: "OpenRouter",
  title: "Option 2 — OpenRouter (free models)",
  keyUrl: "https://openrouter.ai/keys",
  keyUrlLabel: "openrouter.ai/keys",
  steps: [
    {
      text: "Open the OpenRouter keys page and sign in (or create an account).",
      sources: [{ url: "https://openrouter.ai/docs/api-keys", checkedOn: API_KEY_HELP_CHECKED_ON }]
    },
    {
      text: "Create a key: give it a name and set a credit limit for it.",
      sources: [{ url: "https://openrouter.ai/docs/api-keys", checkedOn: API_KEY_HELP_CHECKED_ON }]
    },
    {
      text: "Copy the key and paste it into the OpenRouter card in PCBuildSage Settings.",
      sources: [{ url: "src/features/settings/byok-section.tsx", checkedOn: API_KEY_HELP_CHECKED_ON }]
    }
  ]
};

/** Gemini first, then OpenRouter. */
export const API_KEY_GUIDES: ApiKeyHelpGuide[] = [GEMINI_KEY_GUIDE, OPENROUTER_KEY_GUIDE];

export const API_KEY_FACTS: ApiKeyHelpFact[] = [
  {
    id: "what-is-a-key",
    heading: "What is an API key?",
    text: "An API key is a secret token that identifies your account to the model provider, so your usage is counted against your quota or credits.",
    sources: [
      { url: "https://ai.google.dev/gemini-api/docs/api-key", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "https://openrouter.ai/docs/api-keys", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  },
  {
    id: "key-storage",
    heading: "Where does my key live?",
    text: "Keys stay in your browser: sessionStorage by default (cleared when the tab closes), localStorage only when you tick “Remember for this browser”.",
    sources: [
      { url: "src/lib/llm/client-byok-store.ts", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "src/features/settings/byok-provider-card.tsx", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  },
  {
    id: "key-transit",
    heading: "Who sees my key?",
    text: "Keys travel to the server only inside per-request HTTP headers and are never written to any database, file, or server log.",
    sources: [
      { url: "src/lib/llm/client-byok-store.ts", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "src/features/settings/byok-section.tsx", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  },
  {
    id: "cost-gemini",
    heading: "What does Gemini cost?",
    text: "The Gemini API has a free tier with free input and output tokens and generous limits; heavier use needs a paid tier.",
    sources: [{ url: "https://ai.google.dev/gemini-api/docs/pricing", checkedOn: API_KEY_HELP_CHECKED_ON }]
  },
  {
    id: "cost-openrouter",
    heading: "What does OpenRouter cost?",
    text: "OpenRouter offers free models with low rate limits — 50 requests per day, or 1,000 per day after buying at least $10 in credits. New accounts also get a small free allowance for trying things out.",
    sources: [{ url: "https://openrouter.ai/docs/faq", checkedOn: API_KEY_HELP_CHECKED_ON }]
  },
  {
    id: "rate-limits",
    heading: "Are there usage limits?",
    text: "Yes. Gemini limits are measured in requests and tokens per minute plus requests per day, and daily quotas reset at midnight Pacific time. OpenRouter free models are limited per day as described above.",
    sources: [
      { url: "https://ai.google.dev/gemini-api/docs/rate-limits", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "https://openrouter.ai/docs/faq", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  },
  {
    id: "remove-key",
    heading: "How do I remove my key?",
    text: "Remove a key at any time with Clear Key on its Settings card — this wipes it from browser storage.",
    sources: [{ url: "src/features/settings/byok-provider-card.tsx", checkedOn: API_KEY_HELP_CHECKED_ON }]
  },
  {
    id: "leaked-key",
    heading: "What if my key leaks?",
    text: "Delete it where you created it (Google AI Studio or the OpenRouter keys page) and create a replacement; treat every key like a password.",
    sources: [
      { url: "https://ai.google.dev/gemini-api/docs/api-key", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "https://openrouter.ai/docs/api-keys", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  }
];

export const API_KEY_FAQS: ApiKeyHelpFaq[] = [
  {
    question: "What is an API key?",
    answer:
      "A secret token that identifies your account to the model provider, so usage counts against your quota or credits. Paste yours into the matching provider card in PCBuildSage Settings.",
    sources: [
      { url: "https://ai.google.dev/gemini-api/docs/api-key", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "https://openrouter.ai/docs/api-keys", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  },
  {
    question: "Is it safe to paste my key here?",
    answer:
      "Yes. Keys stay in your browser — sessionStorage by default (cleared when the tab closes), localStorage only with “Remember for this browser”. They reach the server only in per-request headers and are never stored server-side.",
    sources: [
      { url: "src/lib/llm/client-byok-store.ts", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "src/features/settings/byok-section.tsx", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  },
  {
    question: "Does it cost money?",
    answer:
      "Not to start: the Gemini API has a free tier with free input and output tokens, and OpenRouter offers free models (50 requests per day, or 1,000 per day after buying at least $10 in credits). Heavier use needs a paid tier or credits.",
    sources: [
      { url: "https://ai.google.dev/gemini-api/docs/pricing", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "https://openrouter.ai/docs/faq", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  },
  {
    question: "My key was rejected. What do I do?",
    answer:
      "“Your key was rejected. Check you copied all of it.” Re-open the provider page, copy the whole key again (no missing or extra characters), and replace it in Settings.",
    sources: [{ url: "src/features/settings/byok-section.tsx", checkedOn: API_KEY_HELP_CHECKED_ON }]
  },
  {
    question: "It says I hit the free limit. What now?",
    answer:
      "“You've hit the free limit. Wait a bit or pick another free model.” Free quotas reset over time (Gemini daily quotas reset at midnight Pacific), or switch to another free model in Settings.",
    sources: [
      { url: "https://ai.google.dev/gemini-api/docs/rate-limits", checkedOn: API_KEY_HELP_CHECKED_ON },
      { url: "https://openrouter.ai/docs/faq", checkedOn: API_KEY_HELP_CHECKED_ON }
    ]
  },
  {
    question: "How do I remove my key?",
    answer: "Press Clear Key on the provider card in Settings. This wipes the key from your browser storage immediately.",
    sources: [{ url: "src/features/settings/byok-provider-card.tsx", checkedOn: API_KEY_HELP_CHECKED_ON }]
  }
];

/** Plain-language copy for rejected credentials (HTTP 401). */
export const KEY_REJECTED_COPY = "Your key was rejected. Check you copied all of it.";

/** Plain-language copy for a provider refusing access (HTTP 403): the key was accepted but not allowed here. */
export const ACCESS_BLOCKED_COPY =
  "The provider blocked access (HTTP 403), for example the model isn't available to this key or in your region. Try another model or provider.";

/** Plain-language copy for exhausted free quotas (HTTP 429). */
export const FREE_LIMIT_COPY = "You've hit the free limit. Wait a bit or pick another free model.";

/** Our own hosted-demo rate limiter (src/middleware.ts), not the provider's. */
export const DEMO_RATE_LIMIT_CODE = "HOSTED_RATE_LIMITED";
export const DEMO_RATE_LIMIT_COPY = "Too many requests from you on the demo; wait a minute.";

const PLAIN_COPIES = [KEY_REJECTED_COPY, ACCESS_BLOCKED_COPY, FREE_LIMIT_COPY, DEMO_RATE_LIMIT_COPY];

const DEMO_RATE_LIMIT_PATTERN = new RegExp(DEMO_RATE_LIMIT_CODE, "i");

const AUTH_FAILURE_PATTERN =
  /unauthorized|unauthenticated|invalid api key|invalid_api_key|incorrect api key|invalid key|authentication failed|api key.*(revoked|expired|invalid)/i;

const ACCESS_BLOCKED_PATTERN = /forbidden|permission.?denied|not available in your (region|country)|unsupported (region|country|location)/i;

// `quota` / `exhausted` only count next to limit wording: bare "quota" also
// appears in billing errors that waiting won't fix.
const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|resource.?exhausted|tokens per minute|requests per minute|free-tier limit|request limit|quota.{0,40}(exceeded|exhausted|reached|limit)|(exceeded|exhausted|reached).{0,40}quota/i;

const STATUS_CODE_PATTERN = /\b(401|403|429)\b/;

/**
 * Map a failure to user-facing plain language: our own demo rate limit,
 * a rejected key (401), a provider access block (403), or an exhausted free
 * quota (429). Returns undefined otherwise (caller keeps its existing
 * message). Never throws.
 */
export function mapProviderErrorToPlainLanguage(input: { status?: number; message?: string }): string | undefined {
  const status = input.status;
  const message = input.message ?? "";
  if (DEMO_RATE_LIMIT_PATTERN.test(message)) return DEMO_RATE_LIMIT_COPY;
  if (status === 401) return KEY_REJECTED_COPY;
  if (status === 403) return ACCESS_BLOCKED_COPY;
  if (status === 429) return FREE_LIMIT_COPY;
  if (AUTH_FAILURE_PATTERN.test(message)) return KEY_REJECTED_COPY;
  if (ACCESS_BLOCKED_PATTERN.test(message)) return ACCESS_BLOCKED_COPY;
  const code = message.match(STATUS_CODE_PATTERN)?.[1];
  if (code === "429" || RATE_LIMIT_PATTERN.test(message)) return FREE_LIMIT_COPY;
  if (code === "401") return KEY_REJECTED_COPY;
  if (code === "403") return ACCESS_BLOCKED_COPY;
  return undefined;
}

/**
 * Removes a plain-language copy the server already prefixed (see
 * sanitizeErrorMessage in src/app/api/chat/route.ts), so the client can add
 * its own without showing it twice.
 */
export function stripPlainCopyPrefix(text: string): string {
  for (const copy of PLAIN_COPIES) {
    if (text.startsWith(copy)) return text.slice(copy.length).trimStart();
  }
  return text;
}

/** Flat list of every sourced statement, for the source-coverage test. */
export function allApiKeyHelpFacts(): Array<{ text: string; sources: ApiKeyHelpSource[] }> {
  return [
    ...API_KEY_GUIDES.flatMap((guide) => guide.steps),
    ...API_KEY_FACTS,
    ...API_KEY_FAQS.map((faq) => ({ text: `${faq.question} ${faq.answer}`, sources: faq.sources }))
  ];
}
