# Local model: LFM2.5-24B-A2B on a Mac

arcpi needs no hosted model: pi talks to a local llama.cpp server through its
built-in `llama.cpp` provider, and the ArcGIS side is unchanged. This page
records running arcpi with LiquidAI's
[LFM2.5-24B-A2B](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B) on an Apple
M4 Max (128 GB), what it exposed, and how it compares with hosted models on
the same eval.

## The model

| | |
|---|---|
| Release | 2026-10-09, license LFM 1.0 |
| Architecture | 24B mixture of experts, ~2.4B active per token (64 experts, top-4); 30 short-convolution + 10 GQA blocks |
| Context | 131,072 tokens |
| Tool calls | ChatML template, Pythonic calls between `<\|tool_call_start\|>` and `<\|tool_call_end\|>`; llama.cpp `--jinja` turns them into OpenAI `tool_calls` |
| Reasoning | Always thinks before answering; llama.cpp returns it as `reasoning_content` |
| Sampling | temperature 0.1, top_k 50, repetition penalty 1.05, stored in the GGUF and applied by llama.cpp |
| Vendor claims | Agentic: ahead of Qwen3.6-35B-A3B on AutomationBench, LiveClaw, ToolSandbox, IFBench; tied on BFCLv4; behind on SWE-Bench Verified (51 vs 66), GPQA, WebArena. Not for knowledge-heavy tasks without retrieval |

## Setup

```bash
# 1. The model (25.5 GB Q8_0; Q4_K_M is 14.5 GB). hf's parallel download took 9 min,
#    llama.cpp's own downloader ran at about a third of that speed.
HF_XET_HIGH_PERFORMANCE=1 hf download LiquidAI/LFM2.5-24B-A2B-GGUF \
  LFM2.5-24B-A2B-Q8_0.gguf --local-dir ~/models

# 2. The llama.cpp router (0.6.0). -np 1: one pi session per server. With the default
#    four slots the slots share one KV cache, and an earlier session's cached prompt
#    made the next request fail with "Context size has been exceeded".
llama-server --models-dir ~/models --no-models-autoload --jinja \
  --host 127.0.0.1 --port 8091 -ngl 999 -c 131072 -np 1

# 3. Load it (or /llama inside pi)
curl -X POST http://127.0.0.1:8091/models/load -H 'content-type: application/json' \
  -d '{"model":"LFM2.5-24B-A2B-Q8_0"}'
```

In pi, `/login llama.cpp` with `http://127.0.0.1:8091`, then `/model`. Print
mode (`./arcpi -p`) does not ask the server for its models; it uses the
catalog an interactive (or `--mode rpc`) session saved, so open pi once after
loading a model. Then:

```bash
./arcpi --model llama.cpp/LFM2.5-24B-A2B-Q8_0
```

pi reports the model without thinking levels (its chat template has no
`enable_thinking` switch); it reasons anyway.

On the M4 Max the Q8_0 model loads in about 2 s and generates 83-113 tokens/s
with prompt processing around 370 tokens/s on short prompts.

## Results

`node eval/run.ts` (8 tasks, answers checked against a truth computed without a
model; see README "Live eval"), 2026-10-15. Local runs are capped at 5 minutes
per task (`--minutes 5`): pi has no turn limit, and an uncapped smoke run
repeated one failing script for over 10 minutes. `eval/RESULTS.md` has the
per-task rows.

| Label | Model | Reps | Correct | Turns | Scripts (failed) | REST calls (errors, refused) | Tokens | Wall s |
|---|---|---|---|---|---|---|---|---|
| `contract` | Claude Sonnet 4.6 (Bedrock), 2026-10-14 | 3 | 24/24 | 87 | 63 (0) | 63 (0, 0) | 1.5 M | 371 |
| `sol` | GPT-5.6 Sol (Azure gateway), with the fixes below | 1 | 8/8 | 31 | 21 (0) | 25 (0, 0) | 0.5 M | 486 |
| `lfm2.5` | LFM2.5-24B-A2B Q8_0, local | 1 | 1/8 | 657 | 655 (590) | 68 (29, 2) | 20.0 M | 1979 |
| `lfm2.5-fixes` | the same, with the fixes below | 1 | 1/8 | 401 | 406 (232) | 94 (29, 6) | 11.8 M | 2317 |

