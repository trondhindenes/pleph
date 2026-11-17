const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;
const { openUrl } = window.__TAURI__.opener;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const $ = (s) => document.querySelector(s);
const el = {
  app: $("#app"), tree: $("#tree"), doc: $("#doc"), scroller: $("#scroller"), crumbs: $("#crumbs"),
  filter: $("#filter"), folderBtn: $("#folder-btn"), folderName: $("#folder-name"),
  stats: $("#stats"), themeBtn: $("#theme-btn"), resizer: $("#resizer"), topbar: $(".topbar"),
};

const state = {
  scan: null,             // result of scan_folder
  nodes: new Map(),       // path -> node
  files: [],              // flat list of { path, name, rel, lname, lrel }
  expanded: new Set(),
  current: null,
  history: [], hIndex: -1,
  renderSeq: 0,
  kbIndex: -1,            // keyboard selection in the filtered list
};

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------------------------------------------------------------- paths

const MD_RE = /\.(md|markdown|mdown|mkdn?)$/i;
const dirname = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
function normalize(p) {
  const out = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop(); else out.push(s);
  }
  return "/" + out.join("/");
}
function resolveFrom(file, href) {
  let target = href;
  try { target = decodeURIComponent(href); } catch {}
  // A leading slash means "repo root", like on GitHub.
  if (target.startsWith("/")) return normalize((state.scan?.root ?? "") + target);
  return normalize(dirname(file) + "/" + target);
}
const rel = (p) => (state.scan && p.startsWith(state.scan.root + "/")) ? p.slice(state.scan.root.length + 1) : p;

// ---------------------------------------------------------------- icons

const ICON = {
  chev: '<svg class="chev" viewBox="0 0 16 16" width="14" height="14"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dir: '<svg class="ico" viewBox="0 0 16 16" width="14" height="14"><path d="M1.75 3.5c0-.55.45-1 1-1h3.1l1.4 1.5h6c.55 0 1 .45 1 1v7.25c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  file: '<svg class="ico" viewBox="0 0 16 16" width="14" height="14"><path d="M4 1.75h5l3.25 3.25v8.25c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V2.75c0-.55.45-1 1-1z M9 1.75V5h3.25" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 8.5h5M5.5 11h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  system: '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  dark: '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};

// ---------------------------------------------------------------- theme

const THEMES = ["system", "light", "dark"];
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  el.themeBtn.innerHTML = ICON[t];
  el.themeBtn.title = `Theme: ${t} (click to change)`;
  store.set("theme", t);
}
el.themeBtn.onclick = () => applyTheme(THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % 3]);
applyTheme(store.get("theme") ?? "system");

// ---------------------------------------------------------------- folder

async function pickFolder() {
  const dir = await openDialog({ directory: true, multiple: false, title: "Open folder" });
  if (dir) await openFolder(dir);
}

async function openFolder(path, { restore = false, file = null } = {}) {
  let scan;
  try {
    scan = await invoke("scan_folder", { path });
  } catch (e) {
    showError(e);
    return;
  }
  state.scan = scan;
  state.nodes.clear();
  state.files = [];
  state.expanded.clear();
  state.history = []; state.hIndex = -1;
  index(scan.tree);
  store.set("folder", scan.root);
  invoke("set_folder", { folder: scan.root }).catch(() => {});

  el.folderName.textContent = scan.name;
  el.folderBtn.title = `${scan.root}\nClick to open another folder (⌘O)`;
  el.stats.textContent = `${scan.count} file${scan.count === 1 ? "" : "s"} · ${scan.ms} ms`;
  el.filter.value = "";

  const last = restore && store.get("file:" + scan.root);
  const start = file ?? ((last && state.nodes.has(last)) ? last : scan.readme);
  if (start) {
    await openFile(start);
  } else {
    state.current = null;
    renderTree();
    showWelcome(scan.count
      ? `<h1>${esc(scan.name)}</h1><p>${scan.count} markdown files. Pick one in the sidebar.</p>`
      : `<h1>${esc(scan.name)}</h1><p>No markdown files in this folder.</p><button class="primary" data-action="open">Open another folder</button>`);
    setCrumbs(null);
  }
}

