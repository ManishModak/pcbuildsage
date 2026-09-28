import type { Metadata } from "next";
import Link from "next/link";
import {
  API_KEY_FAQS,
  API_KEY_FACTS,
  API_KEY_GUIDES,
  FREE_LIMIT_COPY,
  KEY_REJECTED_COPY
} from "@/content/api-key-help";

export const metadata: Metadata = {
  title: "Get a free API key — PCBuildSage Help",
  description: "Free Gemini and OpenRouter API key setup for PCBuildSage: steps, costs, safety, and error help."
};

export default function ApiKeyHelpPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <div className="flex flex-col gap-1">
        <Link href="/help" className="text-sm font-medium text-accent hover:underline">
          ← All help topics
        </Link>
        <h1 className="text-2xl font-semibold text-text">Get a free API key in 2 minutes</h1>
        <p className="text-sm text-text-secondary">
          PCBuildSage chats through your own provider key. Pick one option below — both have a free tier.
        </p>
      </div>

      <section className="flex flex-col gap-4" aria-label="Setup steps">
        {API_KEY_GUIDES.map((guide) => (
          <article key={guide.id} className="rounded-card border border-border bg-surface p-4">
            <h2 className="text-base font-semibold text-text">{guide.title}</h2>
            <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-text-secondary">
              {guide.steps.map((step, index) => (
                <li key={index} className="leading-relaxed">
                  {step.text}{" "}
                  {index === 0 ? (
                    <a
                      href={guide.keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-accent hover:underline"
                    >
                      {guide.keyUrlLabel} ↗
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3" aria-label="Key facts">
        <h2 className="text-lg font-semibold text-text">Good to know</h2>
        {API_KEY_FACTS.map((fact) => (
          <article key={fact.id} className="rounded-card border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-text">{fact.heading}</h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">{fact.text}</p>
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3" aria-label="Common errors">
        <h2 className="text-lg font-semibold text-text">If chat shows an error</h2>
        <article className="rounded-card border border-border bg-surface p-4">
          <h3 className="text-sm font-semibold text-text">Key rejected</h3>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">“{KEY_REJECTED_COPY}”</p>
        </article>
        <article className="rounded-card border border-border bg-surface p-4">
          <h3 className="text-sm font-semibold text-text">Free limit reached</h3>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">“{FREE_LIMIT_COPY}”</p>
        </article>
      </section>

      <section className="flex flex-col gap-3" aria-label="Frequently asked questions">
        <h2 className="text-lg font-semibold text-text">Questions</h2>
        {API_KEY_FAQS.map((faq) => (
          <article key={faq.question} className="rounded-card border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-text">{faq.question}</h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">{faq.answer}</p>
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-2" aria-label="Sources">
        <h2 className="text-lg font-semibold text-text">Sources</h2>
        <p className="text-sm text-text-secondary">Every provider fact above was verified against these pages.</p>
        <ul className="flex flex-col gap-1.5 text-sm">
          {Array.from(new Map(API_KEY_FACTS.flatMap((fact) => fact.sources).map((s) => [s.url, s])).values()).map(
            (source) => (
              <li key={source.url} className="text-text-secondary">
                {source.url.startsWith("http") ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-caption text-accent hover:underline"
                  >
                    {source.url}
                  </a>
                ) : (
                  <span className="font-mono text-caption text-text-muted">{source.url} (in-repo, verified by reading)</span>
                )}{" "}
                <span className="text-caption text-text-muted">— checked {source.checkedOn}</span>
              </li>
            )
          )}
        </ul>
      </section>

      <div>
        <Link
          href="/settings?tab=llm"
          className="inline-flex items-center rounded-btn bg-accent px-4 py-2 text-sm font-semibold text-on-accent"
        >
          Open Settings to paste your key →
        </Link>
      </div>
    </main>
  );
}
