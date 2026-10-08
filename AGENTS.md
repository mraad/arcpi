# Repository Guidelines

## Project Structure

arcpi is a Bash launcher for pi plus the `arcgis-rest` plugin: the agent calls
ArcGIS REST endpoints from pi codemode scripts. Prefer native pi features and
Markdown skills. Code is TypeScript that Node and pi run unbuilt: no Go, no Python, no build
step, no `package.json`, no dependencies, no ArcGIS MCP server. The agent calls
no CLI of any kind: every tool is a native file, extension or MCP tool called from a
codemode script. The plugin's `mcp.json` lists one server, the map surface: `mappi`
(no project `.pi/mcp.json`), served by this repo's `mappi/`. The plugin is
self-contained: its skills assume no other checkout, product or skill tree.
`.pi/settings.json` keeps pi's `codemode` tool on (`+codemode`) and sets its
mode to `only`, so all callable tools are accessed from scripts. It also enables
native `ls`, `find`, `grep` and disables `bash`, `powershell`.

- `arcpi`: executable launcher, sign-in commands, plugin loading, cleanup of `artifacts/`.
- `mappi/`: the live map, one dependency-free Node process (`node mappi/server.ts`).
  - `server.ts`: MCP (`run_map_code`), the page, its SSE + POST channel and
    the read-only `/artifacts`; routes and env are listed in its header comment.
    `--static` serves `artifacts/` by path on `:8000` for standalone maps, through
    the same `sendArtifact` checks (no symlinked root, real-path containment, no
    dot folders, a fixed list of file types).
  - `index.html`: ArcGIS Maps SDK 5.1 page inheriting arcpi login through SSE,
    the `api` for generated code, scoped SDK requests and token redaction.
- `arcgis-rest/`: the plugin, laid out per the Agent Plugins spec 1.0.0.
  - `plugin.json`: manifest; `version` is the project version. pi-only MCP fields
    (`description`, `exposure`) go under `extensions."dev.pi".mcpServers.<name>`.
  - `mcp.json`: the plugin's MCP servers (spec 1.0.0 format, `mappi`).
  - `skills/arcgis-rest/SKILL.md` + `references/*.md`: endpoints, parameters, rules.
  - `skills/arcgis-map/SKILL.md`: standalone HTML maps with ArcGIS Maps SDK
    for JavaScript 5.1 (loading, layers, renderers, popups, auth, delivery).
  - `skills/local-gis/SKILL.md`: source discovery for local projects and
    exports; analysis in codemode without ArcGIS REST or portal login.
  - `skills/mappi/SKILL.md`: the live map surface (`tools.mcp__mappi__run_map_code`);
    preferred while mappi runs.
  - `dev.pi/extensions/arcgis/arcgis.ts`: session store, PKCE login, refresh,
    trusted hosts, the request; also the `login|logout|status` CLI entry.
  - `dev.pi/extensions/arcgis/geometry.ts`: geometry by reference. `externalize`
    moves the shapes of a response to `artifacts/geometry/*.geojson` and leaves
    references; `resolveReferences` turns references in parameters back into
    Esri JSON shapes.
  - `dev.pi/extensions/arcgis/mcp.ts`: reads `mcp.json` for pi (pi reads neither
    it nor `plugin.json`); skips and reports a version mismatch or a transport
    other than `streamable-http`.
  - `dev.pi/extensions/arcgis/index.ts`: registers `arcgis_request`,
    `arcgis_status`, `/arcgis-login`, `/arcgis-logout` and the `mcp.json`
    servers with pi.
- `.pi/APPEND_SYSTEM.md`: local rules for pi (REST through codemode, maps,
  adapting SDK examples found elsewhere).
- `test/arcgis.test.ts`: session and request code against a fake portal on loopback.
- `test/launcher.test.ts`: launcher with a fake pi in temporary workspaces.
- `test/mappi.test.ts`: mappi over HTTP with a fake page (MCP, channel, `/artifacts`,
  `/config`, bearer, Host/Origin).
- `compose.map.yaml`: arcpi plus mappi, both from the arcpi image; arcpi shares
  the map's network (the plugin's `127.0.0.1:8787` entry works unchanged) and
  both mount the checkout at `/work/arcpi`, so `/artifacts` sees the paths arcpi reports.
  mappi's checkout is read-only except `.arcgis/` (shared session refresh).
- `compose.yaml`, `Dockerfile`, `test/smoke.sh`: Docker smoke test (no LLM or
  portal calls). Read-only checkout except `.pi/` (pi must lock
  `settings.json` to read it); `--approve` trusts the project.
  The image pins pi 1.1.0 and RTK 0.51.0 (Linux arm64/amd64). `.dockerignore`
  excludes everything but the `Dockerfile`: the checkout is mounted, never
  copied, so credentials and artifacts stay out of the build context.
