# Geoprocessing (GP) services

A GP service (`.../GPServer`) publishes tasks: tools or models that run on the
server. Inputs and outputs are named by the task itself, so read the task
before running it; never guess input names or choice values. Esri's hosted
analysis and elevation GP services consume credits; a service you found
through search may not, so say which kind you are calling.

## Discover

| Endpoint | Gives |
|---|---|
| `<gp>` | `tasks[]` (task names) and `executionType`: `esriExecutionTypeSynchronous` (run with `execute`) or `esriExecutionTypeAsynchronous` (run with `submitJob`) |
| `<gp>/<task>` | `parameters[]`: `name`, `dataType`, `direction` (`esriGPParameterDirectionInput` / `Output`), `parameterType` (`esriGPParameterTypeRequired`, `Optional`, `Derived`), `defaultValue`, `choiceList` |

Task names can contain spaces: encode them in the URL
(`.../GPServer/Windfarm%20analysis`). A `choiceList` is the complete set of
accepted values; pick from it, matching the user's wording to an entry.

```js
const rest = async (url, params, extra) => (await tools.arcgis_request({ url, params, ...extra })).data;
const service = "https://sampleserver6.arcgisonline.com/arcgis/rest/services/OtherGeoprocessingServices/GPServer";
const { tasks, executionType } = await rest(service);
const task = `${service}/${encodeURIComponent(tasks[1])}`;
const { parameters } = await rest(task);
return {
  executionType,
  inputs: parameters.filter((p) => p.direction === "esriGPParameterDirectionInput")
    .map((p) => ({ name: p.name, type: p.dataType, required: p.parameterType, default: p.defaultValue, choices: p.choiceList })),
  outputs: parameters.filter((p) => p.direction === "esriGPParameterDirectionOutput").map((p) => ({ name: p.name, type: p.dataType })),
};
```

`arcgis_request` checks the inputs of every `execute` and `submitJob` against
the task: a name the task does not have, or a required input without a default
that is missing, fails before the request is sent, and the error lists the
task's inputs. Environment settings (`env:outSR`, `env:processSR`) and
`context`, `returnZ`, `returnM`, `returnTrueCurves`, `returnFeatureCollection`,
`returnColumnName`, `simplifyFeatures` are always accepted.

## Input values by `dataType`

| `dataType` | Value |
|---|---|
| `GPString`, `GPLong`, `GPDouble`, `GPBoolean` | Plain value |
| `GPDate` | Epoch milliseconds (UTC) |
| `GPLinearUnit` | `{ distance: 5, units: "esriMiles" }` (`esriMeters`, `esriMiles`, ...) |
| `GPFeatureRecordSetLayer` | A feature set `{ geometryType, spatialReference, features: [ { geometry, attributes } ] }`, or `{ url: "<feature layer URL>" }` |
| `GPRecordSet` | `{ features: [ { attributes } ] }` |
| `GPDataFile`, `GPRasterDataLayer` | `{ url: "<file URL>" }` or `{ itemID }` |
| `GPMultiValue:<type>` | An array of values of `<type>` |

Shapes go in by reference, as everywhere: a feature set may hold
`geometry: feature.geometry` from an earlier query, and the tool sends the real
shape.

## Run a synchronous task: `<gp>/<task>/execute`

Pass the inputs under their task names. The response is `results[]`, one per
output: `{ paramName, dataType, value }`. A `GPRecordSet` or
`GPFeatureRecordSetLayer` value has `features[]` (lines and polygons as
references); a raster or file output is `{ url }` or a `mapImage`.

```js
const run = await rest(`${task}/execute`, { Onshore_Windfarm_Proposals: "Onshore_Windfarm_Proposals", ROAD: "ROAD_Erase" });
const table = run.results.find((result) => result.paramName === "Output_Table").value;
const byStatus = {};
for (const { attributes } of table.features) byStatus[attributes.STATUS] = (byStatus[attributes.STATUS] ?? 0) + 1;
return { rows: table.features.length, byStatus };
```

## Run an asynchronous task: `<gp>/<task>/submitJob`

`submitJob` answers `{ jobId, jobStatus }`. Poll `<gp>/<task>/jobs/<jobId>`
until `jobStatus` is final: `esriJobSucceeded`, `esriJobFailed`,
`esriJobTimedOut` or `esriJobCancelled`. Earlier states are `esriJobNew`,
`esriJobSubmitted`, `esriJobWaiting`, `esriJobExecuting`, `esriJobCancelling`.
On success, `results` maps each output name to `{ paramUrl }`; read
`<gp>/<task>/jobs/<jobId>/<paramUrl>` for `{ paramName, dataType, value }`.
`messages[]` explains a failure: report them.

Scripts have no timers, so each poll follows the previous answer at once. Poll
a bounded number of times in one script; if the job is still running, store the
job ID and report that it is running, then continue in a later script. Never
submit the job again just because it is slow.

```js
// @options: {"timeout_ms": 120000}
const hotspot = "https://sampleserver6.arcgisonline.com/arcgis/rest/services/911CallsHotspot/GPServer/911%20Calls%20Hotspot";
let jobId = load("gp.jobId");
if (!jobId) {
  ({ jobId } = await rest(`${hotspot}/submitJob`, { Query: "(\"DATE\" > date '1998-01-01 00:00:00' AND \"DATE\" < date '1998-01-31 00:00:00')" }));
  store("gp.jobId", jobId);
}
let job;
for (let poll = 0; poll < 100; poll++) {
  job = await rest(`${hotspot}/jobs/${jobId}`);
  if (!["esriJobNew", "esriJobSubmitted", "esriJobWaiting", "esriJobExecuting", "esriJobCancelling"].includes(job.jobStatus)) break;
}
if (job.jobStatus !== "esriJobSucceeded") {
  return { jobId, status: job.jobStatus, messages: job.messages?.slice(-5) };
}
store("gp.jobId", undefined);
const output = await rest(`${hotspot}/jobs/${jobId}/${job.results.Hotspot_Raster.paramUrl}`);
return { jobId, output: output.dataType, image: output.value.mapImage?.href };
```

A job runs once per `submitJob`: a submitted job is real work (and may bill
credits) even if the script fails afterwards.
