# SafeSpace rebuild: the contract

Three agents build against this file: **vault** (new `api/` Worker), **app** (`web/` shell, check-in, history, settings) and **inputs** (`web/src/inputs`, `web/src/activities`, `web/src/session`, `web/src/personal`).
If something here is wrong or missing, change it in the same commit as the code and say so in the commit message.
`web/src/contract/*.ts` holds the TypeScript for everything below. The app agent creates it first from this file; the other two import it and may add to it.

Plan this implements: the "SafeSpace" and "SafeSpace · devices and activities" sections of the product plan. Decisions taken: end-to-end encryption with a recovery key; phone camera as the main input if the accuracy check passes; first release = Bluetooth heart-rate devices, file imports and all eight activities (DIY band and OAuth connectors later); mild opt-in challenges included; the simulator moves to "How it works".

## Hosts

- App: `https://safespace.amittal.dev` (Vercel, `web/`). API: `https://safespace-api.amittal.dev` (new Worker in `api/`, D1 database `safespace`). Local: app `http://localhost:5175`, API `http://localhost:8789`.
- Session: HttpOnly cookie on the API host, `ss_session`, `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`. Stored as SHA-256 in D1. `credentials: 'include'`. CORS: exact origins `https://safespace.amittal.dev`, `http://localhost:5175`, with credentials. State-changing requests need `Content-Type: application/json` and an allowed Origin (CSRF).
- Errors: `{ error: string, code: 'bad_request'|'unauthenticated'|'forbidden'|'not_found'|'conflict'|'rate_limited'|'too_large'|'unavailable'|'server' }`.

## Keys (all in the browser, WebCrypto only)

```
salt        = 16 random bytes, stored on the server, returned by /api/auth/params
master      = PBKDF2-SHA256(password, salt, 310_000 iterations, 256 bits)
authKey     = HKDF-SHA256(master, info "safespace auth")      → sent to the server as base64url
wrapKey     = HKDF-SHA256(master, info "safespace wrap")      → AES-GCM key, never leaves the device
dataKey     = random AES-GCM 256 key, created at sign-up
wrappedByPassword = AES-GCM(wrapKey, raw dataKey)             → stored on the server
recoveryKey = 20 random bytes shown once as 8 groups of 4 Crockford base32 chars (e.g. 7K2M-…)
recoveryAuth, recoveryWrap = HKDF(recoveryKey, "safespace recovery auth" / "safespace recovery wrap")
wrappedByRecovery = AES-GCM(recoveryWrap, raw dataKey)        → stored on the server
```

The server stores `PBKDF2(authKey, own salt, 100k)` and `PBKDF2(recoveryAuth, …)`, never `authKey` or `recoveryAuth` themselves. It never sees the password, `wrapKey`, `dataKey` or plaintext records. For an unknown email, `/api/auth/params` returns a salt derived as HMAC(`PARAMS_SECRET`, email) so emails cannot be enumerated.

On the device the unwrapped `dataKey` is kept as a non-extractable CryptoKey in IndexedDB for the life of the session (so a reload does not ask for the password again). Sign-out deletes it.

Record encryption: `iv` = 12 random bytes, `ct` = AES-GCM(dataKey, iv, JSON bytes, additionalData = `${id}|${kind}`). Both base64url on the wire.

## Vault API (`api/`, Hono on Workers + D1)

| Method, path | Body → response |
|---|---|
| GET /api/auth/params?email= | → `{salt, iterations}` |
| POST /api/auth/signup | `{email, salt, authKey, wrappedByPassword:{iv,ct}, recoveryAuth, wrappedByRecovery:{iv,ct}}` → 201 `Me`, sets cookie. 409 if taken |
| POST /api/auth/login | `{email, authKey}` → `Me & {wrappedByPassword}`, sets cookie. 401 generic |
| POST /api/auth/logout | → 204 |
| GET /api/auth/me | → `Me & {wrappedByPassword}` or 401 |
| POST /api/auth/recover/start | `{email}` → `{wrappedByRecovery}` (always 200; a random blob for unknown emails) |
| POST /api/auth/recover | `{email, recoveryAuth, salt, authKey, wrappedByPassword}` → `Me`, sets cookie, revokes other sessions |
| POST /api/auth/password | `{authKey (current), salt, newAuthKey, wrappedByPassword}` → 204, revokes other sessions |
| POST /api/auth/recovery | `{authKey (current), recoveryAuth, wrappedByRecovery:{iv,ct}}` → 204. Replaces the recovery key (Settings, "regenerate"); the old key stops working. *(Amendment, app agent.)* |
| GET /api/auth/sessions, DELETE /api/auth/sessions/:id | as in EduSched: `SessionInfo { id, current, userAgent, createdAt, lastSeenAt }[]` |
| GET /api/records?since=<cursor> | → `{records: SealedRecord[], cursor}` (includes tombstones since the cursor) |
| PUT /api/records/:id | `{kind, iv, ct, baseVersion}` → `{version}`. 409 `conflict` with the current record if `baseVersion` is stale |
| DELETE /api/records/:id | → 204 (leaves a tombstone for other devices) |
| GET /api/export | → every SealedRecord plus the wrapped keys, as one JSON download |
| DELETE /api/account | `{authKey}` → 204, deletes everything |
| POST /api/narrate | `{facts: NarrationFacts}` → `{text, model}` or 503 `unavailable`. Only numbers, labels and the user's tag are sent. Tries OpenRouter, then Groq, then Gemini free models (keys are optional secrets; none set → 503). 10 per hour per user |
| GET /api/test | health, no D1 |
| GET /internal/stats, POST /internal/prune | `x-internal-key` = `INTERNAL_KEY`, else 404. Stats: users, records, dbBytes, sessions |