- `README.md`: setup, authentication, skills, operations.
- `docs/openshell.md`: recommendation for running arcpi in an OpenShell sandbox
  (unverified; needs OpenShell 0.1.x).
- `docs/overview/`: plain-language introduction page (`index.html` + `images/`,
  frames from the v2 demo with the signed-in username masked).
- `docs/video.md`, `docs/video/`: recording the demo as a terminal video (VHS
  tape), a map video (`record-map.ts`, Chrome DevTools screencast to ffmpeg, no
  dependencies) and both side by side (`record.sh`).
- `video/`: recorded videos; ignored, kept (not cleaned at startup).
- `tasks/todo.md`, `tasks/lessons.md`: plans and lessons from corrections (tracked).
- `CLAUDE.md`: the single line `@AGENTS.md`, so Claude Code reads these
  instructions even where another `CLAUDE.md` above the project would make it
  skip `AGENTS.md`. Edit `AGENTS.md`, never `CLAUDE.md`.
- `artifacts/`: generated maps/data; ignored, temporary.
- `.arcgis/`: cached logins; ignored, never read, printed, or committed.

## Development and Validation

No build step is required. Install pi (1.0+) and Node (22.19+). Local sessions
need no ArcGIS env; export `ARCGIS_PORTAL_URL` and `ARCGIS_CLIENT_ID` for REST
and sign-in commands:

```bash
./arcpi             # Interactive session; expires old artifacts
./arcpi login       # Browser OAuth; also expires old artifacts
bash -n arcpi       # Bash syntax
node --test test/   # Both test files
git diff --check    # Whitespace checks
docker compose run --rm arcpi && docker compose down  # Smoke: launcher, tests, plugin, project settings
```

Run the first three checks after any launcher, plugin, or test change. Use Node's
built-in `node:test` and `assert`; name tests `*.test.ts`. Cover changed behavior
with temporary fixtures and the fake portal, not live portals or LLM calls. One
test file runs with `node --test test/arcgis.test.ts`; one case with
`--test-name-pattern`. Tests need no `ARCGIS_*` env or `pi` installed.

TypeScript must stay erasable (no `enum`, no parameter properties, `import type`
for types, `.ts` in relative imports): Node strips types without checking them.
There is no type checker in the repo; `tsc --noEmit --strict --erasableSyntaxOnly`
from a scratch install is a useful one-off after larger edits.

## Architecture

`arcpi` is one Bash script with two exec paths, chosen by `$1`:

1. **Sign-in commands** (`./arcpi login|logout|status`): validates env, cleans
   `artifacts/`, then `exec node arcgis-rest/dev.pi/extensions/arcgis/arcgis.ts <cmd>`.
   Must keep working without pi.
2. **pi session** (anything else): requires `pi`, but no ArcGIS env for local
   work. It cleans `artifacts/` and execs pi with:
   `--append-system-prompt .pi/APPEND_SYSTEM.md`, `--extension <index.ts>`,
   `--skill arcgis-rest/skills`, then forwarded user args.

pi does not read `plugin.json`; the launcher is the adapter that hands the
plugin's skills and extension to pi.

Request path: a codemode script (QuickJS, no network) calls
`tools.arcgis_request` → `index.ts` → `request()` in `arcgis.ts` → `fetch`. Both
tools use exposure `codemode` (callable from scripts, not declared to the model)
and declare an `outputSchema`, so scripts receive `structuredContent`.

Geometry rule (`geometry.ts`), a hard requirement: no line, polygon or
multipoint is ever returned by a tool, to a script or to the model. Shapes go to
disk and travel as `{ $geometry: "<path>#<n>", type, vertices, bbox }`; single
points and extents stay inline. Do not add a way to get coordinates back
(no "inline" option, no tool that reads a geometry file into a result), and
keep reference resolution confined to `artifacts/`: it is the only place the
tool reads a file named by a script. Stored files are GeoJSON because the map
page's `GeoJSONLayer` loads them directly (Esri JSON needs a converter);
Esri rings are regrouped into polygons with holes and re-wound both ways.

Token rules, all in `arcgis.ts`:
- Session file `$ARCGIS_SESSION_DIR/<sha256(portal\nclient)>/session.json`
  (launcher sets the directory to `.arcgis`), `0600` in `0700`, written by
  temp file + rename.
- Refresh when under 60 s remain; one in-flight refresh per session file across
  processes through a filesystem lease (a crashed holder expires after 2 min); keep
  an un-rotated refresh token; re-read the file before saving so a newer
  login/logout wins; 30 s cooldown after a failed refresh.
