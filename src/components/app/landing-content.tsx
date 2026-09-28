// Server-rendered landing section for `/`.
//
// This is the HTML crawlers (and first paint) see: the old page rendered only
// a spinner until client hydration, so search engines found nothing. It is
// static copy only — no LLM calls, no cookies. Never call any
// build "best".
export function LandingContent() {
  return (
    <div className="bg-bg text-text">
      <main className="mx-auto w-full max-w-3xl px-4 py-12">
        <p className="text-sm text-text-muted">Free and open-source PC build planner</p>
        <h1 className="mt-2 text-3xl font-semibold">PCBuildSage — AI PC build planner for India</h1>
        <p className="mt-4">
          Describe your budget and needs in plain language and get PC builds assembled from
          parts in stock at Indian retailers today — including MDComputers, PrimeABGB, Vedant
          Computers, PC Studio and Kryptronix.
        </p>
        <ul className="mt-6 list-disc space-y-2 pl-6">
          <li>Exact totals computed by code, never estimated by the AI.</li>
          <li>Buy links to the real in-stock listings each build uses.</li>
          <li>
            Compatibility checked by a deterministic rules engine — sockets, DDR generation,
            PSU wattage and physical clearances — that the AI cannot override. Anything it
            cannot verify is shown as unverified.
          </li>
          <li>
            AI consultant with the model of your choice: bring a free API key (Gemini or
            OpenRouter work). On the hosted demo your key stays in your browser and is never
            stored on the server.
          </li>
          <li>
            Free and open source under the MIT license. No accounts or tracking cookies. The
            hosted demo keeps anonymous daily totals only (no IPs, no chat content).
          </li>
        </ul>
        <nav className="mt-8 flex flex-wrap gap-4" aria-label="Learn more">
          <a className="underline" href="/help">
            Help and setup
          </a>
          {/* Guides live on the static site owned by G2. */}
          <a className="underline" href="https://manishmodak.github.io/pcbuildsage/">
            Build guides
          </a>
          <a className="underline" href="https://github.com/ManishModak/pcbuildsage">
            Source code
          </a>
        </nav>
      </main>
    </div>
  );
}