```ts
interface Me { user: { id: string; email: string; createdAt: string } }
interface SealedRecord { id: string; kind: RecordKind; iv: string; ct: string; version: number; updatedAt: string; deleted: boolean }
type RecordKind = 'checkin' | 'session' | 'baseline' | 'personal-model' | 'import' | 'settings'
```

Limits: 64 KB per record, 5 MB and 5,000 records per user, 5 logins/min per IP, 20 signups per hour per IP. D1 free: 5 GB and 100k writes/day, far more than needed. `id` is a client-made UUID; `updatedAt` is the server's; any meaningful timestamp lives inside the ciphertext.

Without an account a person can do one check-in (and any activity); nothing is sent to the server. After sign-up the app offers to save that check-in.

## Plaintext record shapes (inside the ciphertext)

```ts
type Signal = 'hr' | 'hrv' | 'eda' | 'temp'
type InputSource = 'camera' | 'ble-hr' | 'polar-h10' | 'import-apple' | 'import-fitbit' | 'import-e4' | 'manual'

interface BeatSeries { t0: number; rr: number[] }          // RR intervals in ms, t0 = epoch ms of the first beat

interface Measurement {                                     // what any input produces for one window
  source: InputSource
  device: string | null                                     // "Polar H10 A1B2C3D4", "Pixel 8 camera"
  startedAt: number; durationS: number
  quality: 'good' | 'fair' | 'poor'
  features: Partial<Record<'hr_mean' | 'rmssd' | 'sdnn' | 'eda_tonic' | 'eda_slope' | 'scr_count' | 'scr_amp' | 'temp_mean' | 'temp_slope' | 'acc_std', number>>
  beats?: BeatSeries                                        // kept only when the user turns on "keep raw beats"
  motion?: { flagged: boolean; accStd: number | null }
}

interface Baseline { id: string; createdAt: number; readings: Measurement[]; calibration: { mean: Record<string, number>; sd: Record<string, number>; n: number } }

interface CheckIn {
  id: string; createdAt: number
  measurement: Measurement | null                           // null when only an activity or self-report was done
  activities: ActivityResult[]
  score: { fused: number | null; bySignal: Partial<Record<Signal, { score: number; contributions: { feature: string; z: number; coef: number; value: number }[] }>>; baselineId: string | null } | null
  feeling: 1 | 2 | 3 | 4 | 5 | null                         // very calm … very tense
  tags: string[]                                            // "before exam", "after gym"
  note: string | null
  narration: { text: string; source: 'template' | 'llm'; model?: string } | null
}

interface ActivityResult {
  activity: ActivityId; startedAt: number; durationS: number; completed: boolean
  metrics: Record<string, number>                           // per activity, documented in web/src/activities/README.md
  vsBaseline: Record<string, number> | null                 // z against the user's calm runs of the same activity
}
type ActivityId = 'typing' | 'follow-dot' | 'target-taps' | 'stroop' | 'beat-the-clock' | 'paced-breathing' | 'steady-hand' | 'tap-rhythm'

interface StressSession {
  id: string; createdAt: number
  phases: { name: 'rest' | 'challenge' | 'recovery'; startedAt: number; endedAt: number; activities: ActivityResult[] }[]
  series: { source: InputSource; hr: [number, number][]; rmssd: [number, number][] } | null   // [t (s from start), value]
  summary: { hrRise: number | null; recoveryHalfTimeS: number | null; text: string }
  aborted: boolean
}

interface PersonalModel {                                   // trained in the browser from the user's own sessions
  activity: ActivityId; features: string[]; coef: number[]; intercept: number
  trainedOn: number; heldOut: { balancedAccuracy: number; n: number }; ready: boolean   // ready = held-out balanced accuracy ≥ 0.7 on ≥ 6 windows
}

interface NarrationFacts { fused: number | null; bySignal: Partial<Record<Signal, number>>; hr: number | null; restingHr: number | null; rmssd: number | null; feeling: number | null; tags: string[]; activities: { id: ActivityId; change: string }[] }
```

