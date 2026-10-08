# Errors

`tools.arcgis_request` rejects (throws) when the service answers with an
ArcGIS error object or a failing HTTP status. The message reads:

```text
ArcGIS error <code> from <host><path>: <message> (<details>)
```

ArcGIS returns most errors with HTTP 200, so the code in the message is the
ArcGIS code. Catch per call when one failure should not end the script:

```js
const settled = await Promise.allSettled(urls.map((url) => rest(url)));
```

## Sign-in and permissions

| Message | Meaning | What to do |
|---|---|---|
| ends with "Not signed in: ask the user to run ./arcpi login (or /arcgis-login)" | No usable session: never signed in, or the refresh token expired or was revoked | Ask the user to sign in. Do not retry in a loop |
| 498 "Invalid token" | The portal refused the token. The tool already refreshed and retried once | If it persists, ask the user to sign in again |
| 499 "Token required" with a `note`/text "The token was not sent: <host> is not a trusted host" | The URL's host is not one of the portal's hosts, so the token was withheld | Check the URL is right. If the host really belongs to the portal, the user can add it to `ARCGIS_TRUSTED_TOKEN_HOSTS` and restart |
| a result `note` "The token was not sent: <host> refuses this portal's tokens" | A public utility service (the geometry service) rejected the token and was called anonymously instead | Nothing: the result is valid |
| 403 "You do not have permissions to access this resource or perform this operation" | Signed in, but the item, layer or operation is not shared with this user, or the role lacks the privilege | Report it. Signing in again does not help |
| 403 "Permission missing" mentioning ArcGIS Location Platform | The service only accepts Location Platform accounts (Places, elevation API) | See `places-elevation.md`. Do not substitute another data source silently |
| "Item does not exist or is inaccessible" | Wrong ID, or an item this user cannot see | Say both are possible |

A permission error is not "no results". Never answer as if the data were
empty, and never switch to OpenStreetMap or another provider without telling
the user.

`tools.arcgis_status()` shows `signed_in`, `refreshable`, expiry times and the
last `refresh_error`.

## Request problems

| Message | Usual cause | Fix |
|---|---|---|
| "Geometry reference ... is gone" | The file expired (one day by default) or was deleted | Repeat the request that produced the shape |
| "Geometry reference ... is not under artifacts/" / "is not a geometry file" | The reference was altered or points at another file | Use the reference exactly as a result gave it |
| "Only shapes of one kind and one spatial reference can be merged" | Polygons mixed with lines, or shapes fetched with different `outSR` | Merge like with like; fetch with the same `outSR` |
| "The response holds true curves" | `returnTrueCurves: true` | Remove it |
| 400 "Cannot perform query. Invalid query parameters." | Bad `where` (unknown field, unquoted string, wrong date syntax), unknown `outFields`, or malformed `geometry` | Read the layer's `fields`; quote strings with single quotes; set `geometryType` and `inSR` with `geometry` |
| 400 "Unable to complete operation." | The service could not parse an input (routing locations, travel mode, batch addresses) | See the reference for that endpoint |
| 400 "Invalid URL" / 404 | Wrong path or layer ID; an operation on the wrong service | Read the parent URL first: a service lists its layers and operations |
| 400 "Invalid or missing input parameters." | A required parameter is missing or misnamed (names are case-sensitive) | Compare with the reference |
| "The response ... is application/pdf ...: pass save_to" | Binary response | Add `save_to: "artifacts/<name>"` |
| "Do not pass a token" / "Token endpoints are not callable" | A `token` parameter or an OAuth endpoint | Remove it; authentication is automatic |
| HTTP 429 or 503 | Rate limit or busy service | Wait and retry once; reduce parallel calls |
| "The operation was aborted due to timeout" | No answer within 120 seconds | Narrow the request (fewer fields, a spatial or attribute filter, smaller pages) |

Most services ignore parameters they do not know. A misspelt name
(`outfields`, `returnGeometery`) therefore gives a default-looking result, not
an error. When a filter seems to have no effect, check the spelling first.

## Empty results

`features: []`, `candidates: []` or `total: 0` with no error is a real answer:
nothing matched. Check the filter once (case of string values, the layer's
spatial extent, `orgid:` in searches), then report that nothing was found. Do
not repeat the same request expecting a different result.

## Large results

Script output is capped. Return counts and a few attributes, and set
`returnGeometry: false` unless shapes are needed: they never enter the script
anyway, but the server still has to send them. A script's memory limit is
256 MB: page and reduce instead of collecting every row.
