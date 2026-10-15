# Local model: LFM2.5-24B-A2B (2026-10-15, branch feat/local-lfm2.5)

Goal: run arcpi on this Mac with LiquidAI LFM2.5-24B-A2B (24B MoE, ~2.4B active, 128K
context, released 2026-10-09), find the gaps it exposes, compare with Claude and GPT-5.6 Sol.

- [x] 1. Branch, version 0.3.4 → 0.4.0 (`plugin.json`, arcgis-rest `SKILL.md`)
- [x] 2. GGUF Q8_0 in `~/models`, llama.cpp router (`-np 1`) on 127.0.0.1:8091, pi's
      built-in `llama.cpp` provider (credential in `~/.pi/agent/auth.json`, catalog primed via RPC)
- [x] 3. Eval `--minutes` cap; `lfm2.5` run: 1/8 (590 of 655 scripts failed, mostly `require`)
- [x] 4. Gap fixes: QuickJS `tools.read` line in APPEND_SYSTEM; the layer description refuses
      query parameters; a failed GP task URL names the service's tasks. 45 tests pass
- [x] 5. Re-run: `lfm2.5-fixes` (8 tasks) and `sol` (Azure GPT-5.6 Sol); report vs `contract`
- [x] 6. Docs: `docs/local-model.md`, README, AGENTS.md
- [x] 7. `bash -n arcpi`, `node --test test/` (45 pass), `git diff --check`; commit when asked

# Request contract and code-mode skills (2026-10-14, branch feat/request-contract)

Plan: ~/.claude/plans/inspect-the-added-arcpi-hidden-breeze.md. Goal: fewer
hallucinated REST calls. Scripts stay JavaScript (QuickJS); repo code TypeScript.

- [x] 1. `eval/`: tasks, runner, scorer; baseline 24/24 correct, $1.65 (Bedrock Sonnet 4.6: Anthropic login out of usage, Sonnet 5.5 not enabled on Bedrock)
- [x] 2. `catalog.ts` from Esri docs pages (Enterprise + World geocoder/routing) plus live-honored names (`having`, `returnQueryGeometry`, `featureEncoding`); enforced in `request()`; tests. Enum checks dropped: services already reject bad values loudly (checked live)
- [x] 3. GP inputs checked against the task (cached per profile); layer fields diagnosed only after a failed query (no extra request on success)
- [x] 4. Drift test: js blocks compile, reference parameter tables match the catalog (mutation-checked). Example-literal parsing skipped: tables cover it
- [x] 5. `references/geoprocessing.md`, every block run live (sync, async with resume). Follow-up: a wait for job polling (scripts have no timers)
- [x] 6a. `references/imagery.md`, every block run live
- [x] 6b. `references/publishing.md` (user approved test writes): `addItem` with `text` makes a CSV item without a
      file, so `analyze`/`publish` fail; documented route is `createService` → `addToDefinition` → `addFeatures`,
      verified live with `shareItems`, `update`, `delete` (test items deleted, confirmed gone). The recipe
      itself was not re-run (auto-mode blocked a create without cleanup); its calls match the verified flow
