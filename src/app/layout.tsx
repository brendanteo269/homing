import type { Metadata } from "next";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import "./globals.css";

/**
 * Manrope brings a calm, rounded construction without becoming a display face;
 * IBM Plex Mono remains strictly for measured values and compact controls.
 */
const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Homing — sun and views for Singapore homes",
  description:
    "Sun, shade, and view analysis for any Singapore flat, from open data and solar geometry.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-SG" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
