/** A single 16px stroke family for functional UI symbols. */
const paths: Record<string, string> = {
  chat: '<path d="M3 3h14v10H8l-5 4z"/>',
  files: '<path d="M2 5h6l2 2h8v10H2z"/>',
  memory: '<path d="M6 17V3h10v14zM3 6h3m-3 4h3m-3 4h3m3-8h4m-4 4h4"/>',
  skills: '<path d="m7 5-5 5 5 5m6-10 5 5-5 5m-2-13-2 16"/>',
  jobs: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
  settings: '<path d="M3 5h14M3 10h14M3 15h14"/><circle cx="7" cy="5" r="2"/><circle cx="13" cy="10" r="2"/><circle cx="8" cy="15" r="2"/>',
  git: '<circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="5" r="2"/><path d="M5 6v8m0-4h5a5 5 0 0 0 5-3"/>',
  terminal: '<path d="m4 5 5 5-5 5m7 0h6"/>',
  artifact: '<path d="M5 2h7l4 4v12H5zM12 2v5h4M8 11h5m-5 3h5"/>',
  agents: '<circle cx="10" cy="6" r="3"/><path d="M4 18v-3a6 6 0 0 1 12 0v3"/>',
  models: '<rect x="4" y="3" width="12" height="14" rx="2"/><path d="M7 7h6m-6 4h6m-6 3h2"/>',
  rooms: '<circle cx="7" cy="6" r="3"/><path d="M2 17v-2a5 5 0 0 1 10 0v2m1-14a3 3 0 0 1 0 6m2 3a4 4 0 0 1 3 4v1"/>',
  plugins: '<path d="M7 2v4m6-4v4M5 6h10v4a5 5 0 0 1-10 0zm5 9v3"/>',
  workspace: '<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M2 7h16M7 7v10"/>',
  '+': '<path d="M10 3v14M3 10h14"/>',
};
export const icon = (name: string) => `<span class="glyph" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.artifact}</svg></span>`;
