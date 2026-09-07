import { randomUUID } from "node:crypto";
type Download = {
  id: string;
  model: string;
  endpoint: string;
  status: string;
  completed?: number;
  total?: number;
  done: boolean;
  error?: string;
};
/** Uses an existing Ollama runtime. Pulls are asynchronous so approval/cancel RPC stays responsive. */
export class LocalModels {
  private ollamaEndpoints = new Set<string>();
  private downloads = new Map<
    string,
    { state: Download; controller: AbortController }
  >();
  constructor(private emit: (event: Record<string, unknown>) => void) {}
  endpoint(value: unknown) {
    const url = new URL(
      typeof value === "string" ? value : "http://127.0.0.1:11434",
    );
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Choose a loopback Ollama endpoint");
    return url.origin;
  }
  private model(value: unknown) {
    if (
      typeof value !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/.test(value) ||
      value.includes("..")
    )
      throw new Error("Enter a valid Ollama model name");
    return value;
  }
  async list(endpoint: unknown) {
    const url = this.endpoint(endpoint);
    try {
      const r = await fetch(url + "/api/tags", {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!r.ok) throw new Error(`Ollama returned ${r.status}`);
      const data = (await r.json()) as { models?: unknown[] };
      if (Array.isArray(data.models)) this.ollamaEndpoints.add(url);
      return {
        endpoint: url,
        models: (data.models ?? []).slice(0, 200),
        downloads: this.states(),
      };
    } catch {
      throw new Error(
        "Ollama is not reachable. Start Ollama, then refresh. Hades connects to its local API.",
      );
    }
  }
  states() {
    return [...this.downloads.values()].map((x) => x.state);
  }
  async contextWindow(endpoint: unknown, model: string): Promise<number | undefined> {
    try {
      const url = this.endpoint(endpoint);
      if (new URL(url).port !== "11434" && !this.ollamaEndpoints.has(url)) return undefined;
      const response = await fetch(url + "/api/ps", { signal: AbortSignal.timeout(2000), redirect: "error" });
      if (!response.ok) return undefined; // Other OpenAI-compatible servers have no Ollama API.
      const body = await response.json() as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
      const entry = body.models?.find(entry => [entry.name, entry.model].includes(model));
      const value = entry?.context_length;
      return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } catch { return undefined; }
  }
  pull(endpoint: unknown, model: unknown) {
    const url = this.endpoint(endpoint),
      name = this.model(model);
    if ([...this.downloads.values()].some((x) => !x.state.done))
      throw new Error("Finish or cancel the current download first");
    const state: Download = {
      id: randomUUID(),
      model: name,
      endpoint: url,
      status: "Starting",
      done: false,
    };
    const controller = new AbortController();
    this.downloads.set(state.id, { state, controller });
    const notify = () => this.emit({ kind: "desktop.download", ...state });
    notify();
    void (async () => {
      try {
        const response = await fetch(url + "/api/pull", {
          method: "POST",
          body: JSON.stringify({ model: name, stream: true }),
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok || !response.body)
          throw new Error(`Download failed (${response.status})`);
        const decoder = new TextDecoder();
        let buffer = "",
          success = false;
        const consume = (line: string) => {
          if (!line.trim()) return;
          const event = JSON.parse(line);
          if (event.error) throw new Error(String(event.error).slice(0, 500));
          state.status = String(event.status ?? "Downloading").slice(0, 200);
          state.completed =
            typeof event.completed === "number" ? event.completed : undefined;
          state.total =
            typeof event.total === "number" ? event.total : undefined;
          if (event.status === "success") success = true;
          notify();
        };
        for await (const chunk of response.body as any) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 1_000_000)
            throw new Error("Invalid Ollama progress stream");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            consume(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        }
        consume(buffer + decoder.decode());
        if (!success)
          throw new Error("Download ended before Ollama confirmed success");
        state.status = "Installed";
      } catch (e) {
        state.status = controller.signal.aborted ? "Cancelled" : "Failed";
        if (!controller.signal.aborted)
          state.error = e instanceof Error ? e.message : "Download failed";
      } finally {
        state.done = true;
        notify();
      }
    })();
    return state;
  }
  cancel(id: unknown) {
    this.downloads.get(String(id))?.controller.abort();
    return true;
  }
  async remove(endpoint: unknown, model: unknown) {
    if (this.states().some((d) => !d.done))
      throw new Error("Wait for the current download before removing a model");
    const r = await fetch(this.endpoint(endpoint) + "/api/delete", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model(model) }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!r.ok) throw new Error(`Could not remove model (${r.status})`);
    return true;
  }
  close() {
    for (const d of this.downloads.values()) d.controller.abort();
  }
}
