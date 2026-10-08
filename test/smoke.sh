#!/usr/bin/env bash
# Smoke test: both launcher paths, the test suite, and pi loading the arcgis-rest plugin.
# No LLM or portal calls. Compose runs it via `docker compose run --rm arcpi`.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

./arcpi status
./arcpi --version
rtk --version
node --test test/

# pi answers get_commands without a model: the extension's command and the plugin's
# skill are listed only when both were loaded. Untrusted, pi ignores .pi/settings.json,
# and a session without a UI cannot ask for trust, hence --approve. A probe extension
# reports the active tools and the MCP servers extensions registered on stderr.
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
cat > "$scratch/probe.ts" <<'EOF'
export default (pi: any) => pi.on("session_start", () => {
  console.error(`active tools: ${JSON.stringify(pi.getActiveTools())}`);
  console.error(`mcp servers: ${JSON.stringify(pi.getMcpServers().map((server: any) => server.name))}`);
});
EOF
commands="$(./arcpi --mode rpc --no-session --approve --extension "$scratch/probe.ts" \
  <<< '{"type":"get_commands"}' 2> "$scratch/stderr")" || { cat "$scratch/stderr" >&2; exit 1; }
for name in arcgis-login skill:arcgis-rest skill:arcgis-map skill:local-gis skill:mappi; do
  grep -q "\"name\":\"$name\"" <<< "$commands" || { echo "pi did not load $name" >&2; exit 1; }
done
echo 'pi loaded the arcgis-rest extension and skills'

tools="$(grep '^active tools: ' "$scratch/stderr" || true)"
if grep -q 'Invalid settings' "$scratch/stderr" || ! grep -q '"codemode"' <<< "$tools" || grep -q '"bash"' <<< "$tools"; then
  cat "$scratch/stderr" >&2
  echo 'pi did not apply .pi/settings.json' >&2
  exit 1
fi
echo "pi applied .pi/settings.json (${tools#active tools: })"

grep -q '^mcp servers: .*"mappi"' "$scratch/stderr" || { cat "$scratch/stderr" >&2; echo 'pi did not register the plugin mcp.json servers' >&2; exit 1; }
echo "pi registered the plugin mcp.json servers ($(sed -n 's/^mcp servers: //p' "$scratch/stderr"))"
