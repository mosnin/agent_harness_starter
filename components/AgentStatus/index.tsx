"use client";

interface AgentStatusProps {
  statusText: string;
  onCancel?: () => void;
}

export function AgentStatus({ statusText, onCancel }: AgentStatusProps) {
  return (
    <div className="flex items-center justify-between border-t bg-gray-50 px-4 py-2 text-sm text-gray-600">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
        </span>
        <span>{statusText || "Running…"}</span>
      </div>
      {onCancel && (
        <button
          onClick={onCancel}
          className="text-red-500 hover:text-red-700 font-medium transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
