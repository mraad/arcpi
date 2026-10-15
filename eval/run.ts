// Live eval of the arcgis-rest skills: runs each task through `./arcpi -p`, scores the answer
// against a truth computed without a model, and reads tokens, turns and tool calls from the
// pi session file. Real portal calls and model calls, so it is run by hand, not by `node --test`.
//
//   node eval/run.ts run <label> [--reps N] [--only a,b] [--no-credits] [--model M] [--thinking T] [--minutes N]
//   node eval/run.ts report <label> [<label> ...]     # writes eval/RESULTS.md
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { configFromEnv, request } from "../arcgis-rest/dev.pi/extensions/arcgis/arcgis.ts";
import { tasks } from "./tasks.ts";
import type { Answer, Task } from "./tasks.ts";

const root = join(import.meta.dirname, "..");
const runsDir = join(import.meta.dirname, "runs");
const truthFile = join(runsDir, "truth.json");

interface Score {
  task: string;
  rep: number;
  correct: boolean;
  wrong?: string;
  answer?: Answer;
  turns: number;
  scripts: number;
  failedScripts: number;
  restCalls: number;
  restErrors: number;
  /** REST call errors raised by the request contract (unknown parameter, field or input). */
  rejections: number;
  tokens: number;
  cost: number;
  seconds: number;
  exit: number | null;
}

/** Expected answers for these tasks, computed only for the ones not cached (some cost credits). */
async function truths(refresh: boolean, wanted: Task[] = tasks): Promise<Record<string, Answer>> {
  const result: Record<string, Answer> = !refresh && existsSync(truthFile) ? JSON.parse(readFileSync(truthFile, "utf8")) : {};
  const missing = wanted.filter((task) => !(task.id in result));
  if (!missing.length) return result;
  const cfg = configFromEnv({ ...process.env, ARCGIS_SESSION_DIR: join(root, ".arcgis") }, root);
  const rest = async (url: string, params?: Record<string, unknown>) => (await request(cfg, { url, params })).data;
  for (const task of missing) result[task.id] = await task.truth(rest);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(truthFile, JSON.stringify(result, null, 2));
  return result;
}

const prompt = (task: Task) =>
  `${task.prompt}\n\nEnd your reply with exactly one line \`ANSWER: <JSON object>\` with the keys ${task.keys.join(", ")} `
  + "and plain JSON values (numbers as numbers).";

