use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn"];

fn is_markdown(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MD_EXTENSIONS.iter().any(|m| e.eq_ignore_ascii_case(m)))
}

fn is_readme(name: &str) -> bool {
    Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("readme"))
}

// ---------------------------------------------------------------- scanning

#[derive(Serialize)]
struct Node {
    name: String,
    path: String,
    dir: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<Node>,
}

#[derive(Serialize)]
struct Scan {
    root: String,
    name: String,
    tree: Vec<Node>,
    readme: Option<String>,
    count: usize,
    ms: u128,
}

#[derive(Default)]
struct DirBuild {
    dirs: BTreeMap<String, DirBuild>,
    files: Vec<String>,
}

/// Parallel walk that respects .gitignore/.ignore, skips hidden entries and node_modules.
fn find_markdown(root: &Path) -> Vec<PathBuf> {
    let found = Mutex::new(Vec::new());
    ignore::WalkBuilder::new(root)
        .hidden(true)
        .require_git(false)
        .filter_entry(|e| !(e.file_name() == "node_modules" && e.file_type().is_some_and(|t| t.is_dir())))
        .build_parallel()
        .run(|| {
            let found = &found;
            Box::new(move |entry| {
                if let Ok(e) = entry {
                    if e.file_type().is_some_and(|t| t.is_file()) && is_markdown(e.path()) {
                        found.lock().unwrap().push(e.into_path());
                    }
                }
                ignore::WalkState::Continue
            })
        });
    found.into_inner().unwrap()
}

fn build_tree(root: &Path, files: &[PathBuf]) -> DirBuild {
    let mut top = DirBuild::default();
    for f in files {
        let Ok(rel) = f.strip_prefix(root) else { continue };
        let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        let Some((file, dirs)) = parts.split_last() else { continue };
        let mut cur = &mut top;
        for d in dirs {
            cur = cur.dirs.entry(d.clone()).or_default();
        }
        cur.files.push(file.clone());
    }
    top
}

fn to_nodes(b: DirBuild, base: &Path) -> Vec<Node> {
    let mut dirs: Vec<Node> = b
        .dirs
        .into_iter()
        .map(|(name, sub)| {
            let p = base.join(&name);
            Node { children: to_nodes(sub, &p), path: p.to_string_lossy().into_owned(), name, dir: true }
        })
        .collect();
    dirs.sort_by_cached_key(|n| n.name.to_lowercase());

    let mut files: Vec<Node> = b
        .files
        .into_iter()
        .map(|name| Node { path: base.join(&name).to_string_lossy().into_owned(), name, dir: false, children: vec![] })
        .collect();
    files.sort_by_cached_key(|n| (!is_readme(&n.name), n.name.to_lowercase()));

    dirs.extend(files);
    dirs
}

