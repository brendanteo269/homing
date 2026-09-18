import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

/**
 * One family throughout. Manrope brings a calm, rounded construction without
 * becoming a display face, and it carries tabular figures — which is what a
 * second, monospaced family was really here for: the measured values, the
 * storey counts and the clock all hold their columns without it.
 */
const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
});
export const metadata: Metadata = {
  title: "Homing — sun and views for Singapore homes",
  description:
    "Sun, shade, and view analysis for any Singapore flat, from open data and solar geometry.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-SG" className={sans.variable}>
      <body>{children}</body>
    </html>
  );
}