## The input interface (inputs agent provides, app agent consumes)

```ts
interface InputProvider {
  id: InputSource
  label: string                                             // "Heart-rate strap or watch"
  gives: Signal[]                                           // what it can measure
  available(): Promise<{ ok: true } | { ok: false; reason: string }>   // e.g. "Safari on iPhone has no Bluetooth. Use the camera or import a file."
}
interface LiveInput extends InputProvider {
  connect(): Promise<LiveConnection>                        // must be called from a click (Web Bluetooth and camera both need a gesture)
}
interface LiveConnection {
  device: string
  onBeat(cb: (beat: { t: number; rr: number | null; hr: number }) => void): () => void
  onQuality(cb: (q: 'good' | 'fair' | 'poor', why: string | null) => void): () => void
  measure(durationS: number, signal?: AbortSignal): Promise<Measurement>
  disconnect(): Promise<void>
}
interface FileInput extends InputProvider {
  accept: string                                            // ".zip,.xml"
  parse(file: File, onProgress?: (fraction: number) => void): Promise<{ measurements: Measurement[]; summary: string }>   // parsed in a Web Worker, never uploaded
}
```

The camera provider is written by the **app** agent (it owns the accuracy check); Bluetooth, Polar H10 and the imports by the **inputs** agent. Both register in `web/src/inputs/registry.ts`. Feature extraction from beats (`hr_mean`, `rmssd`, `sdnn` with artefact rejection: drop RR outside 300–2000 ms and any beat differing > 20% from the median of its neighbours) lives in one shared `web/src/signal/hrv.ts`, written by the inputs agent first thing and used by the camera too.

Activities export `ActivityDef { id, name, job: 'baseline'|'check-in'|'challenge'|'recovery', durationS, device: 'keyboard'|'pointer'|'phone'|'any', Component: (props:{ onDone(r: ActivityResult): void; onCancel(): void; live?: LiveConnection }) => VNode }` from `web/src/activities/index.ts`. They record timing and movement only: never key identities (store `e.code`-free event timings; the typing passage is fixed text so correctness is checked by position, and nothing typed is kept). A test asserts no key value reaches a stored result.

## Scoring rules

- Scores use `web/src/model/score.ts` and `calibrate.ts` unchanged: z-score each feature against the user's `Baseline`, then `readSignal` per signal and `fuse` over the signals actually measured.
- No score before a baseline exists (three resting readings on different days, or one full stress-session rest phase). Until then the result shows the raw numbers and "Baseline 1 of 3".
- A camera measurement counts for heart rate always, and for HRV only at quality `good`. The UI names what was not measured (skin conductance and temperature need a wearable).
- Keyboard and mouse results are shown as change from the user's own calm runs, labelled "change", until a `PersonalModel` for that activity is `ready`.

## Data that never leaves the device

Camera frames, raw ECG, raw imported files, key events. Imports keep only per-window `Measurement`s. Beats are kept only if the user turns it on.

## Amendments (app agent, 30 Sep 2026)

The TypeScript for all of these is in `web/src/contract/`.

