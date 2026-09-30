# SafeSpace web: the stress recorder

A strip-chart recorder for the SafeSpace v2 models. Each wrist signal (heart rate, skin conductance, skin temperature, heart-rate variability) has its own logistic regression and writes its own pen between −1 (calm) and +1 (stressed). The fused score is the mean of the pens' log-odds, drawn as a gauge needle at the right edge. Pull a pen and the fused score is recomputed from the others.

Recorded sessions cannot be published yet (WESAD-derived per-window data waits on a licence decision), so the recorder plays sessions **simulated from the visitor's settings**: a resting baseline in natural units and a script of steps (Rest, Public speaking, Amusement, Walking). The page says so wherever scores appear. Research demo, not a medical tool.

## Run

```
cd web
npm install
npm run dev        # http://localhost:5175
npm test           # vitest: ONNX parity, fusion, scenario and narration
npm run build      # type-check + production build into dist/
npm run preview    # serves dist/ on 5175 with the vercel.json headers (CSP included)
npm run shots      # with preview running: Playwright screenshots, axe, embed bridge check -> e2e/shots/
```

`?at=15.5` opens the page paused at that simulated minute. `/embed` is the compact recorder for the portfolio Lab.

## Architecture decision: no ONNX runtime in the browser

The ONNX files (`../models_v2/*.onnx`) prove the models are portable; the browser needs four dot products, not a 10 MB runtime. Each model is a logistic regression on calibrated features, so the page computes `p = sigmoid(w · z + b)` itself:

- `../training/export_web.py` copies the coefficients, intercepts, feature order, units and SD floors from `models_v2/model_card.json` into `src/model/models.json`, and asserts they match the ONNX initialisers.
- It also writes `src/model/parity.fixtures.json`: random calibrated feature vectors (not WESAD data) with the probabilities onnxruntime computes for them. `tests/score.test.ts` requires the TypeScript scorer (`src/model/score.ts`) to match every fixture to within 1e-6.
- The typical resting values and condition shifts in `models.json` are summary constants only: medians across the 15 subjects of each subject's rest5 mean and SD, and of the per-condition shift. No per-window data is shipped.

Regenerate after retraining (from `training/`, with the Python environment described in `training/README.md`):

```
python export_web.py --card ../models_v2/model_card.json --models ../models_v2 \
    --features cache/features.csv --out ../web/src/model/models.json --fixtures
```

Other choices: Preact + TypeScript + Vite, plain CSS with custom properties, no UI kit, the chart drawn in SVG by hand. Fonts (Instrument Sans, DM Mono; SIL OFL, licences in `src/fonts`) are self-hosted latin subsets. The only network requests are the page's own files.

## How a session is simulated and scored

`src/sim/scenario.ts`: the time step is the model's stride (15 s). Each channel relaxes towards baseline + the step's shift with its own lag (heart rate in seconds, skin conductance over minutes, temperature slower), 60 s windows average five ticks, and AR(1) noise scaled to the typical resting SD is added. Beat coverage for HR/HRV drops out in runs at the rates WESAD showed (HRV is missing in about 65% of stress windows). The first 5 minutes are the rest5 calibration, exactly as in `training/pipeline.py`: z = (x − rest mean) / max(rest SD, floor). Motion is flagged (z > 3), never scored. Public speaking and amusement use the WESAD median shifts; Walking is hand-set (WESAD has no walking condition) to show the motion confound.

## Narration

`src/narrate/templates.ts` builds a summary, a coping tip and one line per included pen from the scores, so narration is always available offline. `src/narrate/hook.ts` is an optional hook for a future LLM rewrite service: set `VITE_NARRATE_URL` at build time and, when the recorder is paused, the page POSTs `{summary, tip, scores}` and shows the returned `{summary, tip}` (4 s timeout, templates on any failure). No such service exists yet; add its origin to `connect-src` in `vercel.json` (the `https://narrate.amittal.dev` entry there is a placeholder).

## /embed and the Lab bridge

`src/embed/bridge.ts` talks to the parent only on `https://www.amittal.dev` and `http://localhost:5173`, both ways: messages from other origins are ignored, and replies are addressed to the parent's origin, never `*`.

- In: `{type:'theme', tokens}` (whitelisted tokens such as `paper`, `ink`, `calm`, `stress`, `bg`, `scheme`; values must look like colours), `{type:'command', name:'play'|'pull'|'refit'|'reset', signal?}`.
- Out: `{type:'ready'}`, `{type:'height', px}`, and `{type:'stage', i, name, ms, ok}` for 0 Signal windows, 1 Feature extraction, 2 Per-signal models, 3 Score mapping, 4 Narration, 5 Coping tip, timed in the browser (`src/embed/pipeline.ts`).

## Deploy on Vercel (not done yet)

Import the repo, set **Root Directory** to `web`; the framework preset is Vite (`npm run build`, output `dist`). `vercel.json` adds the SPA rewrite, one-year immutable caching for hashed `/assets/*` (scripts, styles and fonts), and security headers: a CSP with `default-src 'self'`, `frame-ancestors 'none'` everywhere except `/embed`, which may be framed by `https://www.amittal.dev`. If the site is framed from another host, update both that header and `ALLOWED_ORIGINS` in `bridge.ts`.
