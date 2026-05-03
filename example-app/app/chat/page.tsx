import { AgentChat } from "@/components/AgentChat";

export default function ChatPage() {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3 bg-white">
        <div className="flex items-center gap-3">
          <a href="/" className="text-gray-400 hover:text-gray-600 transition-colors text-sm">
            ← Home
          </a>
          <span className="text-gray-300">|</span>
          <h1 className="font-semibold text-gray-900">Agent Demo</h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
          Research Agent
        </div>
      </header>
      <div className="flex-1 overflow-hidden">
        <AgentChat
          agentName="research"
          placeholder="Ask me to research anything — I can search the web and browse pages…"
        />
      </div>
    </div>
  );
}
