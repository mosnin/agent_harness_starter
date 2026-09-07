import { mountWorkbench } from "./workbench";
function report(error: unknown) {
  const root = document.getElementById("root");
  if (root) {
    root.replaceChildren();
    const title = document.createElement("h1");
    title.textContent = "Hades could not start";
    const message = document.createElement("pre");
    message.textContent =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    root.append(title, message);
  }
}
window.addEventListener("error", (e) => {
  // WebKit defers ResizeObserver notifications to the next frame. This is not a crash.
  if (e.message.startsWith("ResizeObserver loop")) return;
  console.error(e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => console.error(e.reason));
function boot() {
  const root = document.getElementById("root");
  if (root)
    try {
      mountWorkbench(root);
    } catch (e) {
      report(e);
    }
}
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot);
else boot();
