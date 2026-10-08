# Chaining calls in one script

A script keeps intermediate values (IDs, point coordinates, references to
shapes) in variables, so chain inside one script and return only the answer.
Shapes themselves stay in files and are passed along by reference. Split into two scripts
only when you must read an intermediate result to decide what to do next.

All examples assume:

```js
const rest = async (url, params, extra) => (await tools.arcgis_request({ url, params, ...extra })).data;
```

and `helpers` resolved as in `SKILL.md`.

## Search, then query

```js
const { results } = await rest("/sharing/rest/search", { q: 'title:"Urgent Care" type:"Feature Service"', num: 1 });
if (!results.length) return "No matching service";
const service = await rest(results[0].url);
const layer = `${results[0].url}/${service.layers[0].id}`;
const { count } = await rest(`${layer}/query`, { where: "STATE = 'MA'", returnCountOnly: true });
return { service: results[0].title, layer: service.layers[0].name, count };
```

## Geocode, then features within a distance

```js
const { candidates } = await rest(`${helpers.geocode}/findAddressCandidates`, { SingleLine: "Honobia, OK", maxLocations: 1, outSR: 4326 });
if (!candidates.length) return "Address not found";
const { x, y } = candidates[0].location;
const near = await rest(`${layer}/query`, {
  where: "1=1", outFields: "NAME", returnGeometry: false,
  geometry: `${x},${y}`, geometryType: "esriGeometryPoint", inSR: 4326,
  spatialRel: "esriSpatialRelIntersects", distance: 10, units: "esriSRUnit_StatuteMile",
});
return { matched: candidates[0].address, names: near.features.map((f) => f.attributes.NAME), more: !!near.exceededTransferLimit };
```

## Geocode two places, then directions

Keep the state, country or postal code the user gave in both geocodes: small
town names repeat. Routing consumes credits.

```js
const locate = async (text) => {
  const { candidates } = await rest(`${helpers.geocode}/findAddressCandidates`, { SingleLine: text, maxLocations: 1, outSR: 4326 });
  if (!candidates.length) throw new Error(`Not found: ${text}`);
  return `${candidates[0].location.x},${candidates[0].location.y}`;
};
const [from, to] = await Promise.all([locate("Odin, Missouri"), locate("Hartville, Missouri")]);
const route = await rest(`${helpers.route}/solve`, { stops: `${from};${to}`, returnDirections: true, outSR: 4326 });
const total = route.routes?.features?.[0]?.attributes;
if (!total) return { error: "No route returned", messages: route.messages };
return { minutes: total.Total_TravelTime, miles: total.Total_Miles, steps: route.directions[0].features.map((s) => s.attributes.text) };
```

Do not pass `travelMode` for ordinary driving (`references/routing.md`).

## Cross-layer spatial question: two queries

"Which counties have a warning", "which parcels are in the floodplain",
"which stops fall inside these service areas": layer A supplies the
**geometry**, layer B supplies the **answer**. One query on A, one on B,
however many A features there are.

```js
// 1. The filter shapes from layer A. Only geometry is needed; it arrives as references.
const source = await rest(`${warnings}/query`, { where: "phenom = 'SV'", outFields: "OBJECTID", returnGeometry: true });
if (!source.features.length) return "No source features, so nothing intersects";
// 2. All of them as one multipart shape: a list of references.
const geometry = { $geometry: source.features.map((f) => f.geometry.$geometry) };
// 3. Layer B filtered by that shape.
const hits = await rest(`${counties}/query`, {
  where: "STATE_NAME = 'Ohio'", outFields: "NAME", returnGeometry: false,
  geometry, geometryType: source.geometryType, spatialRel: "esriSpatialRelIntersects", inSR: source.spatialReference.wkid,
});
return { counties: [...new Set(hits.features.map((f) => f.attributes.NAME))].sort(), more: !!hits.exceededTransferLimit };
```

Why each part matters:

- The spatial reference is on the **response** (`source.spatialReference`),
  not on each feature's geometry. Use it for `inSR`; the layers need not share
  a spatial reference.
- Layer A often lacks the attribute the user asked for (no county name on a
  warning). That is expected: the name comes from layer B.
- The same works for lines (`source.geometryType` is then
  `esriGeometryPolyline`). Point features are not references: collect them as
  `{ points: features.map((f) => [f.geometry.x, f.geometry.y]) }` with
  `esriGeometryMultipoint`.
- If step 1 reports `exceededTransferLimit`, page it first and merge the
  references of all pages. Add up `vertices` before step 3: for a heavy
  filter see "Heavy shapes" in `geometry.md`, but never fall back to one query
  per A feature.
- The shapes never enter the script. Return B's attributes.

## Trip with a transit leg

Routing services have no public-transit mode. Solve the walking legs with
`solve` and a Walking Time `travelMode`, and take the ride from a transit
routes layer's real geometry:

1. Pick **one** transit line whose geometry spans both ends of the trip
   (search for the agency's routes feature service, query the line).
2. Board and alight at the points **on that line** nearest the origin and
   the destination, and route the walks to those points. Picking "nearest
   stop" from a separate stops layer does not guarantee the stop is on the
   chosen line.
3. Say plainly that this is a geometry-level approximation without schedules
   or transfers. With no routes layer, use one clearly labeled straight
   segment for the ride and say it is approximate.

## Geocode, then another MCP tool

Any connected MCP server's tools are callable from the same script as
`tools.mcp__<server>__<tool>`. A geocoded point is inline (`location: { x, y }`),
so it passes straight to a tool that takes coordinates; `x` is longitude, `y`
latitude. MCP tools are not listed in the codemode description: find the name
and parameters first with `searchTools("<what>", { namespace: "mcp__<server>" })`
and `describeTool(name)`. An MCP failure is a result with `isError: true`, not a
throw, so check it. The tool below is an example; use the declared names.

```js
const { candidates } = await rest(`${helpers.geocode}/findAddressCandidates`, { SingleLine: "Redlands, CA", maxLocations: 1, outSR: 4326 });
if (!candidates.length) return "Address not found";
const { address, score, location: { x: lon, y: lat } } = candidates[0];
const reply = await tools.mcp__weather__get_forecast({ latitude: lat, longitude: lon });
if (reply.isError) throw new Error(reply.content?.[0]?.text ?? "weather failed");
return { address, score, lat, lon, forecast: reply.structuredContent ?? reply.content?.[0]?.text };
```

For many places, geocode them in one billed `geocodeAddresses` call
(`references/geocoding.md`) after confirming the count, then call the tool per row.

## Wrong turns

- Looping one query per source feature: use the two-query pattern.
- Downloading rows to count or sum them: use `returnCountOnly` or
  `outStatistics`.
- Geocoding rows one at a time: use `geocodeAddresses`
  (`references/geocoding.md`), after confirming the count.
- Returning raw feature arrays: return counts and the needed attributes, and
  `save_to` for the rest.
