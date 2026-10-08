// Geometry by reference. Lines, polygons and multipoints never travel in a
// tool result: they are written to artifacts/geometry/ as GeoJSON and replaced by
// a small reference, and a reference passed as a parameter is turned back into
// the shape before a request is sent. Single points and extents stay inline.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

type Ring = number[][];

// The project's own folders, which ARCPI_ARTIFACTS_DIR may not name (the launcher refuses the same).
const PROJECT_DIRS = new Set(["arcgis-rest", "mappi", "test", "tasks", "video"]);
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The artifacts folder name: one plain folder of the project, never a dot folder or one of
 * the project's own, since startup deletes old files there. Shared with mappi's /artifacts.
 */
export function artifactsFolder(env: NodeJS.ProcessEnv): string {
  const name = env.ARCPI_ARTIFACTS_DIR || "artifacts";
  if (!FOLDER_NAME.test(name) || PROJECT_DIRS.has(name)) {
    throw new Error(`ARCPI_ARTIFACTS_DIR must be one folder name in the project, not a dot folder or ${[...PROJECT_DIRS].join(", ")}: ${name}`);
  }
  return name;
}

export interface GeometryFile {
  /** Absolute, so a reader in another working directory (mappi's /artifacts) can open it. */
  path: string;
  features: number;
  /** Spatial reference of the coordinates in the file, when the response named one. */
  wkid?: number;
}

export interface GeometryReference {
  /** `<path>#<feature index>` of the shape on disk. */
  $geometry: string;
  type: string;
  vertices: number;
  bbox: number[];
}

