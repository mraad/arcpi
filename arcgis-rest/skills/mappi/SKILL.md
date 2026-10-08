---
name: mappi
description: Drive the live mappi map from codemode with its `mcp__mappi__run_map_code` MCP tool — draw ArcGIS services by URL, portal items, saved GeoJSON/Parquet results and bounded point rows, with renderers, popups and legends, using arcpi's ArcGIS login. Use for map/visualization requests when the `mcp__mappi` server is connected and no standalone HTML file was asked for.
---

# Live map surface (`mcp__mappi`)

mappi (this project's `mappi/`, `node mappi/server.ts`) hosts an ArcGIS Maps
SDK 5.1 page at `http://127.0.0.1:8787`. Its MCP endpoint is the `mappi` server
in the plugin's `mcp.json`; you call its one tool from `codemode` scripts. The
map is already open in the user's browser: drive it, don't generate a page.
Map server not running, or the user asked for a file → a standalone HTML map
under `artifacts/` (follow arcgis-map).

## The tool

Start every map script with this helper. It is the one place that detects a
failed map call, and it throws for each kind: a tool error (bad argument), a
page error (`{ ok: false }`: no browser tab open, or the JS threw), and a
missing tool (the map server is not running).

```js
const map = async (tool, args = {}) => {
  const reply = await tools[`mcp__mappi__${tool}`](args);
  const value = reply.structuredContent;
  if (reply.isError || value?.ok === false) throw new Error(value?.error ?? reply.content?.[0]?.text ?? `${tool} failed`);
  return value;
};
```

`map("run_map_code", { js, timeout? })` runs `js` in the open page as an async
function body with `api` (you may `await`) and returns `{ ok, result, error,
console }`; `timeout` is in seconds (default 15). Use only `api.*` and
`return` a small JSON-safe summary. On a failure read the error (it carries
the stack) and re-send a fix. `describeTool("mcp__mappi__run_map_code")` gives
the full description.

## The `api` surface

- `api.view`, `api.map`; `api.signal` (an AbortSignal: honor it in long work).
- `api.import(paths)` → `$arcgis.import(...)` for any `@arcgis/core/...` module.
- `api.addLayer(layer, { name, zoom })` returns the layer and adds an attribute
  popup; `api.removeLayer(name)`, `api.clearLayers()`, `api.layers` (a Map by name).
  It takes a **layer**: a `Graphic` on its own is not one (put graphics in a
  `GraphicsLayer`).
- `api.zoomTo(target)`, `api.legend()` (the legend also updates itself).
- `await api.parquetLayer(absolutePath, { name, zoom })` → a saved (Geo)Parquet file
  as a layer. Use it rather than `new ParquetLayer`, which in SDK 5.1.4 draws
  nothing for a GeoParquet file without a CRS and reads MultiLineString as points.
- `api.user` → the signed-in ArcGIS username, or `null`.

## Shape of the answer

- **Services draw by URL.** Build the layer in the page (`FeatureLayer` with a
  `definitionExpression`, `MapImageLayer`, `Layer.fromPortalItem`): the SDK
  fetches the data, so drawing a service needs no `arcgis_request` call.
- **Numbers / tables** ("how many", "top N", "by group") → compute them with
  arcgis-rest statistics or in codemode and report in chat. No map.
- **Saved results** (`geometry_files[].path`, `saved.path`, or a file another
  step wrote under `artifacts/`) → the recipe below.
- **A local project or file** → read local-gis first.
- Keep rows inside the script; return only summaries. Complex geometry stays
  on disk for the page to read, never in script results or chat.

## Secured content inherits arcpi's login

If authentication is required while `api.user` is `null`, ask the user to run
`./arcpi login` (or `/arcgis-login`), then re-send. mappi synchronizes the
session before execution and every five seconds while the page is open. SDK
layers and `@arcgis/core/request.js` receive the token automatically for
trusted hosts; plain `fetch()` does not. Never put a token in the JS, start
browser OAuth, or read the session files.

## Saved results on the map

The page reads `.geojson`, `.json` and `.parquet` files under this project's
`artifacts/` through mappi's `/artifacts` route, by the absolute path
`arcgis_request` reports. Draw in the script that fetched the data, and return
the path whatever happens to the map step, so a failed draw never costs a
second request:

```js
const drawn = await map("run_map_code", { js: `
  const [GeoJSONLayer, reactiveUtils] = await api.import(["@arcgis/core/layers/GeoJSONLayer.js", "@arcgis/core/core/reactiveUtils.js"]);
  // A layer can load and still not draw: count what its view drew; this throws when the view cannot draw it.
  const shown = async (layer) => {
    const view = await api.view.whenLayerView(layer);
    await reactiveUtils.whenOnce(() => !view.updating);
    return view.queryFeatureCount();
  };
  const layer = api.addLayer(new GeoJSONLayer({ url: "/artifacts?path=" + encodeURIComponent(${JSON.stringify(file.path)}) }), { name: "result", zoom: true });
  return { features: await layer.queryFeatureCount(), drawn: await shown(layer) };` }).catch((error) => ({ error: error.message }));
return { file: file.path, map: drawn.error ?? drawn.result };
```

Report a layer as shown only when its `drawn` count matches its `features`
count; otherwise report the gap (and any `console` lines of the reply), not
success. Check every layer you add this way, not only the first.

A file can hold several shapes with their attributes (both areas of one
drive-time solve, keyed by `FacilityID`): keep it one layer and give it a
`unique-value` renderer on that field. Several files (an area file and an
intersection file) are several layers; to fit them all, merge their extents
and zoom once: `const extents = await Promise.all(layers.map(async (l) => (await l.queryExtent()).extent));`
then `await api.zoomTo(extents.filter(Boolean).reduce((all, e) => all.union(e)))`. `api.zoomTo`
takes one layer or one view target, not a list of layers, and fails silently.
(Geo)Parquet: `await api.parquetLayer(path, { name, zoom: true })` in the same place.
A 404 for a file you just saved means mappi sees another filesystem (it runs
in a container while arcpi does not): report it, and draw the service by URL
instead when it is public.

## Thematic point maps

Only individual point coordinates may travel inline. For a bounded point set
(attributes plus `lon`/`lat` computed in codemode), check the count and any
truncation, then pass the rows straight into `run_map_code` and build a
client-side `FeatureLayer` (`source` graphics, `fields`, `objectIdField`,
`geometryType: "point"`) with an explicit renderer. Do not return the rows to
the model between those calls. After the layer loads, compare
`await layer.queryFeatureCount()` with the expected count; never assume
everything matched is shown. Lines, polygons, multipoints and large point sets
go to a file and load as above.

For z-scores, use fixed standard-deviation breaks with a diverging color ramp
centered at zero and a legend naming the comparison group; quantile breaks on
z-scores change the color meaning.

## Environment

Another server address or a bearer token is configured on a `mappi` entry in
`~/.pi/agent/mcp.json` or `.pi/mcp.json` (`url`, `headers`), which overrides
the plugin's, not in scripts.
