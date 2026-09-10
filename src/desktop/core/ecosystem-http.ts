export class PluginHttpError extends Error {
  constructor(readonly status: number) {
    super(`Connected service returned HTTP ${status}`);
  }
}
export async function boundedPluginJson(
  fetcher: typeof fetch,
  allowedOrigins: readonly string[],
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash ||
    !allowedOrigins.includes(target.origin)
  )
    throw new Error("Plugin endpoint is outside its approved origin");
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  const response = await fetcher(target.href, {
    ...init,
    signal,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  if (signal.aborted) {
    await response.body?.cancel();
    signal.throwIfAborted();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PluginHttpError(response.status);
  }
  if (response.status === 204) return {};
  const type = response.headers.get("content-type")?.split(";")[0].trim();
  if (type !== "application/json" && !type?.endsWith("+json")) {
    await response.body?.cancel();
    throw new Error("Connected service did not return JSON");
  }
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Plugin response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Connected service returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("Plugin response is too large");
      chunks.push(part.value);
    }
    signal.throwIfAborted();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Connected service returned invalid JSON");
  }
}
