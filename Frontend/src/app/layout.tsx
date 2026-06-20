import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers";
import { env } from "@/lib/constants/env";
import "@/styles/globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: `${env.appName} — Demand Forecasting`,
    template: `%s · ${env.appName}`,
  },
  description:
    "Retail demand forecasting and scenario planning platform.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // suppressHydrationWarning: next-themes sets the theme class on <html> before
  // hydration, which would otherwise trip React's mismatch warning.
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable} font-sans`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
