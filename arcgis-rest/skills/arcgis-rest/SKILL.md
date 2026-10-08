---
name: arcgis-rest
description: Call ArcGIS REST endpoints directly from a codemode script as the signed-in portal user - search the portal and read items, inspect and query feature layers (attribute, spatial, statistics, paging, GeoJSON), geocode one or many addresses, reverse geocode, autocomplete, solve routes and driving directions, build drive-time areas, closest facility and OD cost matrices, snap GPS points to roads, find places, get elevation, and pull demographics with GeoEnrichment. Use for any ArcGIS data or analysis task - find a layer, look up an item, count or list features, features within or near something, geocode, directions from A to B - even when the user does not say REST.
metadata:
  version: "0.3.4"
---

# ArcGIS REST from codemode

ArcGIS work is done by writing one `codemode` script that calls REST endpoints
through `tools.arcgis_request`. There is no CLI. The tool adds the signed-in
user's token for the portal's own hosts, refreshes it when needed, and throws
on ArcGIS errors, so a script only deals with endpoints and parameters.
Geometry is never handed to a script: shapes live in files and travel as
references (see "Geometry travels by reference").

```js
// Define at the top of every script; scripts share values only through store()/load().
const rest = async (url, params, extra) => (await tools.arcgis_request({ url, params, ...extra })).data;

const found = await rest("/sharing/rest/search", { q: 'title:parcels type:"Feature Service"', num: 5 });
return found.results.map((item) => ({ id: item.id, title: item.title, url: item.url }));
```

## The tool

`tools.arcgis_request({ url, params?, method?, save_to? })` resolves to
`{ status, data?, saved?, geometry_files?, note? }`.

- `url`: an absolute endpoint, or a path starting with `/` on the configured
  portal (`/sharing/rest/search`).
- `params`: the REST parameters under Esri's own names (`outFields`,
  `returnGeometry`, `resultOffset`). Pass objects and arrays as real values;
  they are sent as JSON. Booleans and numbers are fine as is. `f` defaults to
  `json`; set `f: "geojson"` on feature queries when you want GeoJSON.
- `method`: `POST` (default, works everywhere, no URL length limit) or `GET`.
- `save_to`: a path under `artifacts/`, without symlinks. The body is written there
  instead of returned, and `saved` holds
  `{ path, bytes, content_type, features?, exceededTransferLimit? }`, with
  `path` absolute. Use it
  to give a layer export a name of your choice (with `f: "geojson"`) and for
  binary responses (PDF reports), which cannot be returned.
  The paging flag is preserved from JSON or GeoJSON
  `properties.exceededTransferLimit`; `true` means more pages are needed.
- `note` is set when the request went out **without** the token: the host is
  not one of the portal's, or it is a public utility service that refuses
  tokens. Public data still answers; private data then fails with 499/403.

`tools.arcgis_status()` returns the portal, username, token expiry and whether
a user is signed in. It never returns a token.

## Geometry travels by reference

Lines, polygons and multipoints are never returned. The tool writes them to a
GeoJSON file under `artifacts/geometry/` and leaves a reference in their place:

```json
{ "$geometry": "artifacts/geometry/3fa9c1d2e4b6a7c8.geojson#0", "type": "esriGeometryPolygon", "vertices": 127, "bbox": [-117.22, 34.04, -117.17, 34.07] }
```

- Everything else stays in `data`: attributes, counts, `spatialReference`,
  single points (`{ x, y }`, a geocoded `location`) and extents.
- `geometry_files` lists the files written, `{ path, features, wkid }`, with
  `path` absolute: one file per feature list in the response, so all the
  polygons of one solve share a file and feature `n` is `<file>#<n>`. A file
  holds the shapes **with their attributes** (`FacilityID`, `ToBreak`, ...), so
  it can go on the map as it is, styled by an attribute; there is no need to
  split it or repeat a request to get one file per shape.
- To use a shape in a later call, put its reference where the parameter expects
  a geometry. The tool sends the real shape, with its spatial reference:
  - one shape: `geometry: feature.geometry`
  - several, merged into one multipart shape:
    `geometry: { $geometry: features.map((f) => f.geometry.$geometry) }`
  - every shape of a file: `geometry: { $geometry: file.path }`

  A reference works anywhere inside `params`: `polygons: [feature.geometry]`,
  `studyAreas: [{ geometry: feature.geometry }]`.
