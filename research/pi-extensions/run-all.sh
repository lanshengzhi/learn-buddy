#!/usr/bin/env bash
# Reproduce every experiment in research/pi-extensions.md and capture the raw
# output under results/. Everything is local: the only network endpoint is the
# mock OpenAI-compatible server spawned by e2-toolcall.mjs on 127.0.0.1:8199.
#
#   bash run-all.sh
#
# Prerequisite (the scripts resolve the pi package through it):
#   ln -sfn ../../ai-service/node_modules research/pi-extensions/node_modules
set -u
cd "$(dirname "$0")"

export PI_EXT_LAB="${PI_EXT_LAB:-$PWD/../../.scratch/pi-ext-lab}"
LAB="$PI_EXT_LAB"
RES="$PWD/results"
mkdir -p "$RES" "$LAB/agentdir" "$LAB/sessions"

# Scratch agent dir (never ~/.pi): provider catalog pointing at the mock, empty
# auth. `models.json` is the only one that matters; the rest only need to exist.
if [ ! -f "$LAB/agentdir/models.json" ]; then
  cp "$PWD/agentdir-models.json" "$LAB/agentdir/models.json"
fi
for f in auth.json models-store.json settings.json; do
  [ -f "$LAB/agentdir/$f" ] || echo '{}' > "$LAB/agentdir/$f"
done

# Auxiliary extension dirs for the module-resolution experiments.
#   ext-nodeps : a fixture copied outside the repo, where NO node_modules exists
#                anywhere up the tree (up-tree node_modules is what jiti would
#                otherwise fall back to).
#   ext-missing: the same, but importing a package that exists nowhere at all.
NO_DEPS_ROOT="$(cd "$LAB/../.." && pwd)/.scratch/pi-ext-nodeps"
rm -rf "$NO_DEPS_ROOT" "$LAB/ext-deps" "$LAB/ext-missing"
mkdir -p "$NO_DEPS_ROOT" "$LAB/ext-missing"
cp "$PWD/ext/typebox-tool.ts" "$NO_DEPS_ROOT/typebox-tool.ts"
cp "$PWD/fixtures/runtime-import.ts" "$NO_DEPS_ROOT/runtime-import.ts"
cp "$PWD/fixtures/needs-missing-dep.ts" "$LAB/ext-missing/needs-pkg.ts"

run() { # run <outfile> <cmd...>
  local out="$RES/$1"; shift
  echo "\$ $*" > "$out"
  "$@" >> "$out" 2>&1
  echo "  -> results/$(basename "$out")"
}

echo "### E1: extension loading x noTools matrix"
for m in auto all builtin allow; do
  rm -f "$LAB/tool-invocations.log" "$LAB/gate.log"
  run "e1-notools-$m.txt" node e1-load.mjs ext "notools=$m"
done
rm -f "$LAB/tool-invocations.log" "$LAB/gate.log"
run "e1-module-resolution.txt" node e1-load.mjs "$NO_DEPS_ROOT" notools=builtin
rm -f "$LAB/tool-invocations.log" "$LAB/gate.log"
run "e1-missing-dep.txt" node e1-load.mjs "$LAB/ext-missing" notools=builtin

echo "### E2: end-to-end tool call + tool_call gate"
for m in toolcall gate rewrite rewrite-invalid noext none; do
  rm -f "$LAB/requests.jsonl" "$LAB/tool-invocations.log" "$LAB/gate.log"
  run "e2-$m.txt" node e2-toolcall.mjs "$m"
  { echo "--- gate.log ---"; cat "$LAB/gate.log" 2>/dev/null; } >> "$RES/e2-$m.txt"
done

echo "### E3: discovery locations"
for c in agentdir project dirpath subdir subdir-index subdir-path jspath factory factory-noext none; do
  run "e3-$c.txt" node e3-discovery.mjs "$c"
done

echo "### E4: edit-and-reload"
run "e4-reload.txt" node e4-reload.mjs

echo "done; raw output in results/"
