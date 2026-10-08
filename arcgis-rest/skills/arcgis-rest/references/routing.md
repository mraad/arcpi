# Routing and network analysis

Every solve call here consumes credits. One request per question; confirm
with the user before solving many routes or large matrices.

Service URLs come from the portal's `helperServices` (see `SKILL.md`):
`route`, `serviceArea`, `closestFacility`, `odCostMatrix`, `snapToRoads`. Each
is a different URL; an operation exists only on its own service.

## Locations

Stops, facilities, incidents, origins and destinations accept either form:

- a string of `lon,lat` pairs separated by semicolons: `"-116.2007,43.6078;-116.2819,43.6176"`
- a feature set, when names or per-stop attributes matter:
  `{ features: [ { geometry: { x, y }, attributes: { Name: "Depot" } } ] }`
  (add `spatialReference: { wkid }` inside each geometry when not WGS84)

Order matters for stops. A bare array of `{ x, y }` objects is not a valid
form and fails with "Unable to complete operation".

Results follow `SKILL.md`, "Geometry travels by reference": route lines and
area polygons come back as references, and the file in `geometry_files` holds
them with their attributes (travel time, breaks), ready for the map. Stops and
facilities are points and stay inline. Ask for `outSR: 4326`.

## Travel modes: omit unless asked

Leave `travelMode` out for ordinary driving requests: the service applies its
default (Driving Time). Passing a name does **not** work: `"Walking Time"` or
`{ name: "Walking Time" }` is rejected, or silently returns something that is
not a route. For a non-default mode pass the **whole** mode object:

```js
const { supportedTravelModes } = await rest(`${helpers.route}/retrieveTravelModes`);
const walking = supportedTravelModes.find((mode) => mode.name === "Walking Time");
// then: travelMode: walking
```

`retrieveTravelModes` is free and returns `supportedTravelModes[]` (each with
`name`, `type`, `impedanceAttributeName`, `timeAttributeName`,
`distanceAttributeName`, restrictions) and `defaultTravelMode` (an ID). Usual
names: Driving Time, Driving Distance, Trucking Time, Trucking Distance,
Walking Time, Walking Distance, Rural Driving Time, Rural Driving Distance.
There is no public-transit mode.

## Route and directions: `<route>/solve`

| Parameter | Meaning |
|---|---|
| `stops` | 2 or more locations, in visiting order. |
| `returnDirections` | `true` for turn-by-turn text. Default `false`. |
| `returnRoutes` | Route geometry and totals. Default `true`. |
| `findBestSequence` | `true` reorders the stops for the shortest trip; with `preserveFirstStop` / `preserveLastStop` to pin the ends. |
| `startTime` | Epoch milliseconds, or `"now"`, for traffic-aware travel time. |
| `directionsLanguage` | e.g. `en`, `fr`, `es`. |
| `directionsLengthUnits` | `esriNAUMiles`, `esriNAUKilometers`, `esriNAUMeters`. |
| `outSR` | WKID of returned geometry, e.g. `4326`. |
| `travelMode` | See above. |

Response: `routes.features[0]` with `attributes.Total_TravelTime` (minutes),
`Total_Miles`, `Total_Kilometers` and `geometry` (a reference to the route line);
`directions[0].features[]` with `attributes.text`, `length`, `time`;
`messages[]`. With `findBestSequence`, the visiting order is in
`stops.features[].attributes.Sequence` when `returnStops: true`.

```js
const route = await rest(`${helpers.route}/solve`, {
  stops: "-116.2007,43.6078;-116.2819,43.6176", returnDirections: true, outSR: 4326,
});
const summary = route.routes?.features?.[0]?.attributes;
if (!summary) return { error: "The service returned no route", messages: route.messages };
return {
  minutes: summary.Total_TravelTime, miles: summary.Total_Miles,
  steps: route.directions?.[0]?.features.map((step) => step.attributes.text),
};
```

## Drive-time areas: `<serviceArea>/solveServiceArea`

| Parameter | Meaning |
|---|---|
| `facilities` | 1 or more locations: several in one call, not one call each. |
| `defaultBreaks` | Comma-separated cutoffs, e.g. `"5,10,15"`: minutes for a time mode, miles or kilometers for a distance mode. |
| `travelDirection` | `esriNATravelDirectionFromFacility` (default) or `esriNATravelDirectionToFacility`. |
| `splitPolygonsAtBreaks` | `true` makes rings (0-5, 5-10); `false` makes overlapping disks. |
| `mergeSimilarPolygonRanges` | `true` merges areas of several facilities with the same break. |
| `outSR`, `travelMode`, `timeOfDay` | As for routes. |