#[tauri::command]
async fn scan_folder(path: String) -> Result<Scan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = Instant::now();
        let root = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        let files = find_markdown(&root);
        let built = build_tree(&root, &files);

        // Prefer README.md, then any other readme.* markdown file in the root.
        let readme = built
            .files
            .iter()
            .filter(|f| is_readme(f))
            .min_by_key(|f| !f.eq_ignore_ascii_case("readme.md"))
            .map(|f| root.join(f).to_string_lossy().into_owned());

        Ok(Scan {
            name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into()),
            tree: to_nodes(built, &root),
            root: root.to_string_lossy().into_owned(),
            readme,
            count: files.len(),
            ms: t.elapsed().as_millis(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- rendering

fn sanitizer() -> &'static ammonia::Builder<'static> {
    static S: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    S.get_or_init(|| {
        let mut b = ammonia::Builder::default();
        b.add_tags(["input"])
            .add_tag_attributes("input", ["type", "checked", "disabled"])
            .add_tag_attributes("th", ["style"])
            .add_tag_attributes("td", ["style"])
            .add_generic_attributes(["class", "id"]);
        b
    })
}

fn render(src: &str) -> String {
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_GFM
        | Options::ENABLE_DEFINITION_LIST;

    // Drop front matter instead of rendering it.
    let mut in_meta = false;
    let events = Parser::new_ext(src, opts).filter(move |ev| match ev {
        Event::Start(Tag::MetadataBlock(_)) => {
            in_meta = true;
            false
        }
        Event::End(TagEnd::MetadataBlock(_)) => {
            in_meta = false;
            false
        }
        _ => !in_meta,
    });

    let mut out = String::with_capacity(src.len() * 3 / 2);
    html::push_html(&mut out, events);
    sanitizer().clean(&out).to_string()
}

#[tauri::command]
async fn render_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        if !is_markdown(p) {
            return Err(format!("Not a markdown file: {path}"));
        }
        let bytes = std::fs::read(p).map_err(|e| format!("{path}: {e}"))?;
        Ok(render(&String::from_utf8_lossy(&bytes)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the file in VS Code. On macOS we go via the bundle id, because GUI apps
/// usually don't see the shell PATH where the `code` CLI lives.
#[tauri::command]
async fn open_in_vscode(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        if std::process::Command::new("open")
            .args(["-b", "com.microsoft.VSCode", &path])
            .status()
            .is_ok_and(|s| s.success())
        {
            return Ok(());
        }
        std::process::Command::new("code")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Couldn't start VS Code: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- launch targets & windows

/// A folder or file given on the command line, e.g. `pleph ~/notes` or `pleph README.md`.
#[derive(Serialize, Clone)]
struct Target {
    path: String,
    dir: bool,
}

impl Target {
    /// The folder a window shows for this target.
    fn folder(&self) -> String {
        if self.dir {
            self.path.clone()
        } else {
            Path::new(&self.path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
        }
    }
}

fn parse_target(args: &[String], cwd: &Path) -> Option<Target> {
    args.iter().skip(1).filter(|a| !a.starts_with('-')).find_map(|a| {
        let p = std::fs::canonicalize(cwd.join(a)).ok()?;
        let dir = p.is_dir();
        (dir || is_markdown(&p)).then(|| Target { path: p.to_string_lossy().into_owned(), dir })
    })
}

/// Which folder each window shows, so a repeated `pleph <folder>` focuses instead of duplicating.
#[derive(Default)]
struct Windows {
    folders: Mutex<HashMap<String, String>>,
    next: AtomicUsize,
}

#[tauri::command]
fn initial_target() -> Option<Target> {
    let args: Vec<String> = std::env::args().collect();
    parse_target(&args, &std::env::current_dir().unwrap_or_default())
}

#[tauri::command]
fn set_folder(window: tauri::Window, folder: String, windows: State<'_, Windows>) {
    windows.folders.lock().unwrap().insert(window.label().to_string(), folder);
}

fn focus(w: &tauri::WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

/// Called when `pleph <path>` runs while the app is already open.
fn open_target(app: &AppHandle, target: Option<Target>) {
    let Some(target) = target else {
        if let Some(w) = app.webview_windows().values().next() {
            focus(w);
        }
        return;
    };

    let folder = target.folder();
    let existing = app.state::<Windows>().folders.lock().unwrap().iter().find(|(_, f)| **f == folder).map(|(l, _)| l.clone());
    if let Some(w) = existing.and_then(|l| app.get_webview_window(&l)) {
        if !target.dir {
            let _ = w.emit_to(w.label(), "open-file", &target.path);
        }
        focus(&w);
        return;
    }

    let n = app.state::<Windows>().next.fetch_add(1, Ordering::Relaxed);
    let init = format!("window.__PLEPH_OPEN__ = {};", serde_json::to_string(&target).unwrap());
    let builder = WebviewWindowBuilder::new(app, format!("w-{n}"), WebviewUrl::App("index.html".into()))
        .title("Pleph")
        .inner_size(1200.0, 820.0)
        .min_inner_size(560.0, 400.0)
        .accept_first_mouse(true)
        .initialization_script(&init);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    if let Ok(w) = builder.build() {
        focus(&w);
    }
}

/// The standard menu bar with our commands at the top of the File menu.
/// The frontend handles them; we only forward the item id to the focused window.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let open = MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("CmdOrCtrl+O"))?;
    let find = MenuItem::with_id(app, "find-file", "Find File…", true, Some("CmdOrCtrl+P"))?;
    let rescan = MenuItem::with_id(app, "rescan", "Rescan Folder", true, Some("CmdOrCtrl+R"))?;
    let sep = PredefinedMenuItem::separator(app)?;

    let file = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(s) if s.text().is_ok_and(|t| t == "File") => Some(s),
        _ => None,
    });
    match file {
        Some(file) => file.prepend_items(&[&open, &find, &rescan, &sep])?,
        None => menu.insert(&Submenu::with_items(app, "File", true, &[&open, &find, &rescan])?, 1)?,
    }
    Ok(menu)
}

fn focused_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let windows = app.webview_windows();
    windows.values().find(|w| w.is_focused().unwrap_or(false)).or_else(|| windows.values().next()).cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch hands its arguments to us and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            open_target(app, parse_target(&args, Path::new(&cwd)));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Windows::default())
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(w) = focused_window(app) {
                let _ = w.emit_to(w.label(), "menu", event.id().0.as_str());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<Windows>().folders.lock().unwrap().remove(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            render_file,
            initial_target,
            set_folder,
            open_in_vscode
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pleph");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_gfm_and_strips_scripts() {
        let html = render("---\ntitle: x\n---\n# Hi\n\n- [x] done\n\n<script>alert(1)</script>\n\n| a |\n|:-:|\n| b |\n");
        assert!(html.contains("<h1>Hi</h1>"));
        assert!(html.contains("checkbox"));
        assert!(!html.contains("<script"));
        assert!(!html.contains("title: x"));
        assert!(html.contains("<table>"));
    }
}
