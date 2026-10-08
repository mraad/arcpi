# Portal: users, search, items, groups

All paths are relative to the configured portal, so pass them as
`rest("/sharing/rest/...")`. These calls cost no credits.

## Who am I: `/sharing/rest/community/self`

No parameters. Returns the signed-in user: `username`, `fullName`, `email`,
`role`, `orgId`, `privileges[]`, `groups[]` (each with `id`, `title`,
`owner`, `access`), `availableCredits`. Check `privileges` before promising a
premium operation (`premium:user:geocode`, `premium:user:networkanalysis:routing`,
`premium:user:geoenrichment`).

Another user: `/sharing/rest/community/users/<username>`.

## Search items: `/sharing/rest/search`

| Parameter | Meaning |
|---|---|
| `q` | Required. Lucene-style query. Bare words match title, tags, snippet, description. Field filters: `title:`, `owner:`, `tags:`, `type:"Feature Service"`, `orgid:<id>`, `access:public\|org\|shared\|private`, `group:<groupId>`, `id:<itemId>`. Combine with `AND`, `OR`, `NOT`, parentheses. Quote values with spaces. |
| `num` | Page size, default 10, max 100. |
| `start` | 1-based index of the first result, default 1. |
| `sortField` | `title`, `created`, `modified`, `type`, `owner`, `avgRating`, `numViews`. Omit for relevance. |
| `sortOrder` | `asc` or `desc`. |
| `bbox` | `xmin,ymin,xmax,ymax` in WGS84 to keep items whose extent intersects it. |
| `categories` | Organization content categories, e.g. `/Categories/Water`. |

Response: `{ total, start, num, nextStart, results[] }`. Page with
`start = nextStart` until `nextStart` is `-1`. `total` stops at 10000: that
value means "at least", so narrow the query instead of reporting it as a count. Each result has `id`, `title`,
`type`, `typeKeywords`, `owner`, `access`, `url` (for services), `snippet`,
`tags`, `extent`, `created`, `modified` (epoch milliseconds), `numViews`.

On ArcGIS Online a search without `orgid:` also returns public items from
every organization. To stay inside the user's organization add
`orgid:<orgId>` (from `community/self` or `portals/self`.`id`):

```js
const me = await rest("/sharing/rest/community/self");
const found = await rest("/sharing/rest/search", {
  q: `title:hydrants type:"Feature Service" orgid:${me.orgId}`, num: 20, sortField: "modified", sortOrder: "desc",
});
```

Common `type` values: `Feature Service`, `Map Service`, `Image Service`,
`Vector Tile Service`, `Scene Service`, `Web Map`, `Web Scene`, `Dashboard`,
`Web Mapping Application`, `Web Experience`, `StoryMap`, `Geoprocessing Service`,
`CSV`, `Shapefile`, `File Geodatabase`, `GeoJson`.

A layer inside a service is not an item: search for the service, then read
its layers (`references/features.md`).

## Item: `/sharing/rest/content/items/<itemId>`

Returns the item's metadata: `title`, `type`, `owner`, `access`, `url`,
`description`, `snippet`, `tags`, `extent`, `spatialReference`, `size`,
`created`, `modified`. For a service item, `url` is the service URL to query.

`/sharing/rest/content/items/<itemId>/data` returns the item's content:
the JSON definition of a Web Map (`operationalLayers[]`, `baseMap`), a
Dashboard, a hosted layer's popup/renderer overrides (`layers[]`), or the file
itself for file items (use `save_to` for those). An item with no data returns
an empty body.

An ID that does not exist and one this user may not see answer with the same
error ("Item does not exist or is inaccessible"), so report both
possibilities.

## A user's content: `/sharing/rest/content/users/<username>`

Lists the items in the user's root folder with `num`, `start` paging:
`{ total, nextStart, items[], folders[] }`. Folder contents:
`/sharing/rest/content/users/<username>/<folderId>`.

## Groups: `/sharing/rest/community/groups`

`q` (required unless `searchUserAccess` is set), `num`, `start`, `sortField`,
`sortOrder`. The signed-in user's own groups are already in
`community/self`.`groups`; to list them with paging pass
`searchUserAccess: "groupMember"`. Response has the same paging fields as
search. Items shared with a group: search with `q: "group:<groupId>"`, or
`/sharing/rest/content/groups/<groupId>`.

## Portal and organization: `/sharing/rest/portals/self`

`id` (organization ID), `name`, `urlKey`, `isPortal` (`true` on ArcGIS
Enterprise, `false` on ArcGIS Online), `helperServices` (see `SKILL.md`),
`defaultBasemap`, `units`, `region`. On Enterprise, federated servers are at
`/sharing/rest/portals/<id>/servers`.

## Find a service and inspect it

```js
const rest = async (url, params, extra) => (await tools.arcgis_request({ url, params, ...extra })).data;
const { results } = await rest("/sharing/rest/search", { q: 'title:"Urgent Care" type:"Feature Service"', num: 5 });
if (results.length === 0) return "No matching feature service";
const service = await rest(results[0].url);
return {
  item: results[0].id, url: results[0].url,
  layers: service.layers.map((layer) => ({ id: layer.id, name: layer.name, geometryType: layer.geometryType })),
  tables: service.tables.map((table) => ({ id: table.id, name: table.name })),
};
```
