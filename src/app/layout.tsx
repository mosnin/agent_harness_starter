import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hades — verified agent swarms",
  description:
    "Provenance-carrying, abstention-by-default agent swarms. Verified work per dollar, not vibes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