- The token goes only to trusted hosts (`discoverTrust`): portal, its
  `helperServices`, federated servers, trusted servers, `*.arcgis.com` for an
  ArcGIS Online portal, `ARCGIS_TRUSTED_TOKEN_HOSTS`. An answer the portal gave
  without a session (or no answer) is asked for again after 30 s; a signed-in
  answer is kept for the process.
- Redirects are followed manually, and every hop gets the same checks as the
  first URL: trust before the token is attached, and refusal of token endpoints.
  `token` params are refused, including redirect URLs, and token strings are
  redacted from responses. Internal OAuth and trust discovery refuse redirects.
- A trusted host that answers 498 to a just-renewed token is retried
  anonymously; if that works it is remembered (`tokenRefusedBy`) and gets no
  token afterwards. Never the portal host: anonymous portal answers are
  public-only and would pass for a result.
- Per-profile process state (in-flight refresh, last refresh failure, trust,
  token-refusing hosts) is one `Profile` record keyed by session file, dropped
  whole on login and logout. `login_id` identifies a login across processes
  and is preserved on refresh.
- Mappi shares the session module and sends only the access token, expiry,
  username and trusted hosts over the existing page SSE channel. Sync before
  map execution and every 5 s while a page is connected; no timer without a
  page. Refresh tokens stay in Node. Tool arguments/results never carry tokens.

