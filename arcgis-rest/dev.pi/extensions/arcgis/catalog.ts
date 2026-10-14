// The request contract: documented parameter names per REST operation, so a misspelt or
// invented name fails loudly instead of being ignored by ArcGIS (which answers as if it were
// absent). Lists come from Esri's REST documentation; names are compared case-insensitively,
// as ArcGIS does. A URL that matches no entry is not checked.

export interface Operation {
  name: string;
  docs: string;
  params: string[];
}

const ENTERPRISE = "https://developers.arcgis.com/rest/services-reference/enterprise";
const op = (name: string, docs: string, params: string[]): Operation => ({ name, docs, params });

const geometryOps: Record<string, [string, string[]]> = {
  project: ["project", ["geometries", "inSR", "outSR", "transformation", "transformForward", "vertical"]],
  buffer: ["buffer", ["geometries", "inSR", "outSR", "bufferSR", "distances", "unit", "unionResults", "geodesic"]],
  simplify: ["simplify", ["geometries", "sr"]],
  intersect: ["intersect", ["geometries", "geometry", "sr"]],
  union: ["union", ["geometries", "sr"]],
  difference: ["difference", ["geometries", "geometry", "sr"]],
  areasAndLengths: ["areas-and-lengths", ["polygons", "sr", "lengthUnit", "areaUnit", "calculationType"]],
  lengths: ["lengths", ["polylines", "sr", "lengthUnit", "geodesic", "calculationType"]],
  relation: ["relation", ["geometries1", "geometries2", "sr", "relation", "relationParam"]],
  distance: ["distance", ["geometry1", "geometry2", "sr", "distanceUnit", "geodesic"]],
  convexHull: ["convex-hull", ["geometries", "sr"]],
  labelPoints: ["label-points", ["polygons", "sr"]],
  generalize: ["generalize", ["geometries", "sr", "maxDeviation", "deviationUnit"]],
};

const imageOps: Record<string, [string, string[]]> = {
  identify: ["identify-image-service", ["geometry", "geometryType", "mosaicRule", "renderingRule", "renderingRules", "pixelSize", "time",
    "returnGeometry", "returnCatalogItems", "returnPixelValues", "maxItemCount", "sliceId", "processAsMultidimensional"]],
  getSamples: ["get-samples", ["geometry", "geometryType", "sampleDistance", "sampleCount", "mosaicRule", "pixelSize",
    "returnFirstValueOnly", "interpolation", "outFields", "sliceId", "time"]],
  computeStatisticsHistograms: ["compute-statistics-and-histograms", ["geometry", "geometryType", "mosaicRule", "renderingRule",
    "pixelSize", "time", "processAsMultidimensional"]],
  exportImage: ["export-image", ["bbox", "size", "adjustAspectRatio", "imageSR", "datumTransformation", "bboxSR", "time", "format",
    "lercVersion", "pixelType", "noData", "noDataInterpretation", "interpolation", "compression", "compressionQuality",
    "compressionTolerance", "bandIds", "mosaicRule", "renderingRule", "sliceId", "validateExtent"]],
  rasterAttributeTable: ["raster-attribute-table", ["renderingRule"]],
};

