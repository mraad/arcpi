# Publishing and sharing

Every call here creates or changes content in the user's organization. Make
each one a single step the user asked for, report its result, and never share
publicly without the user saying so. Hosted feature storage consumes credits.

`<content>` below is `/sharing/rest/content/users/<username>`, with the
username from `/sharing/rest/community/self`.

## Why there is no file upload

`arcgis_request` sends form fields, never multipart file uploads. A CSV, shapefile
or geodatabase item needs an uploaded file to publish: `addItem` with `text`
creates the item, but `analyze` and `publish` then fail ("Item does not have
a file"). Build the layer from data instead: create an empty hosted feature
service, define its layer, and add the features from the script. A local file
is read in the same script (`tools.read`), so its rows stay in the script.

## Hosted feature layer from data

1. `/sharing/rest/portals/self/isServiceNameAvailable`: `name`,
   `type: "Feature Service"` → `{ available }`. Names are unique in the
   organization; use letters, digits and `_`.
2. `<content>/createService`: `outputType: "featureService"`, `tags`, and
   `createParameters` `{ name, capabilities, spatialReference, maxRecordCount,
   hasStaticData: false, supportedQueryFormats: "JSON" }` → `{ itemId,
   serviceurl, name }`. The new item is private.
3. Define the layer at the service's admin URL: replace `/rest/services/`
   with `/rest/admin/services/` in `serviceurl`, then call `addToDefinition`
   with `{ layers: [ { name, type: "Feature Layer", geometryType,
   objectIdField, fields, extent } ] }` → `{ success, layers: [ { id } ] }`.
4. `<serviceurl>/<id>/addFeatures` with `features` (see
   `references/features.md`, "Edits"). Check every `addResults[i].success`.

```js
const rest = async (url, params, extra) => (await tools.arcgis_request({ url, params, ...extra })).data;
const { username } = await rest("/sharing/rest/community/self");
const content = `/sharing/rest/content/users/${encodeURIComponent(username)}`;
const name = "Study_sites";
if (!(await rest("/sharing/rest/portals/self/isServiceNameAvailable", { name, type: "Feature Service" })).available) {
  return { error: `A service named ${name} already exists` };
}
const created = await rest(`${content}/createService`, {
  outputType: "featureService", tags: "study",
  createParameters: { name, capabilities: "Query,Create,Update,Delete,Editing", spatialReference: { wkid: 4326 }, maxRecordCount: 2000,
    hasStaticData: false, supportedQueryFormats: "JSON" },
});
const admin = created.serviceurl.replace("/rest/services/", "/rest/admin/services/");
await rest(`${admin}/addToDefinition`, { addToDefinition: { layers: [{
  name: "Sites", type: "Feature Layer", geometryType: "esriGeometryPoint", objectIdField: "OBJECTID",
  extent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: { wkid: 4326 } },
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" },
    { name: "Name", type: "esriFieldTypeString", alias: "Name", length: 100 },
  ],
}] } });
// Rows from a local CSV with Name,Latitude,Longitude columns and no quoted commas.
const [header, ...lines] = (await tools.read({ path: "data/sites.csv" })).trim().split("\n");
const column = Object.fromEntries(header.split(",").map((title, i) => [title.trim(), i]));
const features = lines.map((line) => line.split(",")).map((cells) => ({
  geometry: { x: Number(cells[column.Longitude]), y: Number(cells[column.Latitude]), spatialReference: { wkid: 4326 } },
  attributes: { Name: cells[column.Name] },
}));
const { addResults } = await rest(`${created.serviceurl}/0/addFeatures`, { features });
return { itemId: created.itemId, layer: `${created.serviceurl}/0`, added: addResults.filter((r) => r.success).length, failed: addResults.filter((r) => !r.success) };
```

These capabilities let everyone the layer is shared with edit it. Keep the
item private, or ask the user before sharing an editable layer.

## Share: `<content>/shareItems`

| Parameter | Meaning |
|---|---|
| `items` | Comma-separated item IDs. |
| `everyone` | `true` shares publicly. Only when the user asked for public. |
| `org` | `true` shares with the whole organization. |
| `groups` | Comma-separated group IDs (from `/sharing/rest/community/self`, `groups[]`). |

Response: `results[]` with `itemId`, `success`, `notSharedWith` (groups that
refused). Read the item afterwards: its `access` is `private`, `shared`, `org`
or `public`. `<content>/unshareItems` takes `items` and `groups` to remove group
sharing.

## Update and delete

- `<content>/items/<itemId>/update`: `title`, `tags`, `snippet`,
  `description`, `accessInformation`, `licenseInfo`, `typeKeywords`, and
  `text` for JSON items such as web maps. Only the parameters given change.
  → `{ success, id }`.
- `<content>/items/<itemId>/delete` → `{ success, itemId }`. Deleting a hosted
  feature service item deletes the service and its data: confirm first, and
  never delete an item the user did not name.

After any write, read the item (`/sharing/rest/content/items/<itemId>`) and
report what is actually there, not what the call was meant to do.
