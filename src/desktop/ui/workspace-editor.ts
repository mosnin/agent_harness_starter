import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { rust } from "@codemirror/lang-rust";
import { indentWithTab } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";

type Rpc = (method: string, args?: Record<string, unknown>) => Promise<any>;
type Document = { root: string; path: string; base: string; revision: string; state: EditorState };
const language = (path: string) => {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext ?? "")) return javascript({ typescript: ext?.startsWith("ts"), jsx: ext?.endsWith("x") });
  return ({ py: python, json, md: markdown, html, css, rs: rust } as Record<string, () => any>)[ext ?? ""]?.() ?? [];
};
export class WorkspaceEditor {
  readonly node = document.createElement("div");
  private tabs = document.createElement("div");
  private actions = document.createElement("div");
  private host = document.createElement("div");
  private status = document.createElement("div");
  private docs = new Map<string, Document>();
  private selected?: string;
  private root = "";
  private editor?: EditorView;
  private theme = new Compartment();
  constructor(private rpc: Rpc, private attach: (text: string) => void, private report: (e: unknown) => void) {
    this.node.className = "workspace-editor";
    this.tabs.className = "editor-tabs";
    this.tabs.setAttribute("role", "tablist");
    this.actions.className = "editor-actions";
    this.host.className = "editor-host";
    this.status.className = "editor-status";
    this.status.setAttribute("role", "status");
    this.node.append(this.tabs, this.actions, this.host, this.status);
    for (const [label, action] of [
      ["Save", () => this.save()], ["Find / replace", () => { if (this.editor) openSearchPanel(this.editor); }],
      ["Add selection to chat", () => this.context()], ["Reload from disk", () => this.reload()],
    ] as const) {
      const b = document.createElement("button"); b.textContent = label;
      b.onclick = () => { void Promise.resolve(action()).catch(this.report); };
      this.actions.append(b);
    }
  }
  mount(host: HTMLElement, root: string) {
    this.root = root;
    host.append(this.node);
    const selected = this.selected ? this.docs.get(this.selected) : undefined;
    if (selected?.root !== root) {
      const next = [...this.docs.entries()].find(([, d]) => d.root === root)?.[0];
      this.select(next);
    } else this.paintTabs();
    this.editor?.dispatch({ effects: this.theme.reconfigure(this.editorTheme()) });
    this.editor?.requestMeasure();
  }
  private editorTheme() {
    return EditorView.theme({
      "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg)", color: "var(--text)" },
      ".cm-scroller": { overflow: "auto", fontFamily: '"SFMono-Regular", Menlo, monospace', lineHeight: "1.65" },
      ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", borderRight: "1px solid var(--line)" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--panel)" },
      ".cm-cursor": { borderLeftColor: "var(--text)" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--hover)" },
      ".cm-panels, .cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--text)", borderColor: "var(--line)" },
      ".cm-search input, .cm-search button": { color: "var(--text)", background: "var(--bg)" },
      ".cm-content": { padding: "12px 0" },
    }, { dark: document.documentElement.dataset.theme === "dark" });
  }
  async open(root: string, path: string) {
    const key = JSON.stringify([root, path]);
    if (!this.docs.has(key)) {
      if (this.docs.size >= 30) throw new Error("Close a file tab before opening more than 30 files.");
      const file = await this.rpc("files.read", { root, path });
      if (file.image || typeof file.text !== "string") throw new Error("Open images from Artifacts or the file inspector.");
      let text = file.text, revision = file.revision, base = file.text;
      try {
        const draft = JSON.parse(localStorage.getItem("hades.editor." + key) ?? "null");
        if (draft && typeof draft.text === "string") { text = draft.text; revision = typeof draft.revision === "string" ? draft.revision : "recovery-needs-review"; base = typeof draft.base === "string" ? draft.base : file.text; this.status.textContent = "Recovered unsaved changes. Reload from disk to discard them."; }
      } catch { /* invalid recovery data never replaces the file */ }
      const doc: Document = { root, path: file.path, base, revision, state: this.state(key, text) };
      this.docs.set(key, doc);
    }
    if (this.root === root) { this.select(key); this.editor?.focus(); }
  }
  private state(key: string, text: string) {
    const path = JSON.parse(key)[1];
    return EditorState.create({ doc: text, extensions: [
      basicSetup, language(path), keymap.of([indentWithTab, { key: "Mod-s", run: () => { void this.save().catch(this.report); return true; } }]),
      this.theme.of(this.editorTheme()),
      EditorView.updateListener.of(update => {
        const doc = this.docs.get(key);
        if (!doc) return;
        doc.state = update.state;
        if (update.docChanged) { this.persist(key, doc); this.paintTabs(); }
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head, line = update.state.doc.lineAt(pos);
          this.status.textContent = `${doc.path} · Ln ${line.number}, Col ${pos - line.from + 1}${this.dirty(doc) ? " · Unsaved" : ""}`;
        }
      }),
    ] });
  }
  private dirty(doc: Document) { return doc.state.doc.toString() !== doc.base; }
  private persist(key: string, doc: Document) {
    try {
      if (this.dirty(doc)) localStorage.setItem("hades.editor." + key, JSON.stringify({ text: doc.state.doc.toString(), revision: doc.revision, base: doc.base }));
      else localStorage.removeItem("hades.editor." + key);
    } catch { this.status.textContent = "Draft recovery storage is full. Save this file before quitting."; }
  }
  private select(key?: string) {
    this.selected = key;
    const doc = key && this.docs.get(key);
    if (!doc) {
      this.editor?.destroy(); this.editor = undefined;
      this.host.textContent = "Open a file from the project explorer.";
      this.status.textContent = "";
    } else if (this.editor) this.editor.setState(doc.state);
    else { this.host.replaceChildren(); this.editor = new EditorView({ state: doc.state, parent: this.host }); }
    this.actions.hidden = !doc;
    this.paintTabs();
  }
  private paintTabs() {
    this.tabs.replaceChildren();
    for (const [key, doc] of this.docs) {
      if (doc.root !== this.root) continue;
      const tab = document.createElement("div"); tab.className = "editor-tab" + (key === this.selected ? " selected" : "");
      const open = document.createElement("button"); open.textContent = doc.path.split("/").at(-1)! + (this.dirty(doc) ? " •" : "");
      open.title = doc.path; open.setAttribute("role", "tab"); open.setAttribute("aria-selected", String(key === this.selected)); open.onclick = () => this.select(key);
      const close = document.createElement("button"); close.textContent = "×"; close.setAttribute("aria-label", `Close ${doc.path}`);
      close.onclick = () => {
        if (this.dirty(doc)) { this.report(new Error("Save this file or reload it from disk before closing.")); return; }
        this.docs.delete(key);
        if (key === this.selected) this.select([...this.docs.entries()].find(([, d]) => d.root === this.root)?.[0]);
        else this.paintTabs();
      };
      tab.append(open, close); this.tabs.append(tab);
    }
  }
  async save() {
    const key = this.selected, doc = key && this.docs.get(key);
    if (!doc || !this.dirty(doc)) return;
    const content = doc.state.doc.toString();
    const result = await this.rpc("files.save", { root: doc.root, path: doc.path, content, expectedRevision: doc.revision });
    doc.base = content; doc.revision = result.revision;
    this.persist(key!, doc); this.paintTabs(); this.status.textContent = "Saved · Checkpoint created";
  }
  async reload() {
    const key = this.selected, doc = key && this.docs.get(key);
    if (!doc) return;
    if (this.dirty(doc) && !window.confirm(`Discard unsaved changes to ${doc.path}?`)) return;
    const file = await this.rpc("files.read", { root: doc.root, path: doc.path });
    if (typeof file.text !== "string") throw new Error("The file is no longer editable text.");
    doc.base = file.text; doc.revision = file.revision; doc.state = this.state(key!, file.text);
    this.persist(key!, doc); if (this.selected === key && this.root === doc.root) this.select(key); this.status.textContent = "Reloaded from disk";
  }
  private context() {
    const doc = this.selected && this.docs.get(this.selected);
    if (!doc || !this.editor) return;
    const selection = this.editor.state.selection.main;
    const text = selection.empty ? doc.state.doc.toString() : doc.state.doc.sliceString(selection.from, selection.to);
    if (text.length > 80_000) throw new Error("Select a smaller section to add to chat (80,000 characters maximum).");
    this.attach(`\n\nFile: ${doc.path}${selection.empty ? "" : ` (line ${doc.state.doc.lineAt(selection.from).number})`}\n\`\`\`\n${text}\n\`\`\``);
  }
  destroy() { this.editor?.destroy(); }
}
