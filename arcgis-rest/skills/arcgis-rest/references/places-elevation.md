# Places and elevation

## Elevation with an organization account: Terrain image service

`https://elevation.arcgis.com/arcgis/rest/services/WorldElevation/Terrain/ImageServer`
answers with the signed-in ArcGIS Online user's token and consumes no credits.
Heights are meters above mean sea level.

`.../Terrain/ImageServer/getSamples`

| Parameter | Meaning |
|---|---|
| `geometry` | One point `{ x, y, spatialReference: { wkid: 4326 } }`, or many as `{ points: [[lon, lat], ...], spatialReference: { wkid: 4326 } }`. |
| `geometryType` | `esriGeometryPoint` or `esriGeometryMultipoint`. |
| `returnFirstValueOnly` | `true`: one value per location (the best resolution). |
| `sampleCount`, `sampleDistance` | For a polyline geometry (`esriGeometryPolyline`), passed by reference (a route's `geometry`): number of samples along it, for a terrain profile. |

Response: `samples[]`, each `{ location: { x, y }, locationId, value, resolution }`.
`value` is a **string**; convert with `Number(value)`. `locationId` is the
0-based index of the input point, so results can be matched back to inputs.

```js
const points = [[-117.1956, 34.0566], [-116.2, 43.61]];
const { samples } = await rest("https://elevation.arcgis.com/arcgis/rest/services/WorldElevation/Terrain/ImageServer/getSamples", {
  geometry: { points, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryMultipoint", returnFirstValueOnly: true,
});
return samples.map((sample) => ({ lonLat: points[sample.locationId], meters: Number(sample.value) }));
```

On ArcGIS Enterprise, look for the organization's own elevation image service
(`portals/self`.`helperServices.defaultElevationLayers`, or search for
`type:"Image Service" elevation`) and call its `getSamples` the same way.

## Places and the Location Platform elevation service

These two services accept only **ArcGIS Location Platform** accounts:

- Places: `https://places-api.arcgis.com/arcgis/rest/services/places-service/v1`
- Elevation: `https://elevation-api.arcgis.com/arcgis/rest/services/elevation-service/v1`

With an ArcGIS Online or Enterprise organization login they answer error 403
"Permission missing" ("... not from an ArcGIS Location Platform account").
That is an account type limit: signing in again does not help. Tell the user,
and do not swap in OpenStreetMap or another source silently. For elevation use
the Terrain service above; for points of interest, a geocoder search by
`category` (`references/geocoding.md`) or an organization layer may serve.

When the session does belong to a Location Platform account, use `method: "GET"`:

| Endpoint | Parameters |
|---|---|
| `<places>/places/near-point` | `x`, `y` (lon, lat), `radius` (meters, max 10000), `searchText`, `categoryIds` (comma-separated), `pageSize` (max 20), `offset` |
| `<places>/places/within-extent` | `xmin`, `ymin`, `xmax`, `ymax` (each side at most 20 km), `searchText`, `categoryIds`, `pageSize`, `offset` |
| `<places>/places/<placeId>` | `requestedFields` (`all`, or names such as `name,address,contactInfo,hours`) |
| `<places>/categories` | `filter` (text in the category label) |
| `<places>/categories/<categoryId>` | `language` |
| `<elevation>/elevation/at-point` | `lon`, `lat`, `relativeTo` (`meanSeaLevel` default, or `ellipsoid`) |
| `<elevation>/elevation/at-many-points` | `POST` a JSON body is required, which this tool does not send: use the Terrain service for many points |

Place search results: `results[]` with `placeId`, `name`, `location`,
`categories[]`, `distance` (near-point only), and `pagination.nextUrl` when
more pages exist. Each place search and each requested detail field group is
billed.