/** Operations matched by the end of the URL path, case-insensitively. */
const OPERATIONS: [RegExp, Operation][] = [
  // Feature service and map service layers. `having`, `returnQueryGeometry` and `featureEncoding`
  // are not on the Enterprise page but are honored by ArcGIS Online hosted layers (checked live
  // 2026-10-14); hosted layers ignore the documented `havingClause` and read `having`.
  [/\/(FeatureServer|MapServer)\/\d+\/query$/i, op("layer query", `${ENTERPRISE}/query-feature-service-layer/`, [
    "where", "objectIds", "geometry", "geometryType", "inSR", "spatialRel", "relationParam", "time", "distance", "units",
    "outFields", "returnGeometry", "maxAllowableOffset", "geometryPrecision", "defaultSR", "outSR", "havingClause", "having",
    "gdbVersion", "returnDistinctValues", "returnIdsOnly", "returnCountOnly", "returnExtentOnly", "orderByFields",
    "groupByFieldsForStatistics", "outStatistics", "returnZ", "returnM", "multipatchOption", "resultOffset",
    "resultRecordCount", "quantizationParameters", "returnCentroid", "resultType", "historicMoment", "returnTrueCurves",
    "sqlFormat", "returnExceededLimitFeatures", "datumTransformation", "timeReferenceUnknownClient", "returnEnvelope",
    "fullText", "uniqueIds", "returnUniqueIdsOnly", "resultPaginationToken", "returnQueryGeometry", "featureEncoding",
    // Map service layers only.
    "text", "rangeValues", "parameterValues", "lodType", "lod", "lodSR", "cacheHint",
  ])],
  // The World Geocoding Service pages and the Enterprise pages each list names the other omits.
  [/\/GeocodeServer\/findAddressCandidates$/i, op("findAddressCandidates", "https://developers.arcgis.com/rest/geocode/find-address-candidates/", [
    "SingleLine", "address", "address2", "address3", "neighborhood", "city", "subregion", "region", "postal", "postalExt",
    "countryCode", "magicKey", "searchExtent", "location", "category", "outSR", "outFields", "maxLocations", "forStorage",
    "matchOutOfRange", "locationType", "langCode", "sourceCountry", "preferredLabelValues", "searchWithin", "start", "num",
    "matchID", "returnMatchNarrative", "comprehensiveZoneMatch", "returnPrimaryMatchID", "excludeIntersectionType",
    "interpolatePointAddress", "matchIDFormat",
  ])],
  [/\/GeocodeServer\/geocodeAddresses$/i, op("geocodeAddresses", "https://developers.arcgis.com/rest/geocode/geocode-addresses/", [
    "addresses", "category", "sourceCountry", "outSR", "matchOutOfRange", "locationType", "searchExtent", "langCode",
    "preferredLabelValues", "outFields", "comprehensiveZoneMatch", "returnMatchNarrative", "excludeIntersectionType",
    "interpolatePointAddress", "matchIDFormat",
  ])],
  [/\/GeocodeServer\/reverseGeocode$/i, op("reverseGeocode", "https://developers.arcgis.com/rest/geocode/reverse-geocode/", [
    "location", "outSR", "forStorage", "featureTypes", "locationType", "preferredLabelValues", "outFields",
    "returnInputLocation", "langCode",
  ])],
  [/\/GeocodeServer\/suggest$/i, op("suggest", "https://developers.arcgis.com/rest/geocode/suggest/", [
    "text", "location", "category", "searchExtent", "maxSuggestions", "countryCode", "sourceCountry", "preferredLabelValues",
    "returnCollections", "partialHouseNumber", "partialSubaddress", "subaddressSummary", "subaddressAfterBaseAddress",
    "excludeIntersectionType",
  ])],
  [/\/NAServer\/[^/]+\/solve$/i, op("route solve", "https://developers.arcgis.com/rest/routing/route-service-direct/", [
    "stops", "travelMode", "startTime", "startTimeIsUTC", "timeWindowsAreUTC", "findBestSequence", "preserveFirstStop",
    "preserveLastStop", "useTimeWindows", "restrictUTurns", "useHierarchy", "impedanceAttributeName",
    "accumulateAttributeNames", "restrictionAttributeNames", "attributeParameterValues", "barriers", "polylineBarriers",
    "polygonBarriers", "returnDirections", "directionsLanguage", "directionsOutputType", "directionsStyleName",
    "directionsLengthUnits", "returnRoutes", "directionsTimeAttributeName", "outputLines", "returnStops", "returnBarriers",
    "returnPolylineBarriers", "returnPolygonBarriers", "returnTraversedEdges", "returnTraversedJunctions",
    "returnTraversedTurns", "ignoreInvalidLocations", "outSR", "outputGeometryPrecision", "outputGeometryPrecisionUnits",
    "geometryPrecision", "geometryPrecisionM", "overrides", "preserveObjectID", "returnEmptyResults", "locateSettings",
  ])],
  ...Object.entries(geometryOps).map(([name, [page, params]]): [RegExp, Operation] =>
    [new RegExp(`/GeometryServer/${name}$`, "i"), op(`geometry ${name}`, `${ENTERPRISE}/${page}/`, params)]),
  ...Object.entries(imageOps).map(([name, [page, params]]): [RegExp, Operation] =>
    [new RegExp(`/ImageServer/${name}$`, "i"), op(`image ${name}`, `${ENTERPRISE}/${page}/`, params)]),
  [/\/sharing\/rest\/search$/i, op("portal search", "https://developers.arcgis.com/rest/users-groups-and-items/search/", [
    "q", "bbox", "filter", "categories", "categoryFilters", "start", "num", "sortField", "sortOrder", "countFields",
    "countSize", "exclude", "displaySublayers", "enriched", "displayServiceProperties",
  ])],
  // Content writes (references/publishing.md). addFeatures is left unchecked: ArcGIS Online
  // accepts names its Enterprise page does not list, and refusing a valid edit is worse.
  [/\/sharing\/rest\/portals\/[^/]+\/isServiceNameAvailable$/i, op("isServiceNameAvailable", "https://developers.arcgis.com/rest/users-groups-and-items/check-service-name/", ["name", "type"])],
  [/\/sharing\/rest\/content\/users\/[^/]+\/createService$/i, op("createService", "https://developers.arcgis.com/rest/users-groups-and-items/create-service/", [
    "createParameters", "outputType", "description", "tags", "snippet", "overwrite", "isView",
  ])],
  [/\/rest\/admin\/services\/[^/]+\/FeatureServer\/addToDefinition$/i, op("addToDefinition",
    "https://developers.arcgis.com/rest/services-reference/online/add-to-definition-feature-service/", ["addToDefinition", "async"])],
  [/\/sharing\/rest\/content\/users\/[^/]+\/shareItems$/i, op("shareItems", "https://developers.arcgis.com/rest/users-groups-and-items/share-items/", ["everyone", "org", "items", "groups", "confirmItemControl"])],
  [/\/sharing\/rest\/content\/users\/[^/]+\/unshareItems$/i, op("unshareItems", "https://developers.arcgis.com/rest/users-groups-and-items/unshare-items/", ["items", "groups"])],
  [/\/sharing\/rest\/content\/users\/[^/]+\/(?:[^/]+\/)?items\/[^/]+\/update$/i, op("item update", "https://developers.arcgis.com/rest/users-groups-and-items/update-item/", [
    "title", "thumbnail", "thumbnailurl", "metadata", "metadataEditable", "metadataFormats", "typeKeywords", "description", "tags",
    "snippet", "extent", "spatialReference", "accessInformation", "classification", "licenseInfo", "culture", "properties", "url",
    "serviceUsername", "servicePassword", "serviceProxyParams", "serviceProxyFilter", "createAsServiceProxy", "removeServiceProxy",
    "appCategories", "clearEmptyFields", "categories", "industries", "languages", "largeThumbnail", "banner", "screenshot",
    "listingProperties", "file", "async", "isViewerCopiable", "text", "dataUrl", "multipart", "filename",
    "apiToken1ExpirationDate", "apiToken2ExpirationDate",
  ])],
  [/\/Geoenrichment\/Enrich$/i, op("GeoEnrichment enrich", "https://developers.arcgis.com/rest/geoenrichment/enrich/", [
    "studyAreas", "dataCollections", "analysisVariables", "addDerivativeVariables", "studyAreasOptions", "useData",
    "intersectingGeographies", "returnGeometry", "inSR", "outSR",
  ])],
  [/\/StandardGeographyQuery$/i, op("standard geography query", "https://developers.arcgis.com/rest/geoenrichment/standard-geography-query/", [
    "sourceCountry", "optionalCountryDataset", "optionalCountryHierarchy", "geographyLayers", "geographyIDs",
    "geographyQuery", "returnSubGeographyLayer", "subGeographyLayer", "subGeographyQuery", "outSR", "returnGeometry",
    "returnCentroids", "generalizationLevel", "useFuzzySearch", "featureLimit", "featureOffset", "langCode", "outFields",
    "returnCountOnly",
  ])],
  [/\/Geoenrichment\/CreateReport$/i, op("GeoEnrichment report", "https://developers.arcgis.com/rest/geoenrichment/create-report/", [
    "studyAreas", "report", "format", "reportFields", "studyAreasOptions", "returnType", "useData", "inSR",
  ])],
];