Claude's cost was $1.36 for 24 runs; the Sol gateway reports no prices, and the
local model costs only electricity. Per run, Sol and Claude used 2-6 turns;
LFM2.5 used 4-341 and reached the cap in 6 of 8 tasks in both runs.

### Compared

- **Correctness.** Both hosted models answered every task. LFM2.5 answered only
  the simplest (`stats`: one statistics query), in 50-217 s against 6 s.
- **Codemode.** The hosted models read the skill and its references in one
  script (`Promise.all` of `tools.read`), then called the REST API. LFM2.5
  rarely did: it wrote Node (`require('fs')`), shell commands (`ls -la`), or a
  JSON `{ "tool": "read", "args": ... }` object as the script, called `read()`
  without `tools.`, and dropped `await`. It repeated a failing script verbatim
  up to 338 times; the error ("require is not defined") never changed its course.
- **REST.** When it reached the API, the request contract caught its invented
  names (`skip`, `outRecordCount`, `limit`, `fields`, `statistics`), but it did
  not follow a refusal to the documented name and paged with
  `OBJECTID >= 2001` without an order, which overlaps pages.
- **Speed and footprint.** 83-113 tokens/s, 25 GB of unified memory with the
  full 131K context, no network for the model. Fast turns are what let it
  burn 2-11 M tokens in 5 minutes.
- **Use.** Fine for private, offline chat or a single scripted step; not yet
  for multi-step ArcGIS work through codemode. A local model would need to
  pass this eval before arcpi recommends one.

## Gaps it exposed

Fixed on this branch (each also helps hosted models):

1. `.pi/APPEND_SYSTEM.md` now says scripts are QuickJS (no `require`, `fs`,
   `process`) and shows `await tools.read({ path })`. LFM2.5 stopped some of the
   `require` loops (failed scripts 590 → 232) but still wrote them in four tasks.
2. The request contract knew `<layer>/query` but not the layer description
   itself, so `where` sent to `.../FeatureServer/0` went out, was ignored, and
   the layer description came back as if it answered the query. Query
   parameters there are now refused with "Query parameters go to
   <layer>/query" (the description takes only `f`, `returnDomainNames`,
   `returnUpdates`, per Esri's Layer pages). It fired live and LFM2.5 recovered.
3. A guessed GP task name (`windfarm` for `Windfarm analysis`) got only
   "Invalid URL" 8 times. A 400 under a GP task now reads the service and
   appends "Not a task of this service ... Its tasks: ...". Not reached live:
   in the rerun LFM2.5 never got past reading the skill on that task.

Not fixed (outside arcpi, or a model limit):

- pi has no turn cap or repeated-call guard; the eval's `--minutes` is the only stop.
- llama.cpp's default four slots share one KV cache: run `-np 1` (see Setup).
- `./arcpi -p` sees llama.cpp models only after an interactive or RPC pi session
  saved the catalog.
- The Azure gateway intermittently refused GPT-5.6 Sol's own reasoning items
  ("invalid_encrypted_content"); the eval now skips a session that ends in a
  provider error instead of scoring it, and a rerun retries it.

## Lessons

- Vendor agentic benchmarks did not predict this eval: a model that leads
  ToolSandbox and BFCLv4 peers still could not drive codemode. Run the eval
  (with `--minutes`) before recommending a model.
- A prompt hint changes what a small model does, not whether it succeeds:
  the QuickJS line halved its failed scripts and fixed no task.
- A weak model is a good fuzzer for the request contract. Its mistakes found
  two silent failures (query parameters on the layer description, a guessed
  GP task name) that hosted models had not yet hit.
- Local serving has its own traps: one llama.cpp slot per pi session, and a
  wall-clock cap on every unattended run.
