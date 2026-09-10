// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { WorkspaceEditor } from "../ui/workspace-editor";
const editors: WorkspaceEditor[] = [];
afterEach(() => { for (const e of editors) e.destroy(); editors.length = 0; document.body.replaceChildren(); localStorage.clear(); });
function setup(rpc: any) {
  const host = document.createElement("div"); document.body.append(host);
  const attach = vi.fn(); const editor = new WorkspaceEditor(rpc, attach, e => { throw e; }); editors.push(editor); editor.mount(host, "/a");
  return { editor, host, attach, view: () => EditorView.findFromDOM(host.querySelector(".cm-editor")!)! };
}
describe("integrated CodeMirror editor behavior", () => {
  it("keeps undo history across tabs and saves to the document's owning project", async () => {
    const rpc = vi.fn(async (method, args) => method === "files.read" ? { path: args.path, text: args.path, revision: "original" } : { revision: "saved" });
    const f = setup(rpc); await f.editor.open("/a", "first.ts"); f.view().dispatch({ changes: { from: 0, to: 8, insert: "draft" } });
    await f.editor.open("/a", "second.ts"); await f.editor.open("/a", "first.ts");
    expect(f.view().state.doc.toString()).toBe("draft"); undo(f.view()); expect(f.view().state.doc.toString()).toBe("first.ts");
    f.view().dispatch({ changes: { from: 0, to: 8, insert: "saved draft" } }); await f.editor.save();
    expect(rpc).toHaveBeenCalledWith("files.save", { root: "/a", path: "first.ts", content: "saved draft", expectedRevision: "original" });
    f.editor.mount(f.host, "/b"); expect(f.host.querySelector(".cm-editor")).toBeNull(); f.editor.mount(f.host, "/a"); expect(f.view().state.doc.toString()).toBe("saved draft");
  });
  it("recovers the original revision so a stale draft cannot overwrite a newer disk edit", async () => {
    let disk = { text: "original", revision: "v1" };
    const rpc = vi.fn(async (method, args) => { if (method === "files.read") return { path: args.path, ...disk }; if (args.expectedRevision !== disk.revision) throw new Error("changed on disk"); disk = { text: args.content, revision: "saved" }; return { revision: disk.revision }; });
    const first = setup(rpc); await first.editor.open("/a", "note.md"); first.view().dispatch({ changes: { from: 0, to: 8, insert: "unsaved draft" } }); first.editor.destroy();
    disk = { text: "someone else's edit", revision: "v2" };
    const recovered = setup(rpc); await recovered.editor.open("/a", "note.md"); expect(recovered.view().state.doc.toString()).toBe("unsaved draft");
    await expect(recovered.editor.save()).rejects.toThrow("changed on disk"); expect(disk.text).toBe("someone else's edit");
    expect(localStorage.getItem('hades.editor.["/a","note.md"]')).toContain("unsaved draft");
  });
  it("does not reopen an old project's file when its read finishes after navigation", async () => {
    let finish!: (v: any) => void;
    const f = setup(() => new Promise(resolve => finish = resolve));
    const reading = f.editor.open("/a", "slow.ts"); f.editor.mount(f.host, "/b"); finish({ path: "slow.ts", text: "old project", revision: "v1" }); await reading;
    expect(f.host.querySelector(".cm-editor")).toBeNull(); f.editor.mount(f.host, "/a"); expect(f.view().state.doc.toString()).toBe("old project");
  });
});