function runPi(task: Task, dir: string, model: string, thinking: string, minutes: number): Promise<{ exit: number | null; seconds: number }> {
  const started = Date.now();
  return new Promise((done) => {
    // stdin closed: non-interactive pi waits on an open stdin (tasks/lessons.md).
    const child = spawn(join(root, "arcpi"), [
      "-p", "--approve", "--model", model, "--thinking", thinking, "--session-dir", join(dir, "session"), prompt(task),
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    // A model that repeats a failing call never ends on its own (pi has no turn cap).
    const timer = setTimeout(() => child.kill("SIGTERM"), minutes * 60_000);
    child.on("close", (exit) => {
      clearTimeout(timer);
      writeFileSync(join(dir, "stdout.txt"), Buffer.concat(out));
      writeFileSync(join(dir, "stderr.txt"), Buffer.concat(err));
      done({ exit, seconds: (Date.now() - started) / 1000 });
    });
  });
}

const REJECTION = /is not a parameter of|is not an input of|is missing required input|Not fields of this layer|Not a task of this service| takes (a unit code|an object|\{ geometryType)/;

export function scoreSession(lines: any[], task: Task, truth: Answer) {
  const messages = lines.filter((line) => line.type === "message").map((line) => line.message);
  const assistant = messages.filter((message) => message.role === "assistant");
  const results = messages.filter((message) => message.role === "toolResult");
  const nested = results.flatMap((message) => message.nestedCalls?.calls ?? []).filter((call: any) => call.name === "arcgis_request");
  const failed = (call: any) => call.status !== "ok";
  const last = [...assistant].reverse().find((message) => message.content?.some((block: any) => block.type === "text"));
  const finalText = (last?.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
  let answer: Answer | undefined;
  const line = finalText.split("\n").reverse().find((text: string) => /^\s*`?ANSWER:/.test(text));
  try {
    answer = line ? JSON.parse(line.replace(/^\s*`?ANSWER:\s*/, "").replace(/`\s*$/, "")) : undefined;
  } catch {
    answer = undefined;
  }
  // A scalar or array ANSWER would make the key checks throw; it is a wrong answer, not a crash.
  const wrong = !line ? "no ANSWER line"
    : typeof answer !== "object" || answer === null || Array.isArray(answer) ? "ANSWER is not a JSON object"
    : task.check(answer, truth);
  const usage = assistant.map((message) => message.usage ?? {});
  return {
    correct: !wrong,
    wrong,
    answer,
    turns: assistant.length,
    scripts: assistant.flatMap((message) => message.content ?? []).filter((block: any) => block.type === "toolCall" && block.name === "codemode").length,
    failedScripts: results.filter((message) => message.toolName === "codemode" && (message.isError || /^Script failed/.test(message.content?.[0]?.text ?? ""))).length,
    restCalls: nested.length,
    restErrors: nested.filter(failed).length,
    rejections: nested.filter((call: any) => failed(call) && REJECTION.test(JSON.stringify(call))).length,
    tokens: usage.reduce((sum, u) => sum + (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), 0),
    cost: usage.reduce((sum, u) => sum + (u.cost?.total ?? 0), 0),
  };
}

const sessionLines = (dir: string) => {
  const sessions = join(dir, "session");
  // A retried attempt leaves the earlier session file beside the new one: read the newest.
  const file = existsSync(sessions)
    ? readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".jsonl"))
      .sort((a, b) => statSync(join(sessions, b)).mtimeMs - statSync(join(sessions, a)).mtimeMs)[0]
    : undefined;
  return file ? readFileSync(join(sessions, file), "utf8").trim().split("\n").map((text) => JSON.parse(text)) : [];
};

async function run(label: string, options: { reps: number; only?: string; credits: boolean; model: string; thinking: string; minutes: number; refresh: boolean }) {
  const selected = tasks.filter((task) => (!options.only || options.only.split(",").includes(task.id)) && (options.credits || !task.credits));
  const truth = await truths(options.refresh, selected);
  const resultsFile = join(runsDir, label, "results.json");
  const scores: Score[] = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : [];
  for (let rep = 1; rep <= options.reps; rep++) {
    for (const task of selected) {
      if (scores.some((score) => score.task === task.id && score.rep === rep)) continue;
      const dir = join(runsDir, label, `${task.id}-${rep}`);
      mkdirSync(dir, { recursive: true });
      const { exit, seconds } = await runPi(task, dir, options.model, options.thinking, options.minutes);
      const lines = sessionLines(dir);
      const score: Score = { task: task.id, rep, exit, seconds, ...scoreSession(lines, task, truth[task.id]) };
      if (score.tokens === 0) {
        // No model reply (provider or launcher failure): not a result, so it is not recorded and reruns retry it.
        throw new Error(`${label} ${task.id}#${rep}: pi produced no model reply (exit ${exit}): `
          + readFileSync(join(dir, "stderr.txt"), "utf8").trim().split("\n").at(-1));
      }
      // A provider error mid-session is not the model's answer either: skipped, and a rerun retries it.
      const last = lines.filter((line) => line.type === "message" && line.message.role === "assistant").at(-1)?.message;
      if (last?.stopReason === "error") {
        console.log(`${label} ${task.id}#${rep}: provider error, not recorded: ${String(last.errorMessage).slice(0, 200)}`);
        continue;
      }
      scores.push(score);
      writeFileSync(resultsFile, JSON.stringify(scores, null, 2));
      console.log(`${label} ${task.id}#${rep}: ${score.correct ? "correct" : `WRONG (${score.wrong})`}, ${score.turns} turns, `
        + `${score.restCalls} REST calls (${score.restErrors} errors, ${score.rejections} rejected), ${score.tokens} tokens, $${score.cost.toFixed(3)}, ${seconds.toFixed(0)} s`);
    }
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function report(labels: string[]) {
  const rows = [
    "| Label | Task | Correct | Turns | Scripts (failed) | REST calls (errors, rejected) | Tokens | Cost $ | Seconds |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const label of labels) {
    const scores: Score[] = JSON.parse(readFileSync(join(runsDir, label, "results.json"), "utf8"));
    for (const task of tasks) {
      const runs = scores.filter((score) => score.task === task.id);
      if (!runs.length) continue;
      const m = (key: keyof Score) => median(runs.map((score) => score[key] as number));
      rows.push(`| ${label} | ${task.id} | ${runs.filter((score) => score.correct).length}/${runs.length} | ${m("turns")} | ${m("scripts")} (${m("failedScripts")}) `
        + `| ${m("restCalls")} (${m("restErrors")}, ${m("rejections")}) | ${m("tokens")} | ${m("cost").toFixed(3)} | ${m("seconds").toFixed(0)} |`);
    }
    const total = (key: keyof Score) => scores.reduce((sum, score) => sum + (score[key] as number), 0);
    rows.push(`| ${label} | **all** | ${scores.filter((score) => score.correct).length}/${scores.length} | ${total("turns")} | ${total("scripts")} (${total("failedScripts")}) `
      + `| ${total("restCalls")} (${total("restErrors")}, ${total("rejections")}) | ${total("tokens")} | ${total("cost").toFixed(2)} | ${total("seconds").toFixed(0)} |`);
  }
  const text = `# Eval results\n\nMedians per task over its runs; **all** rows are totals. Generated by \`node eval/run.ts report ${labels.join(" ")}\`.\n\n${rows.join("\n")}\n`;
  writeFileSync(join(import.meta.dirname, "RESULTS.md"), text);
  console.log(text);
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      reps: { type: "string", default: "1" }, only: { type: "string" }, "no-credits": { type: "boolean", default: false },
      model: { type: "string", default: "amazon-bedrock/us.anthropic.claude-sonnet-4-6" }, thinking: { type: "string", default: "medium" }, minutes: { type: "string", default: "15" },
      "refresh-truth": { type: "boolean", default: false },
    },
  });
  const [command, ...labels] = positionals;
  const minutes = Number(values.minutes);
  if (command === "run" && labels.length === 1 && !(minutes > 0 && Number.isFinite(minutes))) {
    // NaN or 0 would make the timer fire at once and kill every run.
    console.error(`--minutes must be a number above 0, not ${values.minutes}`);
    process.exitCode = 2;
  } else if (command === "run" && labels.length === 1) {
    await run(labels[0], {
      reps: Number(values.reps), only: values.only, credits: !values["no-credits"], model: values.model!, thinking: values.thinking!, minutes, refresh: values["refresh-truth"]!,
    });
  } else if (command === "rescore" && labels.length === 1) {
    // Score stored sessions again after a checker fix; runs are not repeated.
    const truth = await truths(false);
    const file = join(runsDir, labels[0], "results.json");
    const scores: Score[] = JSON.parse(readFileSync(file, "utf8")).map((score: Score) => ({
      ...score, ...scoreSession(sessionLines(join(runsDir, labels[0], `${score.task}-${score.rep}`)), tasks.find((task) => task.id === score.task)!, truth[score.task]),
    }));
    writeFileSync(file, JSON.stringify(scores, null, 2));
    console.log(scores.map((score) => `${score.task}#${score.rep}: ${score.correct ? "correct" : `WRONG (${score.wrong})`}`).join("\n"));
  } else if (command === "truth") {
    console.log(JSON.stringify(await truths(true), null, 2));
  } else if (command === "report" && labels.length) {
    report(labels);
  } else {
    console.error("usage: node eval/run.ts run <label> [--reps N] [--only ids] [--no-credits] | truth | report <label>...");
    process.exitCode = 2;
  }
}