/** Confine reads and writes to artifacts/, refusing symlinks at every component. */
export function artifactPath(shown: string, artifactsDir: string): string {
  const path = resolve(dirname(artifactsDir), shown);
  if (!path.startsWith(artifactsDir + sep)) throw new Error(`File path ${shown} is not under ${basename(artifactsDir)}/.`);
  for (let part = path; ; part = dirname(part)) {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error(`Paths under ${basename(artifactsDir)}/ must not contain symlinks.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (part === artifactsDir) break;
  }
  return path;
}

const ESRI_TYPE: Record<string, string> = {
  MultiPoint: "esriGeometryMultipoint",
  LineString: "esriGeometryPolyline",
  MultiLineString: "esriGeometryPolyline",
  Polygon: "esriGeometryPolygon",
  MultiPolygon: "esriGeometryPolygon",
};

const isPosition = (value: unknown): value is number[] => Array.isArray(value) && typeof value[0] === "number";
const isPath = (value: unknown): value is number[][] => Array.isArray(value) && isPosition(value[0]);

/** A line, polygon or multipoint in Esri JSON or GeoJSON. A single point is not one. */
function isShape(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  // ponytail: a GeoJSON GeometryCollection is not recognized; ArcGIS services do not return one.
  if (typeof node.type === "string" && node.type in ESRI_TYPE && Array.isArray(node.coordinates)) return true;
  return [node.rings, node.paths].some((parts) => Array.isArray(parts) && isPath(parts[0])) || isPath(node.points);
}

const isClockwise = (ring: Ring): boolean => {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  return sum >= 0;
};

const oriented = (ring: Ring, clockwise: boolean): Ring => (isClockwise(ring) === clockwise ? ring : [...ring].reverse());

const contains = (ring: Ring, [x, y]: number[]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Esri JSON geometry as GeoJSON; GeoJSON is returned as it is. */
function toGeoJson(geometry: any): { type: string; coordinates: any } | null {
  if (!geometry || typeof geometry !== "object") return null;
  if (typeof geometry.type === "string") return geometry;
  if (isPath(geometry.points)) return { type: "MultiPoint", coordinates: geometry.points };
  if (Array.isArray(geometry.paths)) {
    return geometry.paths.length === 1
      ? { type: "LineString", coordinates: geometry.paths[0] }
      : { type: "MultiLineString", coordinates: geometry.paths };
  }
  if (Array.isArray(geometry.rings)) {
    // Esri lists rings flat: clockwise ones are outlines, the others are holes in the outline around them.
    const rings: Ring[] = geometry.rings;
    let outlines = rings.filter(isClockwise);
    const holes = outlines.length ? rings.filter((ring) => !isClockwise(ring)) : [];
    if (!outlines.length) outlines = rings;
    const polygons = outlines.map((outline) => [outline]);
    for (const hole of holes) (polygons.find(([outline]) => contains(outline, hole[0])) ?? polygons.at(-1)!).push(hole);
    // GeoJSON (RFC 7946) winds the other way: outline counter-clockwise, holes clockwise.
    const coordinates = polygons.map((polygon) => polygon.map((ring, i) => oriented(ring, i > 0)));
    return coordinates.length === 1 ? { type: "Polygon", coordinates: coordinates[0] } : { type: "MultiPolygon", coordinates };
  }
  if (typeof geometry.x === "number" && typeof geometry.y === "number") {
    return { type: "Point", coordinates: [geometry.x, geometry.y, ...(typeof geometry.z === "number" ? [geometry.z] : [])] };
  }
  return null;
}

/** A stored GeoJSON geometry as the Esri JSON a REST parameter expects. */
function toEsri(shape: { type: string; coordinates: any }): Record<string, unknown> {
  const esriRings = (polygon: Ring[]) => polygon.map((ring, i) => oriented(ring, i === 0));
  switch (shape.type) {
    case "Point": return { x: shape.coordinates[0], y: shape.coordinates[1] };
    case "MultiPoint": return { points: shape.coordinates };
    case "LineString": return { paths: [shape.coordinates] };
    case "MultiLineString": return { paths: shape.coordinates };
    case "Polygon": return { rings: esriRings(shape.coordinates) };
    case "MultiPolygon": return { rings: shape.coordinates.flatMap(esriRings) };
    default: throw new Error(`A ${shape.type} cannot be used as a geometry parameter.`);
  }
}

function* positions(coordinates: any): Generator<number[]> {
  if (isPosition(coordinates)) yield coordinates;
  else for (const part of coordinates) yield* positions(part);
}

const wkidOf = (sr: any): number | undefined =>
  typeof sr?.latestWkid === "number" ? sr.latestWkid : typeof sr?.wkid === "number" ? sr.wkid : undefined;

/** The spatial reference a GeoJSON `crs` member names; none means WGS84. */
const srOfCrs = (crs: any): { wkid: number } | undefined => {
  const code = /EPSG:+(\d+)$/i.exec(crs?.properties?.name ?? "")?.[1];
  return code ? { wkid: Number(code) } : undefined;
};

/**
 * Move every shape in a parsed response to disk. Returns the data with each
 * shape replaced by its reference, and the files written. `askedSr` is the
 * spatial reference the request asked for, used where the response names none.
 */
export function externalize(root: unknown, artifactsDir: string, askedSr?: unknown): { data: unknown; files: GeometryFile[] } {
  const files: GeometryFile[] = [];
  const directory = join(artifactsDir, "geometry");

  const store = (features: { geometry: unknown; properties?: unknown }[], sr: unknown): (GeometryReference | undefined)[] => {
    const wkid = wkidOf(sr);
    const stored = features.map((feature) => toGeoJson(feature.geometry));
    const text = JSON.stringify({
      type: "FeatureCollection",
      // Readers assume WGS84 unless told; the full spatial reference is kept for sending the shape back.
      ...(wkid && wkid !== 4326 ? { crs: { type: "name", properties: { name: `EPSG:${wkid}` } } } : {}),
      ...(sr ? { spatialReference: sr } : {}),
      features: stored.map((geometry, i) => ({ type: "Feature", properties: features[i].properties ?? {}, geometry })),
    });
    // Named by content, so the same answer always lands in the same file.
    const path = artifactPath(join(directory, `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.geojson`), artifactsDir);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, text);
    const shown = relative(dirname(artifactsDir), path);
    files.push({ path, features: features.length, wkid });
    return stored.map((geometry, i) => {
      if (!geometry || !isShape(features[i].geometry)) return undefined;
      let vertices = 0;
      const bbox = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of positions(geometry.coordinates)) {
        vertices++;
        bbox[0] = Math.min(bbox[0], x);
        bbox[1] = Math.min(bbox[1], y);
        bbox[2] = Math.max(bbox[2], x);
        bbox[3] = Math.max(bbox[3], y);
      }
      return { $geometry: `${shown}#${i}`, type: ESRI_TYPE[geometry.type], vertices, bbox };
    });
  };

  const visit = (node: any, sr: unknown): any => {
    if (Array.isArray(node)) {
      // A bare list of shapes, as the geometry service answers, becomes one file.
      if (node.length && node.every(isShape)) return store(node.map((geometry) => ({ geometry })), sr);
      return node.map((member) => visit(member, sr));
    }
    if (!node || typeof node !== "object") return node;
    if (node.curveRings || node.curvePaths) {
      throw new Error("The response holds true curves, which cannot be stored: repeat it without returnTrueCurves.");
    }
    // GeoJSON without a crs member is WGS84 by definition.
    const here = node.spatialReference ?? srOfCrs(node.crs) ?? (node.type === "FeatureCollection" ? { wkid: 4326 } : sr);
    if (isShape(node)) return store([{ geometry: node }], here)[0];
    if (Array.isArray(node.features) && node.features.some((feature: any) => isShape(feature?.geometry))) {
      // A feature set goes to one file with its attributes, so the file can be mapped as it is.
      const references = store(
        node.features.map((feature: any) => ({ geometry: feature.geometry, properties: feature.attributes ?? feature.properties })),
        here,
      );
      references.forEach((reference, i) => {
        if (reference) node.features[i].geometry = reference;
      });
    }
    for (const [key, value] of Object.entries(node)) {
      // An encoded polyline is a geometry too; the route's own geometry is already on disk.
      if (key === "compressedGeometry" && typeof value === "string") delete node[key];
      else node[key] = visit(value, here);
    }
    return node;
  };

  return { data: visit(root, askedSr), files };
}