Live map surface: the `mappi` entry of `arcgis-rest/mcp.json` (mappi's `/mcp`,
default exposure `codemode`), registered by the extension. The launcher
knows nothing about it. A `mappi` entry in `~/.pi/agent/mcp.json` or
`.pi/mcp.json` overrides it (another address, a token). pi connects at startup;
while the server is down the tools do not exist and a call to one fails, which is how map requests fall back to standalone HTML
(no separate probe). A map tool result is the MCP
`{ content, isError, structuredContent }`; failures arrive three ways
(`isError: true`, a page-side `{ ok: false }`, a missing tool) and the `map()`
helper in `arcgis-rest/skills/mappi/SKILL.md` is the one place that turns all three
into a throw. That skill also holds the only ArcGIS-result-to-map recipe; the
plugin's skill stops at the file and points there. The map server runs in
another directory (or container), so `geometry_files[].path` and `saved.path`
are absolute file paths for other programs (mappi's `/artifacts`), while per-feature references stay relative to
keep them short; `resolveReferences` accepts both spellings.

The `PI_BIN` override is resolved
relative to the invoking `$PWD`, so it must stay above the `cd -- "$project_dir"`.

## Coupled Edits

- Changing pi flags or their order in `arcpi` → update the `assert.deepEqual`
  args array and `expectedSources` in `test/launcher.test.ts`.
- Adding a skill → `arcgis-rest/skills/<name>/SKILL.md` (named after its folder),
  the `skill:<name>` check in `test/smoke.sh`, the README "Skills" table. It must
  stand alone: the layout test refuses names of other checkouts or skill trees.
- The launcher test copies `arcpi` and the extension directory into a temp
  project and drives a fake `pi` Node script (`TEST_EXIT` for exit-code
  forwarding). Extend that fake rather than adding fixture files. Moving the
  extension directory → update the copy there.
- Changing `arcgis_request` arguments or result shape → `index.ts` schemas,
  `RequestArgs`/`RequestResult` in `arcgis.ts`, `test/arcgis.test.ts`, the `rest()`
  helper and "The tool" in `SKILL.md`, README "Codemode". `reply()` in `index.ts`
  passes `data` through uncopied: keep large bodies out of extra serializations.
- Changing the reference shape, the stored file format, or what counts as a
  shape → `geometry.ts`, the geometry tests in `test/arcgis.test.ts`, "Geometry
  travels by reference" in `SKILL.md`, `references/geometry.md`, the schema
  descriptions in `index.ts`, README "Codemode", and the rule in
  `.pi/APPEND_SYSTEM.md`.
- Changing token, trust, or session behavior → `test/arcgis.test.ts`, README
  "Authentication and token refresh", and "Token rules" above.
- Changing an error message that the skill quotes ("Not signed in", "The token
  was not sent") → `references/errors.md` and `.pi/APPEND_SYSTEM.md`.
- Adding a skill reference file → link it as `` `references/<name>.md` `` in
  `SKILL.md` (the test checks every such link exists) and the README "Skills" table.
- Releasing → bump `version` in `arcgis-rest/plugin.json` and `metadata.version`
  in `SKILL.md`, merge, tag `v<version>`, then attach the plugin zip to a GitHub
  release: `git archive --format=zip --prefix=arcgis-rest/ -o arcgis-rest-<version>.zip v<version>:arcgis-rest`
  (tracked files only, never `.arcgis/` or `artifacts/`).
- `LICENSE` (Apache-2.0) exists twice, at the root and in `arcgis-rest/` for the
  zip; keep them identical (the layout test compares them).
- The `mappi` URL in `arcgis-rest/mcp.json`, or mappi's port, health route or
  served folder → `compose.map.yaml` (network sharing, healthcheck wait,
  shared mount paths) and README "Live map in Docker".
- mappi's tool, `api` or routes → `mappi/server.ts` (the tool description),
  `mappi/index.html`, `test/mappi.test.ts`, the mappi skill's "The `api` surface", README
  "Live map surface".
- `arcgis-rest/mcp.json` server names, or the map server's tool names and result
  shapes → `arcgis-rest/skills/mappi/SKILL.md` (the `map()` helper and tool
  table), the `extensions."dev.pi"` entry in `plugin.json`, the `mappi`
  expectation in `test/arcgis.test.ts` and `test/smoke.sh`, `.pi/APPEND_SYSTEM.md`,
  README "Maps" and "MCP servers".
- Adding a top-level project folder → the names refused for `ARCPI_ARTIFACTS_DIR`
  in `arcpi` and `PROJECT_DIRS` in `geometry.ts` (shared by `arcgis.ts` and mappi),
  the refused names in both test files, and README.
- Adding a server to `arcgis-rest/mcp.json` → its pi `description` in
  `plugin.json`, the `pluginMcpServers(plugin)` and registered-server
  expectations in `test/arcgis.test.ts`, README "MCP servers". A server that
  needs a key belongs in the user's `~/.pi/agent/mcp.json`, not the plugin.
- `mcp.json` stays in Agent Plugins format: `$schema` of the same spec version as
  `plugin.json`, closed server variants, no secrets in `headers`. A stdio server
  needs `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` expansion added to `mcp.ts` first.
- Bumping pi or Node in `Dockerfile` → README "Docker smoke test" and the
  minimum versions in README and above.
- `.pi/settings.json` is tracked (codemode only); keep `defaultTools` to
  `+name`/`-name` entries so it layers on user settings instead of replacing them.
  Changing its tools → the `defaultTools` assertion in `test/launcher.test.ts`
  and the active-tool check in `test/smoke.sh` (`codemode` on, `bash` off).
  pi ignores the file in an untrusted project or when it cannot lock it.
- Behavior changes → README section and, if agent-facing, `.pi/APPEND_SYSTEM.md`
  or the matching skill.

## Coding Conventions

Use two-space indentation, Bash `snake_case`, and TypeScript `camelCase` (wire
and file formats keep their own names, such as `refresh_token`, `save_to`).
Preserve `set -euo pipefail`, executable permissions, quoted paths, and stderr
diagnostics. Resolve relative overrides before changing directories. Match existing
style; no formatter is configured.

## Skill Content

REST parameter names are Esri's own (camelCase); never invent snake_case
aliases. Document only what was checked against a live service or
Esri's REST documentation, and say in the skill when an operation consumes
credits. Skills are written here, not copied from other skill trees (licensing),
and verified against Esri's official documentation. Follow `arcgis-map`: VanillaJS and ArcGIS Maps SDK for JavaScript 5.1 or newer
verified stable. Browser OAuth for generated maps is separate from this login.

## Security and Cleanup

Never expose, commit, embed, serve as files, or print `.arcgis/` credentials. The
access-token handoff to mappi's page is internal to its SSE channel. Do not
weaken the trusted-host check, the `token` parameter refusal, or redaction to make
a request work. Keep secrets and artifacts ignored.

Startup, including sign-in commands, permanently deletes regular files in `artifacts/`
older than `ARCPI_ARTIFACTS_MAX_AGE_DAYS` whole days (default 1) by modification
time; an invalid value exits before deleting. `ARCPI_ARTIFACTS_DIR` (default
`artifacts`) names that folder: one plain folder of the project, never a dot folder
or `arcgis-rest`, `mappi`, `test`, `tasks`, `video`. `arcpi` and `configFromEnv` in `arcgis.ts`
check the same rule. The launcher creates the folder with a `.arcpi-artifacts`
marker, never deletes it, and refuses an existing unmarked folder other than the
default `artifacts/` (adopted). A non-default folder adds one `--append-system-prompt` line
telling the model to read `artifacts/` as that folder. Never follow symlinks or delete outside
`artifacts/`. Serve only `artifacts/`, not the project root. `save_to` writes only
under `artifacts/`, and geometry files live in `artifacts/geometry/`. Reference
reads and artifact writes refuse symlinks at every component, including the root.

## Commits and Pull Requests

Use concise imperative commits with type prefixes, following the existing `feat:`
example. Describe scope and test results in PRs; link relevant issues. Update README
for behavior changes. Preserve unrelated work; commit, push, or publish only when requested.
