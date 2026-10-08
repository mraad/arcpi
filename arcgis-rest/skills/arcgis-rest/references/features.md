# Feature layers: schema and queries

Works for hosted feature services, ArcGIS Server feature services and the
layers of map services (`.../MapServer/<id>/query`). Queries cost no credits.

## Schema

- `<service>` (ends in `/FeatureServer`): `layers[]` and `tables[]` (each
  `id`, `name`, `geometryType`), `capabilities`, `maxRecordCount`,
  `spatialReference`.
- `<service>/<layerId>`: `name`, `type`, `geometryType`, `objectIdField`,
  `fields[]` (`name`, `type`, `alias`, `domain`), `extent`, `maxRecordCount`,
  `capabilities`, `advancedQueryCapabilities` (`supportsPagination`,
  `supportsStatistics`, `supportsDistinct`), `drawingInfo`.

Read the layer once before writing a `where` clause: field names are exact,
and coded-value domains (`fields[].domain.codedValues`) mean the stored value
differs from the label users see. For a quick look at real values:

```js
const sample = await rest(`${layer}/query`, { where: "1=1", outFields: "*", returnGeometry: false, resultRecordCount: 5 });
```

## Query: `<layer>/query`

| Parameter | Meaning |
|---|---|
| `where` | SQL-92 filter. `1=1` for all. Strings in single quotes (`STATE = 'CA'`), `LIKE 'San%'`, `IN (...)`, `IS NULL`. Dates: `EDITED >= DATE '2026-01-01'` or `TIMESTAMP '2026-01-01 00:00:00'`. |
| `outFields` | Comma-separated field names, or `*`. Ask only for what you need. |
| `returnGeometry` | `false` when geometry is not needed: much smaller responses. Default `true`. |
| `outSR` | WKID for returned geometry, e.g. `4326`. Default is the layer's. |
| `orderByFields` | `POP DESC, NAME`. Give a stable order when paging. |
| `resultOffset`, `resultRecordCount` | Paging. The server caps the count at `maxRecordCount`. |
| `returnCountOnly` | `true` returns `{ count }`. |
| `returnIdsOnly` | `true` returns `{ objectIdFieldName, objectIds[] }`, not limited by `maxRecordCount`. |
| `objectIds` | Comma-separated object IDs to fetch. |
| `returnDistinctValues` | `true` with `outFields` and `returnGeometry: false` lists distinct values. |
| `outStatistics` | Array of `{ statisticType, onStatisticField, outStatisticFieldName }`; types `count`, `sum`, `min`, `max`, `avg`, `stddev`, `var`. |
| `groupByFieldsForStatistics` | Fields to group the statistics by. |
| `geometry`, `geometryType`, `inSR`, `spatialRel` | Spatial filter, see below. |
| `distance`, `units` | Buffer around the filter geometry. |
| `geometryPrecision`, `maxAllowableOffset` | Thin the returned geometry (decimal places; generalization tolerance in `outSR` units). |
| `f` | `json` (default) or `geojson`. |

Response (`f: json`): `objectIdFieldName`, `geometryType`,
`spatialReference`, `fields[]`, `features[]` (each `attributes` and, unless
turned off, `geometry`), and `exceededTransferLimit: true` when more rows
match. A point geometry is `{ x, y }`. A line or polygon arrives as a
reference to a file (`SKILL.md`, "Geometry travels by reference"): the
features, with attributes, are in the file named in `geometry_files`. The
spatial reference is on the response, not on each geometry.

Response (`f: geojson`): a `FeatureCollection` in WGS84 unless `outSR` says
otherwise, with `properties` instead of `attributes`;
`properties.exceededTransferLimit` flags more rows. Shapes are references here
too. With `save_to` the whole collection goes to the file you name instead.
Its paging flag is retained as `saved.exceededTransferLimit`, and the row count
as `saved.features`, so the script can page without reading geometry files.

Date fields come back as epoch milliseconds (UTC).

### Count, statistics, distinct

