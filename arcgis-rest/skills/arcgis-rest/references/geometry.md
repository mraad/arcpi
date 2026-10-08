# Geometry: measure, reshape, project

`<geometry>` is `helpers.geometry` from the portal's
`helperServices.geometry.url`, a GeometryServer. It works on the shapes you
give it, by reference (see "Geometry travels by reference" in `SKILL.md`), and
its results come back as references too. It reads no layer and costs no
credits.
Reference reads and generated files stay under `artifacts/` and refuse symlinks
at every component, including `artifacts` itself.

On ArcGIS Online this is a public utility service that accepts no token. The
tool finds that out on the first call and then calls it anonymously, so the
result carries a `note` saying the token was not sent. That is expected here.

Its answers do not say which spatial reference they are in: always pass `sr`
(or `outSR`), which is also what the stored file is labelled with.

## Area and perimeter: `<geometry>/areasAndLengths`

| Parameter | Meaning |
|---|---|
| `polygons` | Array of polygon references: `[feature.geometry]`. |
| `sr` | WKID of those polygons, e.g. `4326`. |
| `calculationType` | `geodesic` for anything in longitude/latitude. The default `planar` on WKID 4326 returns square **degrees**, which is meaningless. |
| `areaUnit` | `{ areaUnit: "esriSquareKilometers" }`; also `esriSquareMiles`, `esriSquareMeters`, `esriHectares`, `esriAcres`. Default with `geodesic`: square meters. |
| `lengthUnit` | A number: `9001` meters (default), `9036` kilometers, `9093` miles. |

Response: `{ areas: [], lengths: [] }`, one entry per polygon, in input order.
Holes are subtracted, and all rings of one polygon count as one area.

Area of a drive-time polygon (ask the service area for `outSR: 4326`):

```js
const polygon = serviceArea.saPolygons.features[0].geometry; // a reference
const { areas, lengths } = await rest(`${helpers.geometry}/areasAndLengths`, {
  polygons: [polygon], sr: 4326, calculationType: "geodesic",
  areaUnit: { areaUnit: "esriSquareKilometers" }, lengthUnit: 9036,
});
return { km2: areas[0], sq_mi: areas[0] / 2.58999, perimeter_km: lengths[0] };
```

For many features send them in one call
(`polygons: features.map((f) => f.geometry)`), not one call each. A hosted
feature layer often already has the numbers: check for `Shape__Area` /
`Shape__Length` fields, whose units are those of the layer's spatial reference.

Line length: `<geometry>/lengths` with `polylines: [reference]`, `sr`,
`calculationType: "geodesic"`, `lengthUnit`. Response: `{ lengths: [] }`.

## Reshape

Each takes `geometries: { geometryType, geometries: [references] }` and `sr`,
and answers with references to new files.

| Operation | Extra parameters | Result |
|---|---|---|
| `<geometry>/union` | | `geometry`: all inputs dissolved into one shape |
| `<geometry>/generalize` | `maxDeviation` (in `sr` units; `0.01` degrees is about 1 km) | `geometries[]`: the same shapes with far fewer vertices |
| `<geometry>/simplify` | | `geometries[]`: topologically valid versions |
| `<geometry>/intersect` | `geometry: { geometryType, geometry: reference }` to cut with | `geometries[]`: each input clipped to it (`{ rings: [] }` when they do not meet; example below) |
| `<geometry>/buffer` | `inSR`, `outSR`, `distances`, `unit` (`9001` meters), `geodesic: true`, `unionResults` | `geometries[]`: buffers; inputs may be points `{ x, y }` |

`generalize` is how a heavy shape becomes a light filter: Rhode Island's five
counties go from 58,748 vertices to 351 at `maxDeviation: 0.01`.

Overlap of two results, e.g. two drive-time areas from one `solveServiceArea`
call (its polygons are `saPolygons.features[]`, matched to facilities by
`attributes.FacilityID`). Both parameters take the wrapper objects exactly as
in the table, with references where the shapes go:

```js
const [a, b] = serviceArea.saPolygons.features.map((f) => f.geometry); // references, solved with outSR: 4326
const { geometries: [overlap] } = await rest(`${helpers.geometry}/intersect`, {
  geometries: { geometryType: "esriGeometryPolygon", geometries: [a] },
  geometry: { geometryType: "esriGeometryPolygon", geometry: b },
  sr: 4326,
});
if (!overlap.$geometry) return { intersects: false };  // no overlap: { rings: [] }, no file
return { intersects: true, vertices: overlap.vertices }; // the shape is in the call's geometry_files
```

With no overlap the result is an empty polygon, `{ rings: [] }`, inline and
without a file, so test for `$geometry` rather than for `null`. Call the tool
directly (not `rest`) when you need the new file's path for the map.

## Project: `<geometry>/project`

`geometries: { geometryType, geometries: [references or points] }`, `inSR`,
`outSR`. Response: `{ geometries: [] }` in input order. Most services reproject
for you (`outSR` on queries and solves, `inSR` on spatial filters), so this is
only needed for coordinates that never pass through such a call.

## Heavy shapes

A reference shows `vertices` before anything is sent. Measured against a hosted
feature layer, as one merged filter:

| Filter | Vertices | Sent | Query time |
|---|---|---|---|
| 58 county polygons, full detail | 292,761 | 8.9 MB | 7.5 s |
| the same, fetched with `maxAllowableOffset: 0.01` | 3,468 | 67 KB | 0.2 s |

Full detail works but is slow, and each service has its own size limit. When a
filter runs to hundreds of thousands of vertices, or a call fails or times out
on size:

1. **Fetch it lighter.** Add `maxAllowableOffset` (in `outSR` units) to the
   query that produces the shapes, or `generalize` them afterwards. Edges move
   by up to that distance, so features right on a boundary can flip (535
   matches became 532 above): say so when it matters.
2. **Coarse, then exact.** Filter by the shape's `bbox` as an
   `esriGeometryEnvelope` first, then apply the exact shape to the survivors
   (`objectIds`).
3. **Fewer, larger groups.** Merge references in groups and run a few queries
   whose results you combine. Never one query per shape.