Response: `saPolygons.features[]`, each with `attributes.FromBreak`,
`ToBreak`, `FacilityID`, `Name` and `geometry` (a reference to the polygon). If the response has no
`saPolygons` (for example it carries `attributeParameterValues` at the top
level), a malformed `travelMode` made the service return a mode definition:
remove it. A straight-line buffer is not a service area. `FacilityID` is the
1-based position of the facility in your input. All polygons of a call share
one file in `geometry_files` (feature `n` is `<file>#<n>`). For their area, or
the overlap of two of them (`intersect`), see `geometry.md`.

## Closest facility: `<closestFacility>/solveClosestFacility`

| Parameter | Meaning |
|---|---|
| `incidents` | The locations to serve. |
| `facilities` | The candidate facilities. |
| `defaultTargetFacilityCount` | Facilities to find per incident, default 1. |
| `travelDirection` | `esriNATravelDirectionToFacility` (default) or `...FromFacility`. |
| `defaultCutoff` | Ignore facilities beyond this travel cost. |
| `returnDirections`, `returnCFRoutes`, `outSR`, `travelMode` | As for routes. |

Response: `routes.features[]` ranked per incident, with
`attributes.FacilityID`, `IncidentID`, `FacilityRank`, `Total_TravelTime`,
`Total_Miles`, and `geometry` (a reference to the route line).

## Origin-destination cost matrix: `<odCostMatrix>/solveODCostMatrix`

| Parameter | Meaning |
|---|---|
| `origins`, `destinations` | Locations. Billed per origin-destination pair. |
| `defaultTargetDestinationCount` | Keep only the N nearest destinations per origin. |
| `defaultCutoff` | Drop pairs beyond this travel cost. |
| `outputType` | `esriNAODOutputSparseMatrix` (default, compact), `esriNAODOutputNoLines` or `esriNAODOutputStraightLines` (features). |
| `travelMode` | See above. |

Response for the sparse matrix: `odCostMatrix` with `costAttributeNames`
(e.g. `["TravelTime","Miles","Kilometers"]`) and one entry per origin ID
mapping destination IDs to cost arrays in that order. With a lines output
type: `odLines.features[]` with `OriginID`, `DestinationID`,
`DestinationRank`, `Total_TravelTime`, `Total_Miles`. IDs are 1-based
positions in your input unless you supplied `ObjectID` attributes.

## Snap GPS points to roads: `<snapToRoads>/SnapToRoads/execute`

A synchronous geoprocessing task, so the shape differs from the solve calls.

| Parameter | Meaning |
|---|---|
| `points` | Feature set of at least two points in travel order: `{ features: [ { geometry: { x, y } } ], spatialReference: { wkid: 4326 } }`. |
| `return_lines` | `true` to also get the traversed road lines. |
| `travel_mode` | Full mode object, as above; omit for driving. |

Response: `results[]`, one per output parameter (`paramName`, `value`), with
the snapped points and, when requested, lines as feature sets.

## When a solve fails

| Symptom | Cause | Fix |
|---|---|---|
| Error 400 "Unable to complete operation" | Malformed locations, or a `travelMode` that is a name instead of the full object | Use the `lon,lat;lon,lat` form; drop `travelMode` or pass the object |
| No `routes` / `saPolygons`, a travel-mode-like body instead | `travelMode` given as a bare label | Same |
| Error 400 "Invalid or missing input parameters" | Operation called on the wrong service URL (e.g. `solveServiceArea` on the route service) | Use the matching helper service |
| `messages` mention unlocated stops, empty `routes` | A location is too far from any road | Report which stop failed; do not move it |
| Error 403 "do not have permissions" | The account lacks the network analysis privilege | Tell the user; see `errors.md` |
| Limits exceeded (too many stops, facilities, pairs) | Service limits | Split the request only after telling the user the cost |

Always check the expected field (`routes.features[0].geometry`,
`saPolygons.features[0].geometry`, and that `geometry_files` is set) before
using a result. Never draw a straight line in place of a missing route.