```js
const { count } = await rest(`${layer}/query`, { where: "STATE_ABBR = 'CA'", returnCountOnly: true });

const byState = await rest(`${layer}/query`, {
  where: "1=1", groupByFieldsForStatistics: "STATE_ABBR",
  outStatistics: [
    { statisticType: "sum", onStatisticField: "POPULATION", outStatisticFieldName: "pop" },
    { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" },
  ],
  orderByFields: "pop DESC", resultRecordCount: 10,
});
// byState.features[i].attributes = { STATE_ABBR, pop, n }

const states = await rest(`${layer}/query`, { where: "1=1", outFields: "STATE_ABBR", returnDistinctValues: true, returnGeometry: false });
```

Prefer server-side statistics over downloading rows to add them up.

### Spatial filters

| Parameter | Value |
|---|---|
| `geometry` | Point: `"lon,lat"` or `{ x, y }`. Envelope: `"xmin,ymin,xmax,ymax"`. Line or polygon: the reference from an earlier result, or `{ $geometry: [references] }` to merge several. |
| `geometryType` | `esriGeometryPoint`, `esriGeometryEnvelope`, `esriGeometryPolygon`, `esriGeometryPolyline`, `esriGeometryMultipoint`. |
| `inSR` | WKID of the filter geometry (`4326` for lon/lat). Always set it. |
| `spatialRel` | `esriSpatialRelIntersects` (default), `esriSpatialRelContains`, `esriSpatialRelWithin`, `esriSpatialRelOverlaps`, `esriSpatialRelTouches`, `esriSpatialRelCrosses`, `esriSpatialRelEnvelopeIntersects`. |
| `distance`, `units` | Buffer distance and `esriSRUnit_Meter`, `esriSRUnit_Kilometer`, `esriSRUnit_StatuteMile`, `esriSRUnit_Foot`, `esriSRUnit_NauticalMile`. |

Features within 10 miles of a point:

```js
const near = await rest(`${layer}/query`, {
  where: "1=1", outFields: "NAME,ADDRESS", returnGeometry: false,
  geometry: "-117.1956,34.0566", geometryType: "esriGeometryPoint", inSR: 4326,
  spatialRel: "esriSpatialRelIntersects", distance: 10, units: "esriSRUnit_StatuteMile",
});
```

Features inside another layer's polygons: pass those polygons by reference.

```js
const zone = await rest(`${zones}/query`, { where: "NAME = 'Suffolk County'", outFields: "NAME", outSR: 4326 });
const shape = zone.features[0].geometry; // a reference, not coordinates
const inside = await rest(`${layer}/query`, {
  where: "1=1", outFields: "NAME", returnGeometry: false,
  geometry: shape, geometryType: shape.type, inSR: 4326, spatialRel: "esriSpatialRelIntersects",
});
```

The layer's own spatial reference does not have to match: the server
reprojects from `inSR` (the `wkid` in `geometry_files`). Check `vertices`
before using a shape as a filter: see "Heavy shapes" in `geometry.md`.

### Paging

See the paging recipe in `SKILL.md`. When a layer reports
`supportsPagination: false`, fetch `returnIdsOnly: true`, then query
`objectIds` in chunks of `maxRecordCount`. Also use this approach if an offset
query returns no features with `exceededTransferLimit: true`; that page does
not prove completeness. Reduce each page in the script or save it to its own
file instead of accumulating a dataset in sandbox memory.

## Related records and attachments

- `<layer>/queryRelatedRecords`: `objectIds`, `relationshipId` (from the
  layer's `relationships[]`), `outFields`, `returnGeometry`.
- `<layer>/<objectId>/attachments`: lists attachments; each is downloadable at
  `<layer>/<objectId>/attachments/<attachmentId>` with `save_to`.

## Edits

`<layer>/addFeatures`, `updateFeatures`, `deleteFeatures`, `applyEdits`
change data. Run them only as a single call the user asked for, after
querying the current state, and report each entry of `addResults` /
`updateResults` / `deleteResults` (`success`, `objectId`, `error`). A layer
whose `capabilities` lacks `Create`, `Update` or `Delete` refuses them.
