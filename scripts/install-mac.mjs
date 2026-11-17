// Builds Pleph.app, installs it into the Applications folder and links the `pleph` command.
//   npm run install-mac                  build, then install
//   npm run install-mac -- --no-build    install whatever the last `tauri build` left behind
//   npm run install-mac -- --open        also launch it afterwards
// The ad hoc signed build installs fine locally: copying never sets the quarantine flag.
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const NAME = "Pleph";
const APP_ID = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).identifier;
const CLI_MARKER = "# pleph-cli:";
const build = !process.argv.includes("--no-build");
const open = process.argv.includes("--open");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (process.platform !== "darwin") fail("install-mac only runs on macOS.");

const bundleId = (app) => {
  try {
    return execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents", "Info.plist")], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

if (build) {
  for (const [cmd, args] of [["npm", ["run", "vendor"]], ["npx", ["tauri", "build", "--bundles", "app"]]]) {
    const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
    if (res.status !== 0) fail("Build failed; nothing was installed.");
  }
}

const source = join(root, "src-tauri", "target", "release", "bundle", "macos", `${NAME}.app`);
if (!existsSync(source)) fail(`No ${source}. Run without --no-build first.`);
if (bundleId(source) !== APP_ID) fail(`${source} is not ${APP_ID}; refusing to install it.`);

const canWrite = (dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const dir = canWrite("/Applications") ? "/Applications" : join(homedir(), "Applications");
mkdirSync(dir, { recursive: true });
const dest = join(dir, `${NAME}.app`);

// Replacing a bundle that is running leaves the running copy broken.
if (spawnSync("pgrep", ["-f", `${dest}/Contents/MacOS/`]).status === 0) fail(`${NAME} is running. Quit it (⌘Q) and run this again.`);

if (existsSync(dest)) {
  if (!statSync(dest).isDirectory() || bundleId(dest) !== APP_ID) fail(`${dest} exists and is not ${APP_ID}; remove it yourself first.`);
  rmSync(dest, { recursive: true, force: true });
}

execFileSync("ditto", [source, dest]);
console.log(`Installed ${NAME} to ${dest}`);

// The `pleph` command. Only a file we wrote ourselves is ever replaced.
const binDir = join(homedir(), ".local", "bin");
const cli = join(binDir, "pleph");
if (existsSync(cli) && !readFileSync(cli, "utf8").includes(CLI_MARKER)) {
  console.warn(`${cli} exists and wasn't installed by Pleph; leaving it alone.`);
} else {
  mkdirSync(binDir, { recursive: true });
  const script = readFileSync(join(root, "scripts", "pleph.sh"), "utf8").replace(`APP="__APP__"`, `APP="${dest}"`);
  writeFileSync(cli, script, { mode: 0o755 });
  console.log(`Installed the pleph command to ${cli}`);
  if (!(process.env.PATH ?? "").split(delimiter).includes(binDir)) console.warn(`Note: ${binDir} is not on your PATH.`);
}

if (open) execFileSync("open", [dest]);
