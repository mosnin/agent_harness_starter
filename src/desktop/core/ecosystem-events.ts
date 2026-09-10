import { createParser } from "eventsource-parser";
import { PluginHttpError } from "./ecosystem-http";

/** SSE notifications cannot supply records, credentials, arbitrary URLs or new authority. */
export async function streamPluginEvents(
  fetcher: typeof fetch,
  origins: readonly string[],
  url: string,
  token: string,
  signal: AbortSignal,
  onChange: () => Promise<unknown>,
  onRevoked: () => void,
) {
  signal.throwIfAborted();
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash ||
    !origins.includes(target.origin)
  )
    throw new Error("Plugin event stream is outside its approved origin");
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const response = await fetcher(target.href, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal: lifetime,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  if (lifetime.aborted) {
    await response.body?.cancel();
    lifetime.throwIfAborted();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PluginHttpError(response.status);
  }
  if (
    response.headers.get("content-type")?.split(";")[0].trim() !==
      "text/event-stream" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Expected a plugin event stream");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    changed = false,
    revoked = false,
    events = 0;
  const parser = createParser({
    onEvent: (event) => {
      if (++events > 1000 || event.data.length > 8192)
        throw new Error("Plugin event stream exceeded its limit");
      if (event.event === "change" || event.event === "ready") changed = true;
      if (event.event === "revoked") revoked = true;
      if (event.event === "error" || event.event === "unavailable")
        throw new Error("Plugin event subscription is unavailable");
    },
  });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  lifetime.addEventListener("abort", cancel, { once: true });
  try {
    // Catch up after subscribing, so a change between the last read and connection is retained.
    lifetime.throwIfAborted();
    await onChange();
    for (;;) {
      lifetime.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 256 * 1024)
        throw new Error("Plugin event stream exceeded its limit");
      parser.feed(decoder.decode(chunk.value, { stream: true }));
      if (revoked) {
        onRevoked();
        return;
      }
      if (changed) {
        changed = false;
        await onChange();
      }
    }
  } finally {
    lifetime.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    parser.reset();
  }
}