- `type` is the `geometryType` to pass with a spatial filter. `vertices` says
  how heavy the shape is. `bbox` is `[xmin, ymin, xmax, ymax]` in the shape's
  spatial reference; `bbox.join(",")` is a valid `esriGeometryEnvelope` filter.
- A reference is a plain value: keep it in a variable, return it, or
  `store()` it for a later script. Files under `artifacts/` expire after a day (by default);
  an expired reference says so, and the request is simply repeated.
  References and artifact writes refuse symlinks, including the artifacts root.
- A script cannot see coordinates, and must not try to get them: never `read`,
  `cat` or print a geometry file. Measure with the geometry service
  (`references/geometry.md`), filter with spatial queries, and draw by giving the
  file path to the map.
- Ask for `outSR: 4326` whenever the shapes are meant for the map.

## Rules

- **Never fabricate.** If the response lacks the field you expected (no
  `routes.features`, no `saPolygons`), do not invent IDs, names, URLs or
  geometry. Fix the request or report the failure.
- **Fix the request when it errors.** Read the error text, check the parameter
  names against the reference, and retry. Do not switch to `curl`, `fetch`
  from bash, or another data source.
- **Never pass, print or store a token.** `token` in `params` is rejected.
  Token endpoints (`/oauth2/`, `generateToken`) are not callable.
- **Read first, write only when asked.** Endpoints that change things
  (`addFeatures`, `updateFeatures`, `deleteFeatures`, `applyEdits`, `addItem`,
  `update`, `delete`, `share`, `publish`) are single explicit calls the user
  asked for, after checking current state. Script calls are real and are not
  undone when the script fails. Do not retry a write whose outcome is unknown
  without checking whether it happened.
- **Credits.** Batch geocoding (`geocodeAddresses`), `forStorage: true`,
  routing, service areas, closest facility, OD matrices, GeoEnrichment and
  reports consume the organization's credits per call or per record. Confirm
  the input size with the user before looping over them. Single
  `findAddressCandidates`, `suggest` and `reverseGeocode` calls that are not
  stored are free.
- **Service or sublayer.** A URL ending in `/FeatureServer` is a service with
  one or more layers; `/FeatureServer/0` is one layer. Queries go to a layer
  URL. Do not silently reduce a multi-layer service to `/0`.
- **Completeness.** `exceededTransferLimit: true` means more rows exist. Page
  until it is false or absent before claiming a complete result; a short page
  alone proves nothing. An empty page with the flag still true is incomplete:
  use the ID-chunk approach in `references/features.md` or report it.
- **Cross-layer questions cost two queries.** "B features inside/near A
  features" is one query for A's geometry and one query on B with that
  geometry as the filter. Never loop per source feature. See
  `references/chaining.md`.
- **Return summaries.** Script output is capped (10000 tokens by default).
  Return counts, the few attributes needed, and file paths or references for
  anything geometric; write large tables to `artifacts/` with `tools.write`.
- **Keep work inside codemode.** Chain dependent calls in one script and
  await independent reads together. Reduce each page before fetching the next;
  the sandbox has a 256 MB heap. For many independent reads, process small
  groups with `Promise.allSettled`, inspect every failure, and retain only the
  needed fields. Store small IDs, URLs and cursors across scripts, not datasets.

## Sign-in

The launcher fixes the portal (`ARCGIS_PORTAL_URL`) and OAuth client
(`ARCGIS_CLIENT_ID`). When a call fails with "Not signed in", or with error
498/499 on the portal's own host, check `tools.arcgis_status()` and ask the
user to run `/arcgis-login` in this session (or `./arcpi login` in a shell).
You cannot sign in for them. A 403 "do not have permissions" or "Permission
missing" with a valid session is an entitlement problem, not an expired login:
see `references/errors.md`.

## Endpoints

Portal paths are relative to the portal. Service URLs come from an item's
`url` or from the portal's `helperServices`.

