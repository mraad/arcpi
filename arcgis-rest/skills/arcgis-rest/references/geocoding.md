# Geocoding

`<geocoder>` is a GeocodeServer URL: `helpers.geocode` from the portal's
`helperServices.geocode[0].url` (see `SKILL.md`). `helperServices.geocode` is
a list: each entry has `url`, `name`, and flags `suggest`, `placefinding`,
`batch`; an organization can put its own locator first.

Coordinates are `x` = longitude, `y` = latitude. Ask for `outSR: 4326` when
the result feeds another call.

## One address: `<geocoder>/findAddressCandidates`

| Parameter | Meaning |
|---|---|
| `SingleLine` | The whole address or place name as one string. |
| `Address`, `City`, `Region`, `Postal`, `CountryCode` | Use these instead of `SingleLine` when the parts are already separate: higher match scores. |
| `magicKey` | From a `suggest` result, together with `SingleLine` set to the suggestion text: resolves to exactly that place. |
| `maxLocations` | Number of candidates, default varies, max 50. |
| `outFields` | `*` or names such as `Addr_type,City,Region,Postal,Country`. Default returns none. |
| `outSR` | WKID of the returned locations. |
| `location` | `"lon,lat"` to prefer nearby candidates. |
| `category` | Limit to place types, e.g. `Address`, `Postal`, `City`, `Coffee Shop`. |
| `sourceCountry` | Limit to countries, ISO codes, comma-separated. |
| `forStorage` | `true` only when the result will be stored; it is then billed. Leave unset otherwise. |

Response: `{ spatialReference, candidates[] }`, each candidate
`{ address, location: { x, y }, score, attributes, extent }`, best first.
An empty `candidates` means no match: say so, do not guess coordinates.
Treat `score < 80` as needing review. Keep the state, country or postal code
the user gave in the query: a bare town name resolves to the largest one.

```js
const { candidates } = await rest(`${helpers.geocode}/findAddressCandidates`, {
  SingleLine: "380 New York St, Redlands, CA", maxLocations: 1, outSR: 4326, outFields: "Addr_type",
});
const { x, y } = candidates[0].location;
```

## Many addresses: `<geocoder>/geocodeAddresses`

Batch geocoding is always billed (credits per address). Confirm the number of
addresses with the user first. Send one request per batch, never one
`findAddressCandidates` per row.

| Parameter | Meaning |
|---|---|
| `addresses` | `{ records: [ { attributes: { OBJECTID, ...address fields } } ] }`. `OBJECTID` is your own row number and comes back as `ResultID`. Address fields: `SingleLine`, or `Address`, `City`, `Region`, `Postal`, `CountryCode`. |
| `outSR` | WKID of the returned locations. |
| `sourceCountry`, `category` | As above. |

Batch size limit: the geocoder's `locatorProperties.MaxBatchSize` (read
`<geocoder>`); stay at or below 100 records per request unless you checked it.

```js
const rows = ["380 New York St, Redlands, CA", "1600 Pennsylvania Ave NW, Washington, DC"];
const { locations } = await rest(`${helpers.geocode}/geocodeAddresses`, {
  addresses: { records: rows.map((SingleLine, i) => ({ attributes: { OBJECTID: i + 1, SingleLine } })) },
  outSR: 4326,
});
// Results are not guaranteed to be in input order: join on ResultID.
const byRow = Object.fromEntries(locations.map((l) => [l.attributes.ResultID, l]));
```

Each location: `{ address, location: { x, y }, score, attributes }` with
`attributes.ResultID`, `Status` (`M` matched, `T` tied, `U` unmatched),
`Score`, `Match_addr`, `Addr_type`. Report unmatched and low-score rows; do
not drop them silently.

## Coordinates to address: `<geocoder>/reverseGeocode`

| Parameter | Meaning |
|---|---|
| `location` | `"lon,lat"`, or `{ x, y, spatialReference: { wkid } }`. |
| `featureTypes` | Limit the match type: `StreetAddress`, `PointAddress`, `StreetInt`, `POI`, `Postal`, `Locality`; comma-separated. |
| `outSR` | WKID of the returned location. |
| `langCode` | Language of the result, e.g. `fr`. |

Response: `{ address: { Match_addr, LongLabel, Address, City, Region, Postal, CountryCode, Addr_type, Type, ... }, location }`.
Far from any address the match is a broad feature, not a street address (in
mid-ocean: `Addr_type: "POI"`, `Type: "Oceanic Basin"`). Check `Addr_type`
before presenting the result as an address.

## Autocomplete: `<geocoder>/suggest`

| Parameter | Meaning |
|---|---|
| `text` | Partial address or place text. |
| `maxSuggestions` | 1 to 15, default 5. |
| `location` | `"lon,lat"` to rank nearby suggestions first. |
| `countryCode` | ISO 3166-1 alpha-3 (`USA`, `GBR`) to stay in one country. |
| `category` | Limit to place types. |

Response: `{ suggestions: [ { text, magicKey, isCollection } ] }`. Geocode the
chosen one with `findAddressCandidates` and both `SingleLine: text` and
`magicKey`. `isCollection: true` is a category ("Coffee Shops"), not a place.
