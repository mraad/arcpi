---
name: arcgis-map
description: Create or update geographic maps using VanillaJS and ArcGIS Maps SDK for JavaScript 5.1 or newer stable. Use for map requests and visualizing ArcGIS REST results, portal items, or local geospatial data.
---

# ArcGIS maps with VanillaJS

Build the requested map as runnable HTML, CSS, and plain JavaScript. Use ArcGIS
Maps SDK for JavaScript and its web components. Default to a single HTML file
under `artifacts/` with a descriptive filename; reuse the user's existing map
when updating it. Add adjacent data files when useful. No framework, bundler,
or package install is needed for the normal CDN workflow.
An explicit user request for a different stack takes precedence.

Use codemode for analysis (local-gis for local data, arcgis-rest for remote
services) and the SDK for rendering and UI. Examples found elsewhere often use
4.x, TypeScript or bundler imports: adapt them to VanillaJS, the selected 5.1+
CDN entry and `$arcgis.import`, and verify version-sensitive APIs in the
[API reference](https://developers.arcgis.com/javascript/latest/api-reference/)
before using them.

## SDK version and loading

Use **5.1** by default (verified stable on 2026-09-19). If the user requests
latest or a feature needs a newer SDK, check the
[official overview](https://developers.arcgis.com/javascript/latest/) and
[release notes](https://developers.arcgis.com/javascript/latest/release-notes/)
once per session and reuse that verified version. If verification is unavailable,
use 5.1 and state the limitation. Keep imports and styles on one concrete stable
version; never use `next` or a guessed version.

Follow the [CDN setup guide](https://developers.arcgis.com/javascript/latest/get-started/).
For 5.1, this module entry loads the core API, components, and component styles:

```html
<script type="module" src="https://js.arcgis.com/5.1/"></script>
```

Use `<arcgis-map>` (or `<arcgis-scene>` for a requested 3D map), give the page
and map an explicit height, and add only useful controls. Load core classes
through `$arcgis.import("@arcgis/core/Graphic.js")` in a module script. Wait
for `viewElement.viewOnReady()` before manipulating the view. Prefer components
over legacy widgets and AMD `require()`. A programmatic MapView/SceneView also
needs the matching core stylesheet; consult the guide when choosing that path.

```html
<arcgis-map basemap="hybrid">
  <arcgis-zoom slot="top-left"></arcgis-zoom>
  <arcgis-legend slot="bottom-left"></arcgis-legend>
</arcgis-map>
<script type="module">
  const [FeatureLayer] = await $arcgis.import(["@arcgis/core/layers/FeatureLayer.js"]);
  const viewElement = document.querySelector("arcgis-map");
  await viewElement.viewOnReady();
  const layer = new FeatureLayer({
    url: "https://<host>/arcgis/rest/services/<name>/FeatureServer/0",
    definitionExpression: "STATUS = 'ACTIVE'",
    outFields: ["NAME", "STATUS"],
    renderer: { type: "simple", symbol: { type: "simple-marker", size: 6, color: "#1f78b4" } },
    popupTemplate: { title: "{NAME}", content: [{ type: "fields", fieldInfos: [{ fieldName: "STATUS" }] }] },
  });
  viewElement.map.add(layer);
  await viewElement.whenLayerView(layer);
  await viewElement.goTo(await layer.queryExtent().then((r) => r.extent));
</script>
```

## Layers and styling

- Services: `FeatureLayer` (filter with `definitionExpression`, never by
  downloading everything), `MapImageLayer`, `ImageryLayer`, `VectorTileLayer`.
  Portal items: `Layer.fromPortalItem({ portalItem: { id } })`, or a whole web
  map with `<arcgis-map item-id="...">`.
- Files: `GeoJSONLayer` (WGS84), `CSVLayer` (`latitudeField`/`longitudeField`),
  `ParquetLayer`; client rows: a `FeatureLayer` with `source`, `fields`,
  `objectIdField` and `geometryType`. A few markers or shapes: `GraphicsLayer`.
- Renderers autocast from plain objects: `simple`, `unique-value` (field +
  `uniqueValueInfos`), `class-breaks` (field + `classBreakInfos`), `heatmap`,
  plus `visualVariables` (size, color, opacity). Give every renderer a legend
  title and readable labels.
- Popups: `popupTemplate` with a `{FIELD}` title and `fields` content; set
  `outFields` to what the popup and renderer use. Labels: `labelingInfo`.
- Projection in the page: `@arcgis/core/geometry/operators/projectOperator.js`
  (`await projectOperator.load()` before `execute`). Other geometry operators
  live in the same folder; prefer server-side analysis through arcgis-rest for
  large inputs.

## Data and authentication

- Reuse available local data and earlier results; follow local-gis for local
  sources. Load arcgis-rest only when a remote source or operation needs it.
  SDK layers can load service data
  normally. Never invent geometry or replace failed analysis with approximate shapes.
- Preserve coordinate reference systems. GeoJSON uses longitude/latitude WGS84;
  Esri geometry carries spatialReference. Project coordinates when needed rather
  than relabeling them. For a FeatureServer containing multiple layers, inspect
  it and include the relevant layers instead of silently selecting layer 0.
- For public/local data, use an accessible basemap that works without secrets.
  For private portal content, set the SDK's `portalUrl` from ARCGIS_PORTAL_URL
  before loading portal items and use browser OAuth with OAuthInfo,
  IdentityManager, and ARCGIS_CLIENT_ID. Consult the current
  [authentication guide](https://developers.arcgis.com/javascript/latest/authentication/access-tokens/).
  Set the same portal URL on OAuthInfo and any explicit Portal instances; do not
  let examples silently default to ArcGIS Online. Never log credentials
  or tokens, including in OAuth event callbacks or copied diagnostic examples.
  The application's localhost redirect must be registered with its OAuth app.
- Browser JavaScript cannot read shell environment variables. Resolve the portal
  URL and client ID during file creation and serialize these non-secret values
  safely into configuration. Never embed cached session tokens, refresh tokens,
  client secrets, or shell API keys in generated HTML/JS or URLs. The arcpi login and
  browser login are separate; explain any browser sign-in requirement.
- Keep a map request local unless the user also asks to publish or share it.
  Publishing and sharing are explicit, separate requests (arcgis-rest write rules apply).

## Finish the map

Fit the view to the actual data. Provide a meaningful title, readable symbols,
useful popups and legend when needed, attribution, and visible loading/empty/error
states. Treat attribute text as untrusted; use textContent or safe escaping for
custom DOM content. Preserve existing artifacts unrelated to the request.

## Local delivery and opening

Prefer a self-contained HTML file under `artifacts/`: inline generated GeoJSON and
other local result data instead of relying on a background HTTP server. This
allows the launcher to open the map directly with `open artifacts/<name>.html` and
avoids reporting a localhost URL that the user's browser cannot reach.

Use HTTP only when the browser requires it (for example, when module/data
fetches or OAuth cannot work from `file://`). You cannot start a server: ask
the user to run `node mappi/server.ts --static`, which serves `artifacts/` at
`http://127.0.0.1:8000/<name>.html`, or on the port the user gives as `PORT`
(keep relative data files beside the HTML). For OAuth, the map's redirect URI
is that exact URL, port included. Report the URL and the
direct-file fallback. Never suggest serving the project root, which contains
`.arcgis` credentials.

Before claiming the map is open, check that the target file exists and use the
same exact path/URL in the open command and the response. If browser tooling is
not available, say that visual verification was not run rather than implying
that opening succeeded. Verify rendering, layers, extent, and console/network
errors when browser tooling is available.
