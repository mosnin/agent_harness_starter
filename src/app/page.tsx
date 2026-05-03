import Link from "next/link";

const features = [
  {
    icon: "🤖",
    title: "OpenAI Agents SDK",
    desc: "Multi-agent orchestration with handoffs, streaming, and cancellation built in.",
  },
  {
    icon: "🔌",
    title: "MCP Server + Client",
    desc: "Expose your tools to any MCP client. Consume external MCP servers.",
  },
  {
    icon: "🔧",
    title: "Composio",
    desc: "Per-user OAuth for 100+ apps: GitHub, Slack, Gmail, Notion, and more.",
  },
  {
    icon: "🌐",
    title: "Tavily Search",
    desc: "Real-time web search tool wired directly into your agents.",
  },
  {
    icon: "🖥️",
    title: "Parallel Browsers",
    desc: "Browserbase or local Playwright for running multiple browser sessions simultaneously.",
  },
  {
    icon: "📦",
    title: "Daytona + Modal",
    desc: "Sandboxed code execution — pick your provider via a single env var.",
  },
  {
    icon: "🗄️",
    title: "Swappable Database",
    desc: "Supabase, Convex, or Prisma. Switch with DB_PROVIDER. Defaults to in-memory.",
  },
  {
    icon: "🔑",
    title: "Swappable Auth",
    desc: "Clerk or Auth0. Switch with AUTH_PROVIDER. No auth needed for local dev.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-6 border border-blue-100">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
          Production-ready agentic scaffold
        </div>

        <h1 className="text-5xl font-bold text-gray-900 mb-4 leading-tight">
          Next.js Agentic Starter Kit
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto mb-10">
          Clone, configure your env vars, and ship. Every integration wired and tested —
          no debugging required.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/chat"
            className="px-8 py-3.5 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors shadow-md shadow-blue-200"
          >
            Open Chat Demo →
          </Link>
          <a
            href="https://github.com/mosnin/agent_harness_starter"
            target="_blank"
            rel="noopener noreferrer"
            className="px-8 py-3.5 rounded-xl border border-gray-300 text-gray-700 font-semibold hover:bg-white transition-colors"
          >
            View on GitHub
          </a>
        </div>
      </section>

      {/* Features grid */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {features.map((f) => (
            <div
              key={f.title}
              className="bg-white rounded-2xl p-5 border border-gray-200 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="font-semibold text-gray-900 mb-1">{f.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Quick start */}
      <section className="max-w-3xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-bold text-gray-900 mb-6 text-center">Quick Start</h2>
        <div className="bg-gray-900 rounded-2xl p-6 font-mono text-sm text-green-400 space-y-1 shadow-xl">
          <p><span className="text-gray-500"># 1. Clone</span></p>
          <p>git clone https://github.com/mosnin/agent_harness_starter</p>
          <p>cd agent_harness_starter</p>
          <p className="pt-2"><span className="text-gray-500"># 2. Configure</span></p>
          <p>cp .env.example .env.local</p>
          <p><span className="text-gray-400"># add OPENAI_API_KEY at minimum</span></p>
          <p className="pt-2"><span className="text-gray-500"># 3. Install & run</span></p>
          <p>npm install && npm run dev</p>
          <p className="pt-2 text-blue-400">→ http://localhost:3000/chat</p>
        </div>
      </section>
    </main>
  );
}