- **Vault client** (`contract/vault.ts`): `web/src/vault/index.ts` exports `vault: Vault` with `restore, signUp → {me, recoveryKey}, signIn, signOut, recover, changePassword, regenerateRecoveryKey, sessions, revokeSession, put(kind, id, value), remove(id), list(kind), onChange, sync, status, onStatus, exportSealed, deleteAccount, narrate`. Writes are local first (offline queue) and synced in the background; failures throw a `VaultError` with the API `code` (or `offline` / `crypto`).
- **New endpoint** `POST /api/auth/recovery` for regenerating the recovery key (table above).
- **Settings record**: kind `settings`, id `settings`, value `UserSettings { keepRawBeats: false, aiNotes: false }`. The theme stays per device (localStorage `ss-theme`).
- **Baseline readiness**: `calibration.n` counts readings on distinct local days (or 60-s rest windows from a stress session). A baseline is ready when `n >= 3`. The app keeps one Baseline record per user and adds one reading per day to it; a new baseline replaces it.
- **Inputs**: `LiveInput` and `FileInput` carry `kind: 'live' | 'file'`; `web/src/inputs/registry.ts` exports `INPUTS: (LiveInput | FileInput)[]` (the camera, from `./camera`, is one of them). `LiveConnection` gains optional `onSample` (waveform for the live trace), `battery()` and `onDisconnect`. `connect()` rejects with DOMException names (`NotAllowedError` for a denied permission, `NotFoundError` when no device or camera exists or the chooser was cancelled, `NotSupportedError`).
- **HRV** (`contract/signal.ts`): `web/src/signal/hrv.ts` exports `cleanRR(rr) → {rr, dropped}` and `hrvFeatures(rr) → HrvFeatures | null` (`{hr_mean, rmssd, sdnn, n, dropped}`, null under `MIN_BEATS = 10` clean intervals).
- **Activities**: `web/src/activities/index.ts` exports `ACTIVITIES: ActivityDef[]` (optional `blurb`). `web/src/session/index.ts` exports `StressSessionView({onDone, onCancel, live})` and `SESSION_MINUTES`. `web/src/personal/index.ts` exports `train(activity, sessions)` and `scoreWith(model, metrics)`.
- **Camera quality**: the camera's `quality` is `good` only with the torch on (rear camera, fingertip over lens and flash); without a torch it is at most `fair`, so a webcam never feeds HRV into a score.

## Amendments (inputs agent, 1 Oct 2026)

- **HRV cleaning** (`signal/hrv.ts`): the neighbour median uses up to **5** clean-range beats each side (2 let two adjacent artefacts through). `cleanRR` returns `{rr, dropped}` plus `kept[]` and `rejectedFraction`. Windowed features (`beatFeatures(rr, durationS)`) gate like training: HR needs >= 40% beat coverage, HRV >= 60% and >= 10 successive differences. Also exported: `measurementFromRR`, `measurementFromHr`, `beatQuality`, `windowBeats`, `restingHr` (mean of the lowest quarter of window HRs), `restingHrFromBeats`.
- **Registry**: `INPUTS = [bleHr, camera, appleHealth, fitbit, empaticaE4]`. The camera comes from `./camera.ts` through an eager `import.meta.glob` (any export with `id: 'camera'`), or `registerCamera(p)`; until then a placeholder says it is unavailable. The Polar H10 is not a separate row: any strap named "Polar H10" connected through `bleHr` starts the PMD accelerometer, and its Measurements carry `source: 'polar-h10'` and `acc_std` / `motion`. `polarH10` (chooser filtered to H10s) is exported for completeness.
- **Live connections** from the inputs agent also implement `StatusConnection` (`source`, `status()`, `onStatus()`, `recent(seconds)`), plus the app agent's optional `battery()` and `onDisconnect()`. Bluetooth reconnects after 1, 2, 4, 8, 16 s, then gives up and fires `onDisconnect`. `liveStore` / `useLive()` (`inputs/live-store.ts`) hold the one connection the app is using.
- **Imports**: `parse()` also returns optional `daily: {date, restingHr?, hrv?, hrvKind?}[]` (resting HR, daily HRV). Only the last 90 days before the newest record are kept (at most 20,000 Measurements). Empatica E4 windows are non-overlapping `window_s` windows; EDA, temperature and motion features are a tested port of `training/features.py`.
- **Activities**: every `Component` also accepts optional `RunProps`: `calmRuns` (for `vsBaseline`), `autoStart`, `showResult` (false: `onDone` fires as the run ends), `durationS`, `embedded`, `seed`. `vsBaseline` = z against >= 2 completed calm runs, SD floored at 10% of the mean. Metrics that were not measured are omitted.
- **Stress session**: `StressSessionView` also takes `probe` ('follow-dot' | 'typing' | null, chosen on the intro by default), `calmRuns`, `keepRawBeats`; `onDone(session, extras?)` where `extras.restMeasurements` are the 60-s rest windows (15-s stride, first minute skipped) for the Baseline. Plan: rest 2:30 sit + 0:30 probe; challenge 1:45 colour words + 0:30 probe + 1:45 beat the clock; recovery 3:00 paced breathing. The probe done calm and under challenge is what the personal model learns from; challenge-only activities never get a model (one class).
- **Personal model**: `scoreWith` returns `NaN` when a model feature is missing from the run. On pure noise the contract's ready rule (>= 0.7 on >= 6 held-out runs) still passes about 1 time in 10 at 20 runs; consider requiring more runs later.
