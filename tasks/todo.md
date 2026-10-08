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
