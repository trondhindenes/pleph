#!/bin/sh
# pleph-cli: opens a folder or markdown file in Pleph, like `code <path>`.
# Installed by `npm run install-mac`; __APP__ is replaced with the installed app's path.
#   pleph            open the current folder
#   pleph ~/notes    open a folder
#   pleph README.md  open a file (its folder becomes the root)
APP="__APP__"

target="${1:-.}"
if [ -d "$target" ]; then
  abs=$(cd -- "$target" && pwd -P)
elif [ -e "$target" ]; then
  abs="$(cd -- "$(dirname -- "$target")" && pwd -P)/$(basename -- "$target")"
else
  echo "pleph: no such file or directory: $target" >&2
  exit 1
fi

# -n starts a fresh process; if Pleph is already running it hands the path over and exits.
exec open -n -a "$APP" --args "$abs"
