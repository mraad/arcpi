// Eval tasks: each prompt goes to `./arcpi -p`; `truth` computes the expected answer once,
// without a model, through the same request() the agent uses.

export type Rest = (url: string, params?: Record<string, unknown>) => Promise<any>;
export type Answer = Record<string, unknown>;

export interface Task {
  id: string;
  /** The task consumes organization credits (one service-area solve). */
  credits: boolean;
  prompt: string;
  /** The ANSWER keys the prompt asks for. */
  keys: string[];
  truth: (rest: Rest) => Promise<Answer>;
  /** Names the key that differs, or undefined when the answer matches. */
  check: (answer: Answer, truth: Answer) => string | undefined;
}

const COUNTIES = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Counties_Generalized_Boundaries/FeatureServer/0";
const STATES = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_States_Generalized_Boundaries/FeatureServer/0";
const GP_SERVICE = "https://sampleserver6.arcgisonline.com/arcgis/rest/services/OtherGeoprocessingServices/GPServer";
const NLCD = "https://sampleserver6.arcgisonline.com/arcgis/rest/services/NLCDLandCover2001/ImageServer";
const ESRI_HQ = "380 New York St, Redlands, CA 92373";
const WHITE_HOUSE = "1600 Pennsylvania Ave NW, Washington, DC 20500";
const POINTS = [[-117.1956, 34.0572], [-122.4194, 37.7749], [-105.2705, 40.015]];

const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b;
const near = (a: unknown, b: unknown, relative: number) =>
  typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= Math.abs(b) * relative;
/** The answer's value for a key: the key itself, or the one key that contains its name (`total_counties`). */
const valueOf = (answer: Answer, key: string) => {
  if (key in answer) return answer[key];
  const matches = Object.keys(answer).filter((name) => name.toLowerCase().replace(/_/g, "").includes(key.toLowerCase()));
  return matches.length === 1 ? answer[matches[0]] : undefined;
};
const firstDifferent = (answer: Answer, truth: Answer, equal = same) =>
  Object.keys(truth).find((key) => !equal(valueOf(answer, key), truth[key]));

/** Every row of a query, paged by offset. */
async function allRows(rest: Rest, layer: string, params: Record<string, unknown>) {
  const rows: any[] = [];
  for (let offset = 0; ; ) {
    const page = await rest(`${layer}/query`, { ...params, resultOffset: offset, resultRecordCount: 1000 });
    rows.push(...page.features.map((feature: any) => feature.attributes));
    if (!page.exceededTransferLimit) return rows;
    offset += page.features.length;
  }
}

async function geocode(rest: Rest, address: string) {
  const helpers = (await rest("/sharing/rest/portals/self")).helperServices;
  const found = await rest(`${helpers.geocode[0].url}/findAddressCandidates`, { SingleLine: address, maxLocations: 1, outSR: 4326 });
  return found.candidates[0].location as { x: number; y: number };
}

/** Geodesic distance on the WGS84 ellipsoid (Vincenty inverse), in km. */
function geodesicKm(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const f = 1 / 298.257223563, A = 6378137, B = A * (1 - f), rad = Math.PI / 180;
  const L = (b.x - a.x) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(a.y * rad)), U2 = Math.atan((1 - f) * Math.tan(b.y * rad));
  const [sU1, cU1, sU2, cU2] = [Math.sin(U1), Math.cos(U1), Math.sin(U2), Math.cos(U2)];
  let lambda = L, sinS = 0, cosS = 0, sigma = 0, cos2A = 0, cos2Sm = 0;
  for (let i = 0; i < 200; i++) {
    const sL = Math.sin(lambda), cL = Math.cos(lambda);
    sinS = Math.hypot(cU2 * sL, cU1 * sU2 - sU1 * cU2 * cL);
    cosS = sU1 * sU2 + cU1 * cU2 * cL;
    sigma = Math.atan2(sinS, cosS);
    const sinA = (cU1 * cU2 * sL) / sinS;
    cos2A = 1 - sinA * sinA;
    cos2Sm = cosS - (2 * sU1 * sU2) / cos2A;
    const C = (f / 16) * cos2A * (4 + f * (4 - 3 * cos2A));
    const next = L + (1 - C) * f * sinA * (sigma + C * sinS * (cos2Sm + C * cosS * (-1 + 2 * cos2Sm * cos2Sm)));
    if (Math.abs(next - lambda) < 1e-12) break;
    lambda = next;
  }
  const u2 = (cos2A * (A * A - B * B)) / (B * B);
  const k = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dS = k * sinS * (cos2Sm + (k / 4) * (cosS * (-1 + 2 * cos2Sm * cos2Sm) - (k / 6) * cos2Sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2Sm * cos2Sm)));
  return (B * (1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))) * (sigma - dS)) / 1000;
}

