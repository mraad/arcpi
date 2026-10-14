# Image services (rasters)

An image service (`.../ImageServer`) serves raster data: elevation, land
cover, imagery bands. These operations read pixels and never change the
service. For elevation at points, `references/places-elevation.md` has the
Terrain service.

## Describe: `<image>`

`bandCount`, `pixelType` (`U8`, `F32`, ...), `extent` and its
`spatialReference`, `pixelSizeX`/`pixelSizeY`, `capabilities`, and
`hasRasterAttributeTable`. For a classified raster (land cover, soils) the
pixel value is a class code. `<image>/rasterAttributeTable` maps codes to names:
`features[].attributes` with `Value` and a name field (`ClassName` in NLCD;
read `fields[]` for the name in another service).

## Pixel value at a point: `<image>/identify`

| Parameter | Meaning |
|---|---|
| `geometry` | `{ x, y, spatialReference: { wkid: 4326 } }`: the spatial reference goes inside the geometry. There is no `inSR`. |
| `geometryType` | `esriGeometryPoint` (or `esriGeometryPolygon` for an area, by reference). |
| `returnCatalogItems` | `false` unless you need the source rasters; it makes the answer much smaller. |
| `mosaicRule`, `renderingRule`, `pixelSize`, `time` | Choose which rasters and how they are processed; omit for the service default. |

Response: `value` (a **string**, `"NoData"` outside the data; several bands
are space-separated), `location` in the service's spatial reference, `name`.

```js
const rest = async (url, params, extra) => (await tools.arcgis_request({ url, params, ...extra })).data;
const image = "https://sampleserver6.arcgisonline.com/arcgis/rest/services/NLCDLandCover2001/ImageServer";
const points = [[-117.1956, 34.0572], [-122.4194, 37.7749]];
const table = await rest(`${image}/rasterAttributeTable`);
const names = new Map(table.features.map(({ attributes }) => [String(attributes.Value), attributes.ClassName]));
const hits = await Promise.all(points.map(([x, y]) => rest(`${image}/identify`, {
  geometry: { x, y, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryPoint", returnCatalogItems: false,
})));
return hits.map((hit, i) => ({ lonLat: points[i], code: hit.value, name: names.get(hit.value) ?? hit.value }));
```

Many points along a line or across an area: `<image>/getSamples` with a
multipoint, or a line by reference and `sampleCount` (parameters as in
`references/places-elevation.md`).

## Statistics over an area: `<image>/computeStatisticsHistograms`

| Parameter | Meaning |
|---|---|
| `geometry` | An envelope `{ xmin, ymin, xmax, ymax, spatialReference }`, or a polygon by reference. |
| `geometryType` | `esriGeometryEnvelope` or `esriGeometryPolygon`. |
| `pixelSize`, `mosaicRule`, `renderingRule` | As for identify. |

Response: `statistics[]` and `histograms[]`, one per band.
`statistics[b]`: `min`, `max`, `mean`, `standardDeviation`, `median`, `count`.
`histograms[b]`: `size` bins from `min` to `max`, with `counts[]`. For an
integer raster whose histogram starts at `-0.5` with one bin per value,
`counts[v]` is the number of pixels with value `v`, which gives the share of
each class:

```js
const area = { xmin: -117.25, ymin: 34.0, xmax: -117.15, ymax: 34.1, spatialReference: { wkid: 4326 } };
const { histograms: [histogram] } = await rest(`${image}/computeStatisticsHistograms`, { geometry: area, geometryType: "esriGeometryEnvelope" });
const total = histogram.counts.reduce((sum, n) => sum + n, 0);
const width = (histogram.max - histogram.min) / histogram.size;
return histogram.counts.map((n, i) => ({ value: Math.round(histogram.min + width * (i + 0.5)), share: n / total }))
  .filter((bin) => bin.share > 0).sort((a, b) => b.share - a.share).slice(0, 5);
```

## A picture of an area: `<image>/exportImage`

`bbox` (`"xmin,ymin,xmax,ymax"`), `bboxSR` (`4326`), `size` (`"width,height"`
in pixels), `format` (`png`, `jpgpng`, `tiff`, ...), `renderingRule` for a
service-advertised function (listed in the service's
`rasterFunctionInfos`). With `f: "image"` the answer is the image itself:
give `save_to` to keep it. With `f: "json"` the answer is `{ href, width,
height, extent }`, a temporary URL on the server.

```js
const { saved } = await tools.arcgis_request({
  url: `${image}/exportImage`,
  params: { bbox: "-117.25,34.0,-117.15,34.1", bboxSR: 4326, size: "512,512", format: "png", f: "image" },
  save_to: "artifacts/landcover.png",
});
return saved;
```

A raster function changes only the response; the source raster is untouched.
Use only the functions the service lists; do not invent function names.