| Task | Endpoint | Reference |
|---|---|---|
| Who am I, my groups, privileges | `/sharing/rest/community/self` | `references/portal.md` |
| Search items | `/sharing/rest/search` | `references/portal.md` |
| Item details / item data | `/sharing/rest/content/items/<id>` , `…/<id>/data` | `references/portal.md` |
| Search groups | `/sharing/rest/community/groups` | `references/portal.md` |
| Portal and org settings, helper services | `/sharing/rest/portals/self` | `references/portal.md` |
| Service or layer schema | `<service>` , `<service>/<layerId>` | `references/features.md` |
| Query features, counts, statistics | `<layer>/query` | `references/features.md` |
| Geocode one address | `<geocoder>/findAddressCandidates` | `references/geocoding.md` |
| Geocode many addresses | `<geocoder>/geocodeAddresses` | `references/geocoding.md` |
| Reverse geocode, autocomplete | `<geocoder>/reverseGeocode` , `<geocoder>/suggest` | `references/geocoding.md` |
| Route and directions | `<route>/solve` | `references/routing.md` |
| Drive-time areas | `<serviceArea>/solveServiceArea` | `references/routing.md` |
| Closest facility, OD matrix, snap to roads | see reference | `references/routing.md` |
| Area, perimeter, length of a geometry; projection | `<geometry>/areasAndLengths` , `…/lengths` , `…/project` | `references/geometry.md` |
| Places near a point or in an extent | Places service | `references/places-elevation.md` |
| Elevation at points | Terrain image service | `references/places-elevation.md` |
| Demographics, standard geographies, reports | GeoEnrichment service | `references/geoenrichment.md` |

Read the reference for a domain before your first call in it. Parameter names
there are the REST names; unknown parameters are silently ignored by most
services, so a misspelt name looks like a default result.

### Helper services

The portal lists its utility services. Resolve them once and keep them:

```js
let helpers = load("arcgis.helpers");
if (!helpers) {
  const h = (await rest("/sharing/rest/portals/self")).helperServices;
  helpers = {
    geocode: h.geocode?.[0]?.url,          // geocoders are a list; the first is the default
    route: h.route?.url,
    serviceArea: h.serviceArea?.url,
    closestFacility: h.closestFacility?.url,
    odCostMatrix: h.odCostMatrix?.url,
    snapToRoads: h.snapToRoads?.url,
    geoenrichment: h.geoenrichment?.url,
    geometry: h.geometry?.url,
  };
  store("arcgis.helpers", helpers);
}
```

A missing key means the portal does not offer that service; say so instead of
substituting a public URL.

## Recipes

For counts or totals alone, use `returnCountOnly` or `outStatistics`. When rows
are needed, process pages without retaining the entire feature array:

```js
// @options: {"max_output_tokens": 2000}
const layer = "https://.../FeatureServer/0";
const schema = await rest(layer);
if (!schema.advancedQueryCapabilities?.supportsPagination) throw new Error("Use object ID chunks; see references/features.md");
const size = Math.min(2000, schema.maxRecordCount);
let count = 0;
for (let offset = 0; ; ) {
  const page = await rest(`${layer}/query`, {
    where: "1=1", outFields: "NAME,POP", returnGeometry: false,
    orderByFields: schema.objectIdField, resultOffset: offset, resultRecordCount: size,
  });
  // Process the attributes needed for the task here, then discard this page.
  count += page.features.length;
  if (!page.exceededTransferLimit) break;
  if (!page.features.length) throw new Error("Incomplete empty page; use object ID chunks");
  offset += page.features.length;
}
return { count };
```

Fan out, keep the successes, report the failures:

```js
const layers = [0, 1, 2].map((id) => `https://.../FeatureServer/${id}`);
const settled = await Promise.allSettled(layers.map((layer) => rest(`${layer}/query`, { where: "1=1", returnCountOnly: true })));
return settled.map((result, i) => ({ layer: layers[i], count: result.value?.count, error: result.reason?.message }));
```

A layer for the map is a GeoJSON file under a name of your choice:

```js
const { saved } = await tools.arcgis_request({
  url: `${layer}/query`, params: { where: "1=1", outFields: "*", outSR: 4326, f: "geojson" },
  save_to: "artifacts/layer.geojson",
});
return saved;
```

An analysis result (a service area, a route) is already on disk, in the file
named in `geometry_files`:

```js
const solved = await tools.arcgis_request({
  url: `${helpers.serviceArea}/solveServiceArea`, params: { facilities: `${x},${y}`, defaultBreaks: "5", outSR: 4326 },
});
const file = solved.geometry_files?.[0];
if (!file) return { error: "No service area returned", messages: solved.data.messages };
return { file: file.path };
```

To draw either one, continue the same script as the mappi skill shows under
"Saved results on the map", with `saved.path` or `file.path`. Never report a
map as shown unless that step succeeded.

One GeoJSON request returns at most the layer's `maxRecordCount` features.
Check `saved.exceededTransferLimit`; if the service omits it, a full page may
still have more rows. For a larger layer save each page to its own file
(`artifacts/layer-0.geojson`, ...) and add one map layer per file.

Keep IDs, URLs or cursors for a later script with `store("key", value)` /
`load("key")`.