/** Accepted by every operation; `token` passes here so that request() refuses it with its own message. */
const COMMON = ["f", "token"];
/** GP task runs: the task's own inputs plus these (execute and submitJob pages); env:* are environment settings. */
const GP_RUN = /\/GPServer\/[^/]+\/(execute|submitJob)$/i;
const GP_COMMON = ["f", "context", "returnZ", "returnM", "returnTrueCurves", "returnFeatureCollection", "returnColumnName", "simplifyFeatures"];
const LAYER_QUERY = OPERATIONS[0][1];

export const operationFor = (url: URL): Operation | undefined => OPERATIONS.find(([pattern]) => pattern.test(url.pathname))?.[1];
export const isGpRun = (url: URL): boolean => GP_RUN.test(url.pathname);
export const isLayerQuery = (url: URL): boolean => operationFor(url) === LAYER_QUERY;

/** Levenshtein distance, case-insensitive. */
function distance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The closest known names, for a "did you mean" hint. */
function closest(name: string, known: string[]): string[] {
  const scored = known.map((candidate) => ({ candidate, d: distance(name, candidate) }))
    .filter(({ d, candidate }) => d <= Math.max(2, Math.floor(candidate.length / 3)))
    .sort((x, y) => x.d - y.d);
  return scored.slice(0, 3).map(({ candidate }) => candidate);
}

