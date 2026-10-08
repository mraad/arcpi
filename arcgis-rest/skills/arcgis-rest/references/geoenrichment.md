# GeoEnrichment: demographics, standard geographies, reports

`<ge>` is `helpers.geoenrichment` from the portal's `helperServices`, ending
in `/GeoenrichmentServer`. Enrichment, geography queries and reports consume
credits per study area and variable: confirm scope with the user. The
discovery endpoints below are free.

## Discover (free)

| Endpoint | Returns |
|---|---|
| `<ge>/Geoenrichment/Countries` | `countries[]`: `id` (2-letter), `name`, `abbr3`, `defaultDatasetID`, `hierarchies`, `defaultDataCollection` |
| `<ge>/Geoenrichment/DataCollections/<countryId>` | `DataCollections[]`: `dataCollectionID`, `metadata.title`, and `data[]` variables (`id`, `alias`, `description`, `vintage`, `units`) |
| `<ge>/Geoenrichment/StandardGeographyLevels/<countryId>` | `geographyLevels[]` with layer IDs such as `US.States`, `US.Counties`, `US.ZIP5`, `US.Tracts` |
| `<ge>/Geoenrichment/Reports/<countryId>` | `reports[]`: `reportID`, `metadata.title`, `formats` |
| `<ge>/Geoenrichment/ServiceLimits` | Maximum ring size, drive time, study areas per request |

`DataCollections/<countryId>` is very large (over 20000 variables for the US):
never return it whole. To find variables, pass `query` (the words to look
for), `returnSimilarity: true` and `outFields: ["id", "alias", "description"]`;
each variable then carries a `similarity` score. Flatten, sort by it and keep
the top few. One collection alone: `DataCollections/<countryId>/<dataCollectionID>`.
A variable is referenced as `<dataCollectionID>.<variableId>`, e.g.
`KeyGlobalFacts.TOTPOP`.

```js
const { DataCollections } = await rest(`${helpers.geoenrichment}/Geoenrichment/DataCollections/US`, {
  query: "median household income", returnSimilarity: true, outFields: ["id", "alias", "description"],
});
return DataCollections
  .flatMap((collection) => collection.data.map((v) => ({ name: `${collection.dataCollectionID}.${v.id}`, alias: v.alias, similarity: v.similarity })))
  .sort((a, b) => b.similarity - a.similarity).slice(0, 10);
```

## Enrich: `<ge>/Geoenrichment/Enrich`

| Parameter | Meaning |
|---|---|
| `studyAreas` | Required. Array of study areas, see below. |
| `analysisVariables` | Array of variable names: `["KeyGlobalFacts.TOTPOP", "KeyGlobalFacts.AVGHHSZ"]`. |
| `dataCollections` | Array of collection IDs; returns every variable in them (more credits). Give this or `analysisVariables`. |
| `studyAreasOptions` | Defaults for areas that are points, e.g. `{ areaType: "RingBuffer", bufferUnits: "esriMiles", bufferRadii: [1, 3, 5] }`. |
| `returnGeometry` | `true` to get the study area polygons, as references. Default `false`. |
| `outSR` | WKID of returned geometry. |

Study area forms:

- Point with rings: `{ geometry: { x: -117.19, y: 34.05 }, areaType: "RingBuffer", bufferUnits: "esriMiles", bufferRadii: [1, 3] }`
- Point with drive time: `{ geometry: { x, y }, areaType: "NetworkServiceArea", bufferUnits: "Minutes", bufferRadii: [10], travel_mode: "Driving" }`
- Polygon: `{ geometry: reference }`, the reference of a polygon from an earlier result (a drive-time area, a boundary)
- Address: `{ address: { text: "380 New York St, Redlands, CA" } }`
- Standard geography: `{ sourceCountry: "US", layer: "US.ZIP5", ids: ["92373"] }`

Response: `results[0].value.FeatureSet[0]` holds `fields[]` (name, alias,
units, vintage) and `features[]`, one per study area and ring, with the
variables in `attributes`. `messages[]` carries warnings (unknown variable,
area without data): report them.

```js
const enriched = await rest(`${helpers.geoenrichment}/Geoenrichment/Enrich`, {
  studyAreas: [{ geometry: { x: -117.1956, y: 34.0566 }, areaType: "RingBuffer", bufferUnits: "esriMiles", bufferRadii: [1, 3] }],
  analysisVariables: ["KeyGlobalFacts.TOTPOP", "KeyGlobalFacts.AVGHHSZ"],
});
const set = enriched.results?.[0]?.value?.FeatureSet?.[0];
if (!set) return { error: "No enrichment result", messages: enriched.messages };
return set.features.map((feature) => feature.attributes);
```

## Standard geographies: `<ge>/StandardGeographyQuery`

Note the path: it sits beside `Geoenrichment`, not under it.

| Parameter | Meaning |
|---|---|
| `sourceCountry` | 2-letter country ID, e.g. `US`. |
| `geographyLayers` | Array of layer IDs to look in: `["US.ZIP5"]`. |
| `geographyIDs` | Array of IDs: `["92373", "92374"]`. Give this or `geographyQuery`. |
| `geographyQuery` | Text to match names or IDs: `"Redlands"`. |
| `returnGeometry` | `true` to include polygons, as references. |
| `returnSubGeographyLayer`, `subGeographyLayer` | List the children of the found geographies, e.g. the ZIP codes of a county. |
| `outSR` | WKID of returned geometry. |

Response: `results[0].value.features[]` with `attributes` (`AreaID`,
`AreaName`, `DataLayerID`, `MajorSubdivisionName`) and geometry when asked.
Use it to get the polygon of a known ZIP code, county or state without
searching for a boundary layer.

## Reports: `<ge>/Geoenrichment/CreateReport`

Returns a file, so pass `save_to`:

```js
const { saved } = await tools.arcgis_request({
  url: `${helpers.geoenrichment}/Geoenrichment/CreateReport`,
  params: {
    studyAreas: [{ geometry: { x: -117.1956, y: 34.0566 }, areaType: "RingBuffer", bufferUnits: "esriMiles", bufferRadii: [3] }],
    report: "dandi", format: "pdf", f: "bin",
  },
  save_to: "artifacts/demographics.pdf",
});
```

| Parameter | Meaning |
|---|---|
| `studyAreas` | As for Enrich. |
| `report` | A `reportID` from `Reports/<countryId>`. |
| `format` | `pdf` or `xlsx`. |
| `f` | `bin` to receive the file itself. |
| `reportFields` | `{ title, subtitle }` shown in the report header. |

Check `saved.content_type` is `application/pdf` (or a spreadsheet type): a
JSON content type means the service returned an error document instead of a
report.
