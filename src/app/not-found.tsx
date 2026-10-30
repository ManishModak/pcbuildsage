import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AsciiOwl } from "@/components/app/ascii-owl";
import { AsciiSky } from "@/components/app/ascii-sky";
import { Icon } from "@/components/ui/icon";

export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg p-6 text-text">
      <AsciiSky />
      <div className="relative flex max-w-xl flex-col items-start gap-6 sm:flex-row sm:items-center sm:gap-8">
        <AsciiOwl />
        <div className="flex flex-col items-start gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="type-title text-2xl text-text">Page not found</h1>
            <p className="text-base leading-[1.65] text-text-secondary">
              This address doesn&apos;t lead anywhere. Check the link, or start a new build from the home page.
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center gap-2 rounded-btn bg-accent px-4 text-sm font-semibold text-on-accent transition-colors duration-150 hover:opacity-90"
          >
            <Icon icon={ArrowLeft} size={16} />
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
