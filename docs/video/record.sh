#!/usr/bin/env bash
# Records the arcpi demo as two videos and merges them side by side:
#   video/terminal.mp4  the Docker launch and the pi session (VHS, docs/video/demo.tape)
#   video/map.mp4       mappi's page in headless Chrome (docs/video/record-map.ts)
#   video/demo.mp4      both, aligned on wall-clock time
# Needs vhs, ffmpeg, Google Chrome (or CHROME_BIN), Docker, and a host `./arcpi login`.
# HOLD_SECONDS (default 10) keeps both recordings running on the final answer.
#   docs/video/record.sh [name]   # a name records into video/<name>/ and leaves video/ alone
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

out=video   # git-ignored; not cleaned like artifacts/
tape=docs/video/demo.tape
if [[ $# -gt 0 ]]; then
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "usage: docs/video/record.sh [name]" >&2; exit 2; }
  out="video/$1"
  mkdir -p "$out"
  # The tape names its output and its end marker; a copy points both into the named folder.
  tape="$out/demo.tape"
  sed -e "s#\"video/terminal.mp4\"#\"$out/terminal.mp4\"#" -e "s#-e video/.done#-e $out/.done#" docs/video/demo.tape > "$tape"
fi
sessions="$HOME/.pi/agent/sessions/--work-arcpi--"
mkdir -p "$out" "$sessions"
rm -f "$out"/terminal.mp4 "$out"/map.mp4 "$out"/map.mp4.json "$out"/demo.mp4 "$out"/.done
now() { node -p 'Date.now() / 1000'; }
# Sessions that exist now belong to other runs; this run's is the first new one.
known_sessions="$(ls "$sessions")"
session=''

node docs/video/record-map.ts "$out/map.mp4" &
map_pid=$!
vhs "$tape" &
vhs_pid=$!
trap 'kill "$map_pid" "$vhs_pid" 2>/dev/null || true; docker compose -f compose.map.yaml down >/dev/null 2>&1 || true' EXIT

# The answer is complete when this run's pi session ends on an assistant message
# that stopped for any reason other than a tool call.
finished() {
  [[ -n "$session" ]] || session="$(ls "$sessions" | grep -vxF -- "$known_sessions" | grep -m 1 '\.jsonl$' || true)"
  [[ -n "$session" ]] && tail -n 1 "$sessions/$session" | node -e '
    const entry = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const message = entry.message ?? {};
    process.exit(message.role === "assistant" && message.stopReason && message.stopReason !== "toolUse" ? 0 : 1);'
}
until finished; do
  kill -0 "$vhs_pid" 2>/dev/null || { echo 'vhs ended before pi answered' >&2; exit 1; }
  kill -0 "$map_pid" 2>/dev/null || { echo 'the map recording failed; stopping before the answer' >&2; exit 1; }
  sleep 2
done
echo 'pi answered; holding on the result' >&2
sleep "${HOLD_SECONDS:-10}"

kill -INT "$map_pid"
wait "$map_pid"
stopped="$(now)"
: > "$out/.done"   # demo.tape ends on the marker the next prompt prints
docker kill arcpi-demo >/dev/null || true
wait "$vhs_pid"

# VHS records until the marker appears (about a second after pi stops) plus its final Sleep 1s,
# so the terminal video started that long before its end.
duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
terminal_started="$(node -p "$stopped + 1.5 - $(duration "$out/terminal.mp4")")"
offset="$(node -p "require('./$out/map.mp4.json').started - $terminal_started")"
if node -e "process.exit($offset >= 0 ? 0 : 1)"; then
  align="tpad=start_duration=$offset:color=black"
else
  align="trim=start=$(node -p "-($offset)"),setpts=PTS-STARTPTS"
fi
ffmpeg -y -loglevel error -i "$out/terminal.mp4" -i "$out/map.mp4" -filter_complex \
  "[0:v]scale=-2:800,setsar=1,fps=25[t];[1:v]scale=-2:800,setsar=1,fps=25,$align,tpad=stop_mode=clone:stop_duration=3600[m];[t][m]hstack=inputs=2:shortest=1[v]" \
  -map '[v]' -c:v libx264 -pix_fmt yuv420p "$out/demo.mp4"
rm -f "$out/.done"
echo "Wrote $out/terminal.mp4, $out/map.mp4 and $out/demo.mp4 (map offset ${offset}s)."