function index(nodes) {
  for (const n of nodes) {
    state.nodes.set(n.path, n);
    if (n.dir) index(n.children ?? []);
    else {
      const r = rel(n.path);
      state.files.push({ path: n.path, name: n.name, rel: r, lname: n.name.toLowerCase(), lrel: r.toLowerCase() });
    }
  }
}

// ---------------------------------------------------------------- tree

function renderTree() {
  if (el.filter.value.trim()) return renderFiltered();
  if (!state.scan) { el.tree.replaceChildren(); return; }
  el.tree.replaceChildren(buildList(state.scan.tree, 0));
}

function buildList(nodes, depth) {
  const ul = document.createElement("ul");
  for (const n of nodes) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    const open = n.dir && state.expanded.has(n.path);
    row.className = "row" + (n.dir ? " dir" : "") + (open ? " open" : "") + (n.path === state.current ? " active" : "");
    row.dataset.path = n.path;
    row.style.paddingLeft = 6 + depth * 14 + "px";
    row.innerHTML = (n.dir ? ICON.chev + ICON.dir : '<span class="chev"></span>' + ICON.file) + `<span class="name">${esc(n.name)}</span>`;
    li.append(row);
    if (open) li.append(buildList(n.children ?? [], depth + 1));
    ul.append(li);
  }
  return ul;
}

function toggleDir(row) {
  const path = row.dataset.path;
  const li = row.parentElement;
  if (state.expanded.has(path)) {
    state.expanded.delete(path);
    row.classList.remove("open");
    li.querySelector(":scope > ul")?.remove();
  } else {
    state.expanded.add(path);
    row.classList.add("open");
    const depth = Math.round((parseFloat(row.style.paddingLeft) - 6) / 14);
    li.append(buildList(state.nodes.get(path).children ?? [], depth + 1));
  }
}

function revealInTree(path) {
  let changed = false;
  for (let d = dirname(path); state.scan && d.startsWith(state.scan.root + "/"); d = dirname(d)) {
    if (!state.expanded.has(d)) { state.expanded.add(d); changed = true; }
  }
  if (changed || !el.tree.firstChild) renderTree();
  else {
    el.tree.querySelector(".row.active")?.classList.remove("active");
    el.tree.querySelector(`.row[data-path="${CSS.escape(path)}"]`)?.classList.add("active");
  }
  el.tree.querySelector(".row.active")?.scrollIntoView({ block: "nearest" });
}

// Filtered flat list: every whitespace-separated term must appear in the relative path.
function renderFiltered() {
  const terms = el.filter.value.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const f of state.files) {
    if (!terms.every((t) => f.lrel.includes(t))) continue;
    const score = terms.reduce((s, t) => s + (f.lname.includes(t) ? 0 : 1), 0) + (f.lname.startsWith(terms[0]) ? -1 : 0);
    hits.push([score, f]);
    if (hits.length > 2000) break;
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].rel.length - b[1].rel.length);
  const ul = document.createElement("ul");
  for (const [, f] of hits.slice(0, 300)) {
    const li = document.createElement("li");
    const d = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
    li.innerHTML = `<div class="row${f.path === state.current ? " active" : ""}" data-path="${esc(f.path)}" style="padding-left:6px">${ICON.file}<span class="name">${esc(f.name)}</span><span class="sub">${esc(d)}</span></div>`;
    ul.append(li);
  }
  el.tree.replaceChildren(hits.length ? ul : Object.assign(document.createElement("div"), { className: "empty", textContent: "No matches" }));
  setKb(hits.length ? 0 : -1);
}

function setKb(i) {
  const rows = el.tree.querySelectorAll(".row");
  rows[state.kbIndex]?.classList.remove("kb");
  state.kbIndex = Math.max(-1, Math.min(i, rows.length - 1));
  rows[state.kbIndex]?.classList.add("kb");
  rows[state.kbIndex]?.scrollIntoView({ block: "nearest" });
}

el.tree.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  if (row.classList.contains("dir")) toggleDir(row);
  else openFile(row.dataset.path);
});

el.tree.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  const row = e.target.closest(".row");
  if (!row || row.classList.contains("dir")) return;
  const path = row.dataset.path;
  const menu = await window.__TAURI__.menu.Menu.new({
    items: [{
      id: "vscode",
      text: "Edit in VS Code",
      action: () => invoke("open_in_vscode", { path }).catch((err) => flash(String(err))),
    }],
  });
  await menu.popup();
});

