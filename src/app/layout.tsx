import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppProvider } from "../components/app/app-provider";
import { SITE_URL } from "../lib/seo";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter"
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono-jb"
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: {
    canonical: "/"
  },
  title: "PCBuildSage — AI PC build planner for India",
  description:
    "Describe your budget and needs in plain language and get PC builds from parts in stock at Indian retailers today, with exact totals, buy links and compatibility checked by code. Free and open source.",
  applicationName: "PCBuildSage",
  openGraph: {
    type: "website",
    siteName: "PCBuildSage",
    url: "/",
    title: "PCBuildSage — AI PC build planner for India",
    description:
      "PC builds from parts in stock at Indian retailers today, with exact totals, buy links and compatibility checked by code. Free and open source."
  },
  twitter: {
    card: "summary_large_image",
    title: "PCBuildSage — AI PC build planner for India",
    description:
      "PC builds from parts in stock at Indian retailers today, with exact totals, buy links and compatibility checked by code. Free and open source."
  }
};

export const viewport: Viewport = {
  themeColor: "#0e1210",
  width: "device-width",
  initialScale: 1
};

// Applies the saved theme's token set before first paint to avoid a flash of the
// default sage-dark palette when the user has selected another theme.
const themeBootstrap = `
(function () {
  try {
    var raw = localStorage.getItem("pcbuildsage:themeTokens");
    if (!raw) return;
    var parsed = JSON.parse(raw);
    var root = document.documentElement;
    if (parsed && parsed.tokens) {
      Object.keys(parsed.tokens).forEach(function (key) {
        root.style.setProperty(key, parsed.tokens[key]);
      });
    }
    if (parsed && parsed.name) root.setAttribute("data-theme", parsed.name);
    if (parsed && parsed.mode) root.setAttribute("data-theme-mode", parsed.mode);
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="sage-dark"
      data-theme-mode="dark"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body suppressHydrationWarning>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
