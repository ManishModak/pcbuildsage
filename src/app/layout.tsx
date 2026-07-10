import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppProvider } from "../components/app/app-provider";
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
  title: "PCBuildSage — Build Consultant",
  description:
    "A calm expert at a well-lit workbench: local-first PC hardware aggregator and conversational build consultant with verifiable compatibility checks.",
  applicationName: "PCBuildSage"
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
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