const hint = (name: string, known: string[]) => {
  const near = closest(name, known);
  return near.length ? ` Did you mean ${near.map((candidate) => `"${candidate}"`).join(" or ")}?` : "";
};

const unknown = (names: string[], known: string[]) => {
  const lower = new Set(known.map((name) => name.toLowerCase()));
  return names.filter((name) => !lower.has(name.toLowerCase()));
};

/** Why a request to `url` with these parameter names must not be sent, or undefined. */
export function parameterProblem(url: URL, names: string[]): string | undefined {
  const operation = operationFor(url);
  if (!operation) return undefined;
  const known = [...operation.params, ...COMMON];
  const bad = unknown(names, known);
  if (!bad.length) return undefined;
  return bad.map((name) => `"${name}" is not a parameter of ${operation.name}.${hint(name, known)}`).join(" ")
    + ` ArcGIS ignores unknown parameters, so the request was not sent. Parameters: ${operation.docs}`;
}

/** Problems with the inputs of a GP task run, from the task's own description (`<task>?f=json`). */
export function gpInputProblem(task: { name?: string; parameters?: any[] }, params: Record<string, unknown>): string | undefined {
  // Without a parameter list there is nothing to check against; refusing every input would be wrong.
  if (!Array.isArray(task.parameters)) return undefined;
  const inputs = task.parameters.filter((parameter) => parameter.direction === "esriGPParameterDirectionInput");
  const names = inputs.map((parameter) => String(parameter.name));
  const given = Object.keys(params).filter((name) => params[name] !== undefined && params[name] !== null);
  const bad = unknown(given.filter((name) => !/^env:/i.test(name)), [...names, ...GP_COMMON]);
  const lowerGiven = new Set(given.map((name) => name.toLowerCase()));
  // A required input with a default runs with the default; only one without a default must be given.
  const missing = inputs.filter((parameter) => parameter.parameterType === "esriGPParameterTypeRequired"
    && (parameter.defaultValue === null || parameter.defaultValue === undefined)
    && !lowerGiven.has(String(parameter.name).toLowerCase())).map((parameter) => String(parameter.name));
  if (!bad.length && !missing.length) return undefined;
  const label = task.name ? `task "${task.name}"` : "this task";
  return [
    ...bad.map((name) => `"${name}" is not an input of ${label}.${hint(name, names)}`),
    ...missing.map((name) => `${label} is missing required input "${name}".`),
  ].join(" ") + ` Its inputs: ${names.join(", ") || "none"}. The request was not sent.`;
}

