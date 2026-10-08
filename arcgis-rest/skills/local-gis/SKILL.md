---
name: local-gis
description: Inspect and analyze local GIS data, ArcGIS Pro project folders (.aprx), FileGDBs and exports (GeoJSON, GeoParquet, CSV) from codemode. Use when the user supplies a local path or asks about local layers; discover sources with native file tools, compute in codemode and draw through mappi without requiring ArcGIS REST or portal login.
---

# Local GIS from codemode

Choose the source first. A readable local export can be analyzed inside a
codemode script without an ArcGIS REST request. A task may also combine local
results with `tools.arcgis_request` in the same script; load arcgis-rest only
for that part. Draw through mappi (its `map()` helper for every map call), or
arcgis-map for a standalone file.

## Find the actual dataset

1. Use `tools.ls({path: folder})` for the supplied project's folder. Use
   `tools.find` / `tools.grep` for targeted discovery and `tools.read` for
   text files. Keep results in the script and return only relevant names,
   fields, units and source paths. Never use a shell command.
2. An `.aprx` is a project document, not a table. Look for the associated
   `.gdb`, exports (`.geojson`, `.parquet`, `.csv`), `Layers.json`, `.lyrx`
   files or other documented sources. Do not claim that drawing in the browser
   changes ArcGIS Pro. Codemode scripts cannot run ArcPy.
3. Read `Layers.json` or layer metadata when present. Display names can differ
   from physical dataset names. A project can reference data outside its own
   folder; do not assume the nearest file is the source. Confirm the source
   from connection metadata or the user when the relationship is ambiguous.
4. Read the real CRS: the GeoJSON `crs` member (none means WGS84), a `.prj`
   beside a CSV or shapefile, or the layer metadata. Never relabel
   coordinates as WGS84.

## What can be read

- **GeoJSON, JSON, CSV**: `tools.read` inside the script; parse, filter and
  aggregate there. Bound the work to the question and return only results.
- **GeoParquet / Parquet**: not parsed in codemode. Copy or export it under
  `artifacts/` and draw it with mappi's `api.parquetLayer`; ask for a CSV or
  GeoJSON export when the task needs its numbers.
- **FileGDB (`.gdb`), `.ddb`, shapefile `.shp`**: binary; no tool here reads
  them. Report that, and ask the user for an export (for example ArcGIS Pro's
  Export Features to GeoJSON, GeoParquet or CSV) or a published service to
  query through arcgis-rest. Never guess a schema or values.

mappi's page reads files only under `artifacts/`. To draw a local GeoJSON from
elsewhere, read it in the script and write the needed features to
`artifacts/<name>.geojson` with `tools.write`, then load that path. The file
contents stay in the script; never return coordinates of lines or polygons.

## Query where the data lives

- Inspect actual fields and units before filtering. Convert numeric text
  explicitly and exclude null/non-finite values.
- Compute counts, aggregates and statistics in the script. For a remote
  feature layer, use ArcGIS counts/statistics and paging instead; do not
  download all records just to calculate a total.
- An export may be older than the geodatabase it came from: say that results
  come from a snapshot when the export date is unknown or old.
- Store only small source descriptors/cursors between scripts.

## Worked pattern: wells and water-depth z-scores

First resolve the actual source, field units, geometry and CRS. Suppose they
turn out to be a GeoJSON export of the wells with `water_depth` in meters, in
WGS84. Another project will differ; find these values, never assume them.

For a user who chooses the wells deeper than 350 m as the comparison group:
read the file in the script, keep features with a finite `water_depth > 350`,
compute the group's mean and population standard deviation, then each well's
`(water_depth - mean) / sd`. No matches or zero variance needs an explicit
result rather than fabricated scores. If the user chooses all valid wells as
the comparison group, compute the statistics before applying the display
filter. State which group was used and that the standard deviation is the
population one.

For a small point result, follow mappi's thematic point recipe: pass the
point rows (attributes plus `lon`/`lat`) straight into `run_map_code` with a
class-breaks renderer centered at zero, and compare the layer's count with the
expected count. Do not return the rows to the model between those calls. If
the user asks to see the generated code, save the codemode source and show
it, without expanding row data.

## Availability

Without mappi, native file tools still inspect metadata and process text
exports inside codemode; write a standalone HTML map from them (follow
arcgis-map). If the only source is binary, report the missing local query
capability and ask for an export. Do not invent a CLI, a source schema, or a
portal URL.