export const tasks: Task[] = [
  {
    id: "search",
    credits: false,
    prompt: "Find the ArcGIS Online feature service item titled 'USA Counties Generalized Boundaries' owned by esri_dm. "
      + "Report its item ID and how many layers its feature service has.",
    keys: ["itemId", "layers"],
    truth: async (rest) => {
      const found = await rest("/sharing/rest/search", { q: 'title:"USA Counties Generalized Boundaries" owner:esri_dm type:"Feature Service"', num: 10 });
      const item = found.results.find((result: any) => result.title === "USA Counties Generalized Boundaries");
      return { itemId: item.id, layers: (await rest(item.url)).layers.length };
    },
    check: (answer, truth) => firstDifferent(answer, truth),
  },
  {
    id: "stats",
    credits: false,
    prompt: `Using the county feature layer ${COUNTIES}, what is the total population of all counties in Ohio, `
      + "and how many Ohio counties are there?",
    keys: ["population", "counties"],
    truth: async (rest) => {
      const stats = await rest(`${COUNTIES}/query`, {
        where: "STATE_NAME = 'Ohio'",
        outStatistics: [
          { statisticType: "sum", onStatisticField: "POPULATION", outStatisticFieldName: "population" },
          { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "counties" },
        ],
      });
      return stats.features[0].attributes;
    },
    check: (answer, truth) => firstDifferent(answer, truth),
  },
  {
    id: "paging",
    credits: false,
    prompt: `Using the county feature layer ${COUNTIES}, which county names (the NAME field) are shared by at least 20 `
      + "counties nationwide? Give every such name with its number of counties.",
    keys: ["names"],
    truth: async (rest) => {
      const rows = await allRows(rest, COUNTIES, {
        where: "1=1", groupByFieldsForStatistics: "NAME", orderByFields: "NAME",
        outStatistics: [{ statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" }],
      });
      return { names: Object.fromEntries(rows.filter((row) => row.n >= 20).map((row) => [row.NAME, row.n])) };
    },
    check: (answer, truth) => {
      // Some replies give the name/count object itself instead of wrapping it in `names`.
      const got = (typeof answer.names === "object" && answer.names ? answer.names : answer) as Record<string, unknown>;
      const want = truth.names as Record<string, number>;
      const lower = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
      const [g, w] = [lower(got), lower(want)];
      return Object.keys(g).length === Object.keys(w).length && Object.keys(w).every((name) => g[name] === w[name]) ? undefined : "names";
    },
  },
  {
    id: "spatial",
    credits: false,
    prompt: `Using the county layer ${COUNTIES} and the state layer ${STATES}: how many counties intersect the boundary `
      + "polygon of Colorado, including counties of neighboring states that touch it?",
    keys: ["counties"],
    truth: async (rest) => {
      const state = (await rest(`${STATES}/query`, { where: "STATE_NAME = 'Colorado'", outFields: "STATE_NAME", outSR: 4326 })).features[0];
      const { count } = await rest(`${COUNTIES}/query`, {
        geometry: state.geometry, geometryType: "esriGeometryPolygon", inSR: 4326, spatialRel: "esriSpatialRelIntersects", returnCountOnly: true,
      });
      return { counties: count };
    },
    check: (answer, truth) => firstDifferent(answer, truth),
  },
  {
    id: "geocode",
    credits: false,
    prompt: `Geocode '${ESRI_HQ}' and '${WHITE_HOUSE}' with the portal's geocoder and report the geodesic distance `
      + "between the two locations in kilometers.",
    keys: ["km"],
    truth: async (rest) => ({ km: geodesicKm(await geocode(rest, ESRI_HQ), await geocode(rest, WHITE_HOUSE)) }),
    check: (answer, truth) => (near(valueOf(answer, "km"), truth.km, 0.01) ? undefined : "km"),
  },
  {
    id: "drivetime",
    credits: true,
    prompt: `Create a 10-minute drive-time area around '${ESRI_HQ}' with the portal's service area service, `
      + `then count the counties of ${COUNTIES} that intersect it.`,
    keys: ["counties"],
    truth: async (rest) => {
      const helpers = (await rest("/sharing/rest/portals/self")).helperServices;
      const { x, y } = await geocode(rest, ESRI_HQ);
      const solved = await rest(`${helpers.serviceArea.url}/solveServiceArea`, { facilities: `${x},${y}`, defaultBreaks: "10", outSR: 4326 });
      const area = solved.saPolygons.features[0];
      const { count } = await rest(`${COUNTIES}/query`, {
        geometry: area.geometry, geometryType: "esriGeometryPolygon", inSR: 4326, spatialRel: "esriSpatialRelIntersects", returnCountOnly: true,
      });
      return { counties: count };
    },
    check: (answer, truth) => firstDifferent(answer, truth),
  },
  {
    id: "gp",
    credits: false,
    prompt: `Run the 'Windfarm analysis' task of the geoprocessing service ${GP_SERVICE}, choosing the road input that `
      + "has roads erased. How many wind farm proposals does the output table have, and how many of them have STATUS 'Application'?",
    keys: ["proposals", "application"],
    truth: async (rest) => {
      const task = `${GP_SERVICE}/Windfarm%20analysis`;
      const run = await rest(`${task}/execute`, { Onshore_Windfarm_Proposals: "Onshore_Windfarm_Proposals", ROAD: "ROAD_Erase" });
      const rows = run.results.find((result: any) => result.paramName === "Output_Table").value.features;
      return { proposals: rows.length, application: rows.filter((row: any) => row.attributes.STATUS === "Application").length };
    },
    check: (answer, truth) => firstDifferent(answer, truth),
  },
  {
    id: "imagery",
    credits: false,
    prompt: `Using the land cover image service ${NLCD}, what land cover class name is at each of these WGS84 points `
      + `(longitude, latitude): ${POINTS.map(([x, y]) => `(${x}, ${y})`).join(", ")}? Answer with the class names in that order.`,
    keys: ["classes"],
    truth: async (rest) => {
      const table = await rest(`${NLCD}/rasterAttributeTable`);
      const names = new Map(table.features.map((row: any) => [String(row.attributes.Value), row.attributes.ClassName]));
      const classes = [];
      for (const [x, y] of POINTS) {
        const hit = await rest(`${NLCD}/identify`, { geometry: { x, y, spatialReference: { wkid: 4326 } }, geometryType: "esriGeometryPoint", returnCatalogItems: false });
        classes.push(names.get(String(hit.value)));
      }
      return { classes };
    },
    check: (answer, truth) => {
      const got = valueOf(answer, "classes") as unknown[];
      return Array.isArray(got) && got.length === 3 && got.every((name, i) => same(name, (truth.classes as string[])[i])) ? undefined : "classes";
    },
  },
];