/** A parameter value as the script gave it: an object, or a JSON string of one. */
const parse = (value: unknown) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const GEOMETRY_OP = /\/GeometryServer\/(\w+)$/i;
const LINEAR_UNITS = ["unit", "lengthunit", "distanceunit", "deviationunit"];
/** Operands that must be wrapped as `{ geometryType, geometry }`, by operation. */
const WRAPPED: Record<string, string[]> = { intersect: ["geometry"], difference: ["geometry"], distance: ["geometry1", "geometry2"] };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Value shapes the geometry service refuses with a misleading message ("empty geometry", "polygon cut"),
 * checked live 2026-10-14 against ArcGIS Online: unit names instead of codes, a bare areaUnit, a bare operand.
 */
export function geometryValueProblem(url: URL, params: Record<string, unknown>): string | undefined {
  const match = GEOMETRY_OP.exec(url.pathname);
  if (!match) return undefined;
  const wrapped = WRAPPED[match[1].toLowerCase()] ?? [];
  const problems: string[] = [];
  for (const [name, raw] of Object.entries(params)) {
    const value = parse(raw);
    const key = name.toLowerCase();
    if (value === undefined || value === null) continue;
    if (LINEAR_UNITS.includes(key) && !/^\d+$/.test(String(value))) {
      problems.push(`"${name}" takes a unit code, such as 9001 (meters), 9036 (kilometers) or 9093 (miles), not ${JSON.stringify(value)}.`);
    } else if (key === "areaunit" && !(isObject(value) && typeof value.areaUnit === "string")) {
      problems.push(`"${name}" takes an object, such as { areaUnit: "esriSquareKilometers" }, not ${JSON.stringify(value)}.`);
    } else if (wrapped.includes(key) && !(isObject(value) && "geometryType" in value && "geometry" in value)) {
      problems.push(`"${name}" takes { geometryType, geometry }, with the shape or its reference under geometry.`);
    }
  }
  if (!problems.length) return undefined;
  return `${problems.join(" ")} The geometry service answers these with a misleading error, so the request was not sent.`
    + ` Parameters: ${operationFor(url)?.docs ?? `${ENTERPRISE}/geometry-service/`}`;
}

/** Field names a layer query refers to that the layer does not have, as a sentence, or undefined. */
export function fieldProblem(layer: { fields?: { name: string }[] }, params: Record<string, unknown>): string | undefined {
  const fields = (layer.fields ?? []).map((field) => field.name);
  if (!fields.length) return undefined;
  const list = (value: unknown) => (typeof value === "string" ? value.split(",") : []).map((name) => name.trim().split(/\s+/)[0]).filter(Boolean);
  const statistics = parse(params.outStatistics);
  const stats = Array.isArray(statistics) ? statistics : [];
  // Statistic output names are valid in orderByFields.
  const aliases = stats.map((stat: any) => String(stat?.outStatisticFieldName ?? ""));
  const named = [
    ...list(params.outFields).filter((name) => name !== "*"),
    ...list(params.orderByFields),
    ...list(params.groupByFieldsForStatistics),
    ...stats.map((stat: any) => stat?.onStatisticField).filter((name: unknown): name is string => typeof name === "string" && name !== "*"),
  ];
  const bad = [...new Set(unknown(named, [...fields, ...aliases]))];
  if (!bad.length) return undefined;
  const described = (name: string) => {
    const near = closest(name, fields);
    return near.length ? `"${name}" (did you mean ${near.map((candidate) => `"${candidate}"`).join(" or ")}?)` : `"${name}"`;
  };
  return `Not fields of this layer: ${bad.map(described).join(", ")}. Fields: ${fields.join(", ")}.`;
}
