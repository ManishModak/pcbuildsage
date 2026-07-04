import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PCBuildSage",
  description: "Local-first PC hardware aggregator and build consultant"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="sage-dark">
      <body>{children}</body>
    </html>
  );
}
