import Link from "next/link";
import { AsciiSky } from "./ascii-sky";
import { LeafMark, Wordmark } from "./brand";
import { StartSetupButton } from "./landing-actions";
import { RuneText } from "./rune-text";
import { ThemeSwitcher } from "./theme-switcher";
import { SampleConversation } from "@/features/chat/sample-conversation";

// What the build is checked for, and what it isn't. Not a sequence, so no numbers.
const PROMISES = [
  {
    title: "Exact totals, added up by code",
    body: "The AI picks the parts. Code adds up the prices, so the total is exact for the listings shown."
  },
  {
    title: "Compatibility checked by rules",
    body:
      "Socket, memory type, power supply wattage and case clearances are checked by a rules engine the AI can't override. Anything it can't verify is marked unverified."
  },
  {
    title: "Buy links for every part",
    body:
      "Each part links to the listing it was priced from. Prices and stock are snapshots refreshed twice a day, so confirm them at checkout."
  },
  {
    title: "Your API key stays yours",
    body:
      "On the hosted demo it's kept in this tab's session storage and sent with each request only so the server can forward it to your provider. The server never writes it to disk, stores or logs it. Run PCBuildSage yourself and only your machine and your provider see it."
  },
  {
    title: "Free, open source, no account",
    body:
      "MIT licensed. No accounts and no tracking cookies. The hosted demo keeps anonymous daily totals only: no IPs, no chat content."
  }
];

// The first screen for new visitors, and the HTML crawlers see for `/`.
// Server-rendered static copy only: no LLM calls, no cookies. The example
// builds are a static fixture, so a visitor sees a real build, its checks and
// its buy links before being asked for any key. HomeClient wires the
// "Plan my build" button to open setup. Never call any build "best".
export function LandingContent() {
  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="relative z-10 mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 rounded-btn" aria-label="PCBuildSage home">
          <LeafMark size={24} />
          <Wordmark className="text-lg" />
        </Link>
        <nav className="ml-auto flex items-center gap-1 text-sm" aria-label="Site">
          <a className="hidden rounded-btn px-3 py-2 text-text-secondary hover:text-text sm:inline" href="/help">
            Help
          </a>
          {/* Guides live on the static site owned by G2. */}
          <a
            className="hidden rounded-btn px-3 py-2 text-text-secondary hover:text-text sm:inline"
            href="https://manishmodak.github.io/pcbuildsage/"
          >
            Build guides
          </a>
          <a
            className="rounded-btn px-3 py-2 text-text-secondary hover:text-text"
            href="https://github.com/ManishModak/pcbuildsage"
          >
            Source code
          </a>
          <ThemeSwitcher />
        </nav>
      </header>

      <main>
        <section className="relative overflow-hidden">
          <AsciiSky />
          <div className="relative mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-10 px-4 pb-16 pt-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-14 lg:pb-24 lg:pt-16">
            <div data-sky-quiet="" className="flex flex-col items-start self-start">
              <h1 className="type-display text-[clamp(2.5rem,5.4vw,4rem)] text-text">
                <RuneText text="Your budget." />
                <br />
                <RuneText text="Your parts." delay={180} />
                <br />
                <RuneText text="A build that fits." delay={360} />
              </h1>
              <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-text-secondary">
                Tell PCBuildSage what you&apos;ll use the PC for, what you already own and what you can
                spend. You get a parts list priced at Indian retailers such as MDComputers, Vedant
                Computers and Kryptronix, a buy link for every part, and the compatibility checks it
                passed.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
                <StartSetupButton>Plan my build</StartSetupButton>
                <a
                  href="/help/api-key"
                  className="text-sm font-medium text-accent underline-offset-4 hover:underline"
                >
                  How your API key is used
                </a>
              </div>
              <p className="mt-4 max-w-[34rem] text-sm text-text-muted">
                Free. Bring a free Gemini or OpenRouter key and set up in about two minutes, or run it
                on your own machine with a local model.
              </p>
            </div>

            <div data-sky-quiet="" className="self-start">
              <SampleConversation currency="INR" className="shadow-[0_30px_80px_-40px_color-mix(in_srgb,var(--bg)_70%,black)]" />
            </div>
          </div>
        </section>

        <section className="border-t border-border" aria-labelledby="promises-heading">
          <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="promises-heading" className="type-title max-w-xl text-2xl text-text">
              What you can rely on
            </h2>
            <dl className="mt-8 grid gap-x-12 sm:grid-cols-2 lg:grid-cols-3">
              {PROMISES.map((promise) => (
                <div key={promise.title} className="border-t border-border py-5">
                  <dt className="type-title text-lg text-text">{promise.title}</dt>
                  <dd className="mt-1.5 text-[15px] leading-relaxed text-text-secondary">{promise.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-text-muted sm:px-6">
          <span>PCBuildSage is free and open source under the MIT license.</span>
          <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Learn more">
            <a className="hover:text-text" href="/help">
              Help and setup
            </a>
            <a className="hover:text-text" href="https://manishmodak.github.io/pcbuildsage/">
              Build guides
            </a>
            <a className="hover:text-text" href="https://github.com/ManishModak/pcbuildsage">
              Source code
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
