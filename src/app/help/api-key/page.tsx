import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { pageSeo } from "@/lib/seo";
import {
  API_KEY_FAQS,
  API_KEY_FACTS,
  API_KEY_GUIDES,
  FREE_LIMIT_COPY,
  KEY_REJECTED_COPY
} from "@/content/api-key-help";

export const metadata: Metadata = pageSeo(
  "/help/api-key",
  "Get a free API key — PCBuildSage Help",
  "Free Gemini and OpenRouter API key setup for PCBuildSage: steps, costs, safety, and error help."
);

const SECTION_HEADING = "type-title text-xl text-text";
const ROW_LIST = "divide-y divide-border overflow-hidden rounded-card border border-border";

export default function ApiKeyHelpPage() {
  return (
    <main className="mx-auto flex w-full max-w-[68ch] flex-col gap-10 px-6 py-12">
      <div className="flex flex-col gap-3">
        <Link
          href="/help"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-text-secondary transition-colors duration-150 hover:text-text"
        >
          <Icon icon={ArrowLeft} size={14} />
          All help topics
        </Link>
        <h1 className="type-title text-2xl text-text">Get a free API key in 2 minutes</h1>
        <p className="text-base leading-[1.65] text-text-secondary">
          PCBuildSage chats through your own provider key. Pick one option below — both have a free tier.
        </p>
      </div>

      <section className="flex flex-col gap-6" aria-label="Setup steps">
        {API_KEY_GUIDES.map((guide) => (
          <article key={guide.id} className="flex flex-col gap-3">
            <h2 className={SECTION_HEADING}>{guide.title}</h2>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-base leading-[1.65] text-text-secondary marker:text-text-muted">
              {guide.steps.map((step, index) => (
                <li key={index}>
                  {step.text}{" "}
                  {index === 0 ? (
                    <a
                      href={guide.keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-sm text-accent underline underline-offset-2"
                    >
                      {guide.keyUrlLabel}
                      <Icon icon={ExternalLink} size={12} />
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3" aria-label="Key facts">
        <h2 className={SECTION_HEADING}>Good to know</h2>
        <div className={ROW_LIST}>
          {API_KEY_FACTS.map((fact) => (
            <article key={fact.id} className="px-4 py-4">
              <h3 className="type-title text-base text-text">{fact.heading}</h3>
              <p className="mt-1 text-sm leading-relaxed text-text-secondary">{fact.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="Common errors">
        <h2 className={SECTION_HEADING}>If chat shows an error</h2>
        <div className={ROW_LIST}>
          <article className="px-4 py-4">
            <h3 className="type-title text-base text-text">Key rejected</h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">“{KEY_REJECTED_COPY}”</p>
          </article>
          <article className="px-4 py-4">
            <h3 className="type-title text-base text-text">Free limit reached</h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">“{FREE_LIMIT_COPY}”</p>
          </article>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="Frequently asked questions">
        <h2 className={SECTION_HEADING}>Questions</h2>
        <div className={ROW_LIST}>
          {API_KEY_FAQS.map((faq) => (
            <article key={faq.question} className="px-4 py-4">
              <h3 className="type-title text-base text-text">{faq.question}</h3>
              <p className="mt-1 text-sm leading-relaxed text-text-secondary">{faq.answer}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-label="Sources">
        <h2 className={SECTION_HEADING}>Sources</h2>
        <p className="text-sm text-text-secondary">Every provider fact above was verified against these pages.</p>
        <ul className="flex flex-col gap-2 text-sm">
          {Array.from(new Map(API_KEY_FACTS.flatMap((fact) => fact.sources).map((s) => [s.url, s])).values()).map(
            (source) => (
              <li key={source.url} className="break-words text-text-secondary">
                {source.url.startsWith("http") ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-caption text-accent underline underline-offset-2"
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
          className="inline-flex min-h-11 items-center rounded-btn bg-accent px-4 text-sm font-semibold text-on-accent transition-colors duration-150 hover:opacity-90"
        >
          Open settings to paste your key
        </Link>
      </div>
    </main>
  );
}