- [x] Security: a portal `analyze` error quoted a server-minted token in a URL and redaction missed it
      (only the session's own tokens were redacted). Every `token=`/`access_token=` URL value is now redacted
- [x] 7. Eval after (`eval/RESULTS.md`, 3 reps each): both 24/24 correct; cost $1.65 → $1.36,
      failed scripts 4 → 0, REST calls 72 → 63, wall 426 → 371 s; gains are in the new domains
      (gp median 150k → 93k tokens, 7 → 5 turns). The contract refused nothing live: replaying the
      baseline calls, it would have refused 6 (`inSR` on image identify, one run). The tasks are too
      easy to show a correctness change; harder tasks are needed for that. Docker smoke passed (44 tests, extension, settings, mcp.json)
- [x] GP and geometry gap review. Geometry: three wire traps (unit codes, `areaUnit` object, wrapped
      operand) were already in the reference, but the service
      answers them with misleading errors ("empty geometry"), checked live, so the tool now refuses them
      (`geometryValueProblem`). GP: added discovery (16 GPServer `helperServices` on the org, portal search),
      the 120 s request cap for long `execute` runs, and `Promise.allSettled` over several outputs.
      Not taken: `findTransformations` (no catalog entry yet)
- [ ] 8. Gated: utility network, linear referencing, knowledge graph (needs a verification instance)
- [ ] 9. Later: OpenShell isolation (`docs/openshell.md`)

# Skills review and optimization (2026-10-08, branch refactor/skills-review)

Evidence: the recorded demo run spent 3 min 17 s reasoning (10,900 characters),
mostly on the `intersect` parameter shape, whether two solved polygons can share
one file, what an empty intersection looks like, and three one-file reads.

- [x] 1. arcgis-rest SKILL.md: drop DuckDB leftovers (SQL constants, `ST_Read`
      union, a removed mappi section); layout test also refuses `ST_Read`
- [x] 2. geometry.md: worked `intersect` example; empty result `{ rings: [] }`
      inline without a file (checked live, free)
- [x] 3. SKILL.md, mappi: one file per response, feature `n` is `<file>#<n>`,
      style by attribute; fit several layers by merging extents
      (`api.zoomTo` takes no list)
- [x] 4. routing.md: several facilities in one solve, `FacilityID`, overlap pointer
- [x] 5. APPEND_SYSTEM.md: read the skill and all needed references in one script
- [x] 6. APPEND_SYSTEM.md trimmed 5,391 → 3,839 bytes (details live in the skills)
- [x] 7. `node --test test/` 39 pass; no paid re-run

# Public release (2026-10-08)

The repository was published as a fresh history (one initial commit) from a
private working repository. Commits use the GitHub noreply address.

# Demo videos: terminal + live map, merged side by side (2026-10-08)

Decided (user): VHS for the terminal; tooling in `docs/video/`; one real run
(two credit-billed drive-time solves on a test ArcGIS Online organization).

- [x] 1. `docs/video/record-map.ts`: headless Chrome screencast of mappi's page
      → ffmpeg at a constant frame rate; writes the first frame's wall time
- [x] 2. `docs/video/demo.tape`: compose up mappi, compose run arcpi, the question;
      ends on a marker the shell prints after pi stops
- [x] 3. `docs/video/record.sh`: start both, finish on the session file's final
      `stop`, hold, stop pi, merge side by side with ffmpeg
- [x] 4. `docs/video.md` + README link (after #21 merges)
- [x] 5. Dry test (no model): map recorder against a local mappi; tape syntax
- [x] 6. Real run; check both videos and the merge

Run 2026-10-08: pi answered in 3 min 42 s (4 tool calls; about 3 min of it model
reasoning before one script that geocoded, solved both service areas,
intersected and drew in 4.4 s). VHS then hung on the prompt-line wait: the
terminal video was rebuilt from VHS's captured frames, and the tape now ends on
a marker (dry-tested). `video/demo.mp4` 2560x800, 253 s.

# Self-contained distribution (2026-10-08)

Decided (user): the plugin ships every skill it uses and names no outside
checkout, product or skill tree. The SDK skill tree it used to load is
internal and unlicensed, so it was not copied: arcgis-map was rewritten to
stand alone and moved into the plugin. mappi and local-gis describe mappi only.
Completed plans were removed from this file (history is in git).

- [x] 1. Launcher: one `--skill arcgis-rest/skills`; no skill-tree override or sentinel
- [x] 2. arcgis-map in `arcgis-rest/skills/`, self-contained
- [x] 3. mappi and local-gis skills, `.pi/APPEND_SYSTEM.md`, `plugin.json`
- [x] 4. Tests: launcher args; layout test refuses outside names in skills
- [x] 5. compose files: no sibling skill mount
- [x] 6. README, AGENTS.md, docs/openshell.md, code comments
- [x] 7. Verify

Verified: `bash -n arcpi`, `node --test test/` 38 pass (guard mutation-checked),
`git diff --check`, Docker smoke green without the sibling mount (pi lists
arcgis-rest, arcgis-map, local-gis, mappi). Not run: a live pi map session.