/**
 * Replace every `{ $geometry: reference }` in request parameters by the shape
 * it names, as Esri JSON with its spatial reference. A reference is
 * `<path>#<index>` for one feature or `<path>` for all features of the file;
 * a list of references is merged into one multipart shape. `<path>` is relative
 * to the project, as in the references handed out, or absolute, as in
 * `geometry_files[].path`: either way it must lie under artifacts/.
 */
export function resolveReferences<T>(parameters: T, artifactsDir: string): T {
  const collections = new Map<string, any>();

  const collection = (shown: string): any => {
    const path = artifactPath(shown, artifactsDir);
    if (!collections.has(path)) {
      let parsed: any;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error((error as NodeJS.ErrnoException).code === "ENOENT"
          ? `Geometry reference ${shown} is gone (files under ${basename(artifactsDir)}/ expire after a day by default): repeat the request that produced it.`
          : `Geometry reference ${shown} is not a geometry file.`);
      }
      if (!Array.isArray(parsed?.features)) throw new Error(`Geometry reference ${shown} is not a geometry file.`);
      collections.set(path, parsed);
    }
    return collections.get(path);
  };

  const shapesOf = (reference: unknown): { shape: Record<string, unknown>; sr: unknown }[] => {
    if (typeof reference !== "string") throw new Error("$geometry must be a reference string or a list of them.");
    // Only a trailing #<n> is the feature index: an absolute path may itself contain #.
    const [, shown, index] = /^(.*?)(?:#(\d+))?$/s.exec(reference)!;
    const file = collection(shown);
    const sr = file.spatialReference ?? srOfCrs(file.crs) ?? { wkid: 4326 };
    const features = index === undefined ? file.features : [file.features[Number(index)]];
    const shapes = features.filter((feature: any) => feature?.geometry).map((feature: any) => ({ shape: toEsri(feature.geometry), sr }));
    if (!shapes.length) throw new Error(`Geometry reference ${reference} names no geometry.`);
    return shapes;
  };

  const visit = (value: any): any => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    if (!("$geometry" in value)) return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, visit(member)]));
    const shapes = [value.$geometry].flat().flatMap(shapesOf);
    if (shapes.length === 1) return { ...shapes[0].shape, spatialReference: shapes[0].sr };
    // Several shapes become one multipart shape: all their rings, paths or points together.
    const kind = Object.keys(shapes[0].shape)[0];
    const compatible = kind !== "x" && shapes.every(({ shape, sr }) =>
      Object.keys(shape)[0] === kind && wkidOf(sr) === wkidOf(shapes[0].sr));
    if (!compatible) throw new Error("Only shapes of one kind and one spatial reference can be merged.");
    return { [kind]: shapes.flatMap(({ shape }) => shape[kind] as unknown[]), spatialReference: shapes[0].sr };
  };

  return visit(parameters);
}