// Brief message in the sidebar footer.
function flash(msg) {
  const prev = el.stats.textContent;
  el.stats.textContent = msg;
  el.stats.style.color = "var(--caution)";
  setTimeout(() => { el.stats.textContent = prev; el.stats.style.color = ""; }, 4000);
}

el.filter.addEventListener("input", () => { state.kbIndex = -1; renderTree(); if (!el.filter.value && state.current) revealInTree(state.current); });
el.filter.addEventListener("keydown", (e) => {
  const filtering = !!el.filter.value.trim();
  if (e.key === "ArrowDown" && filtering) { e.preventDefault(); setKb(state.kbIndex + 1); }
  else if (e.key === "ArrowUp" && filtering) { e.preventDefault(); setKb(state.kbIndex - 1); }
  else if (e.key === "Enter" && filtering) {
    const row = el.tree.querySelectorAll(".row")[state.kbIndex];
    if (row) { openFile(row.dataset.path); el.filter.value = ""; renderTree(); el.filter.blur(); }
  } else if (e.key === "Escape") {
    el.filter.value = ""; renderTree(); el.filter.blur();
    if (state.current) revealInTree(state.current);
  }
});

// ---------------------------------------------------------------- document

async function openFile(path, { push = true, keepScroll = false, hash = null } = {}) {
  const seq = ++state.renderSeq;
  let html;
  try {
    html = await invoke("render_file", { path });
  } catch (e) {
    if (seq === state.renderSeq) showError(e);
    return;
  }
  if (seq !== state.renderSeq) return; // a newer request won

  const tpl = document.createElement("template");
  tpl.innerHTML = html; // inert: images don't load until we fix their src
  postProcess(tpl.content, path);

  const top = el.scroller.scrollTop;
  el.doc.replaceChildren(tpl.content);
  highlight();

  const changed = state.current !== path;
  state.current = path;
  if (state.scan) store.set("file:" + state.scan.root, path);
  if (push && changed) {
    state.history.splice(state.hIndex + 1);
    state.history.push(path);
    state.hIndex = state.history.length - 1;
  }

  if (hash) scrollToId(hash);
  else el.scroller.scrollTop = keepScroll ? top : 0;

  setCrumbs(path);
  if (!el.filter.value.trim()) revealInTree(path);
  else el.tree.querySelectorAll(".row").forEach((r) => r.classList.toggle("active", r.dataset.path === path));
  appWindow.setTitle(path.split("/").pop()).catch(() => {});
}

