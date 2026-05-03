import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agentic Next.js Starter",
  description:
    "OpenAI Agents SDK + MCP + Composio + Tavily + Daytona/Modal + Supabase/Convex/Prisma + Clerk/Auth0",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