function postProcess(root, file) {
  // Local images -> Tauri asset protocol.
  for (const img of root.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
    img.src = convertFileSrc(resolveFrom(file, src.split(/[?#]/)[0]));
    img.loading = "lazy";
  }
  // GitHub-style heading anchors.
  const seen = new Map();
  for (const h of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (h.id) continue;
    const base = h.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  }
}

function highlight() {
  if (!window.hljs) return;
  const blocks = el.doc.querySelectorAll("pre code");
  const seq = state.renderSeq;
  // Highlight in small slices so huge documents paint immediately.
  let i = 0;
  const step = (deadline) => {
    if (seq !== state.renderSeq) return;
    while (i < blocks.length && (deadline?.timeRemaining?.() ?? 1) > 2) {
      const b = blocks[i++];
      if (b.className.includes("language-") || b.textContent.length < 20000) hljs.highlightElement(b);
    }
    if (i < blocks.length) requestIdleCallback(step);
  };
  for (; i < Math.min(blocks.length, 12); i++) hljs.highlightElement(blocks[i]); // first screens synchronously
  if (i < blocks.length) requestIdleCallback(step);
}
window.hljs?.configure({ ignoreUnescapedHTML: true });

function scrollToId(id) {
  const t = document.getElementById(id) ?? document.getElementById(id.toLowerCase());
  if (t) t.scrollIntoView({ block: "start" });
}

el.doc.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (a) {
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href.startsWith("#")) return scrollToId(decodeURIComponent(href.slice(1)));
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return openUrl(href);
    const [p, hash] = href.split("#");
    if (!p) return;
    const target = resolveFrom(state.current, p);
    const node = state.nodes.get(target);
    if (node?.dir) {
      const readme = (node.children ?? []).find((c) => !c.dir && /^readme\./i.test(c.name));
      if (readme) openFile(readme.path);
      else { state.expanded.add(target); el.filter.value = ""; renderTree(); }
    } else if (MD_RE.test(target)) {
      openFile(target, { hash });
    }
    return;
  }
  const btn = e.target.closest("[data-action=open]");
  if (btn) pickFolder();
});

function setCrumbs(path) {
  if (!path) { el.crumbs.innerHTML = ""; return; }
  const parts = rel(path).split("/");
  el.crumbs.innerHTML = parts.map((p, i) => i === parts.length - 1 ? `<b>${esc(p)}</b>` : esc(p)).join("<i>/</i>");
}

function showWelcome(inner) {
  el.doc.innerHTML = `<div class="welcome">${inner}</div>`;
  el.scroller.scrollTop = 0;
}
function showError(e) {
  el.doc.innerHTML = `<p class="error">${esc(String(e))}</p>`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------- navigation & chrome

function go(delta) {
  const i = state.hIndex + delta;
  if (i < 0 || i >= state.history.length) return;
  state.hIndex = i;
  openFile(state.history[i], { push: false });
}

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "o") { e.preventDefault(); pickFolder(); }
  else if (k === "p" || k === "k") { e.preventDefault(); el.app.classList.remove("no-sidebar"); el.filter.focus(); el.filter.select(); }
  else if (k === "[") { e.preventDefault(); go(-1); }
  else if (k === "]") { e.preventDefault(); go(1); }
  else if (k === "\\") { e.preventDefault(); el.app.classList.toggle("no-sidebar"); }
  else if (k === "r") {
    e.preventDefault();
    if (state.scan) {
      const top = el.scroller.scrollTop;
      openFolder(state.scan.root, { restore: true }).then(() => (el.scroller.scrollTop = top));
    }
  }
});

// Re-render the current file when the window regains focus (picks up external edits).
window.addEventListener("focus", () => {
  if (state.current) openFile(state.current, { push: false, keepScroll: true });
});

el.scroller.addEventListener("scroll", () => el.topbar.classList.toggle("scrolled", el.scroller.scrollTop > 4), { passive: true });

// Sidebar resizing.
{
  const saved = store.get("sidebar-w");
  if (saved) document.documentElement.style.setProperty("--sidebar-w", saved);
  el.resizer.addEventListener("pointerdown", (e) => {
    el.resizer.setPointerCapture(e.pointerId);
    el.resizer.classList.add("dragging");
    const move = (ev) => {
      const w = Math.max(180, Math.min(560, ev.clientX)) + "px";
      document.documentElement.style.setProperty("--sidebar-w", w);
      store.set("sidebar-w", w);
    };
    const up = () => {
      el.resizer.classList.remove("dragging");
      el.resizer.removeEventListener("pointermove", move);
      el.resizer.removeEventListener("pointerup", up);
    };
    el.resizer.addEventListener("pointermove", move);
    el.resizer.addEventListener("pointerup", up);
  });
}

el.folderBtn.onclick = pickFolder;

// `pleph some/file.md` while this window already shows its folder.
window.__TAURI__.webviewWindow.getCurrentWebviewWindow().listen("open-file", (e) => openFile(e.payload));

// ---------------------------------------------------------------- boot

(async () => {
  // `pleph <path>`: new windows get it injected, the first window reads the process args.
  const target = window.__PLEPH_OPEN__ ?? await invoke("initial_target").catch(() => null);
  const last = store.get("folder");
  if (target) return target.dir ? openFolder(target.path) : openFolder(dirname(target.path), { file: target.path });
  if (last) {
    await openFolder(last, { restore: true });
    if (state.scan) return;
  }
  showWelcome(`
    <h1>Pleph</h1>
    <p>A quiet place to read your Markdown.</p>
    <button class="primary" data-action="open">Open Folder</button>
    <p class="hint"><kbd>⌘O</kbd> open · <kbd>⌘P</kbd> find file · <kbd>⌘[</kbd> <kbd>⌘]</kbd> back/forward · <kbd>⌘\\</kbd> sidebar</p>`);
})();
