# SafeSpace vault API

`safespace-api.amittal.dev`: a Cloudflare Worker (Hono) on D1 that stores SafeSpace accounts and
end-to-end-encrypted records. The browser encrypts everything; this server keeps ciphertext and
cannot read it. The spec is [`docs/rebuild/contract.md`](../docs/rebuild/contract.md); the browser
side is [`web/src/vault/`](../web/src/vault).

## How the encryption works, in plain words

- Your **password never leaves the browser**. The browser stretches it (PBKDF2, 310,000 rounds, with
  a salt the server keeps for you) into a master secret, and splits that into two keys: an **auth
  key**, which is sent to prove it is you, and a **wrap key**, which never leaves the device.
- Your records are encrypted with a random **data key** made when you sign up. The server keeps two
  locked copies of it: one locked with the wrap key (your password) and one locked with a
  **recovery key** (32 characters in 8 groups, shown once at sign-up).
- The server stores only a slow hash of the auth key (and of the recovery key's auth half), the two
  locked copies, and ciphertext. With a copy of the database, nobody can read a record or learn the
  password without guessing it through 310,000 PBKDF2 rounds per try.
- Each record is sealed with AES-GCM, bound to its id and kind, so the server cannot swap records
  around without the browser noticing.
- Forgot the password: the recovery key unlocks the data key in the browser, which locks it again
  under a new password. Lose both and the data is gone; that is the price of the server not being
  able to read it.
- The server answers the same way for emails with and without accounts (`/api/auth/params` gives a
  made-up but stable salt, `/recover/start` a made-up but stable locked key), so it cannot be used to
  find out who has an account. Sign-up is the exception, as it must be.

## Routes

All JSON. Errors are `{ error, code }` with `code` one of `bad_request`, `unauthenticated`,
`forbidden`, `not_found`, `conflict`, `rate_limited`, `too_large`, `unavailable`, `server`.

| Route | What it does |
|---|---|
| `GET /api/auth/params?email=` | `{salt, iterations}`; a stable fake salt for unknown emails |
| `POST /api/auth/signup` | creates the account, 201 `Me`, sets the cookie; 409 if taken; 20/hour/IP |
| `POST /api/auth/login` | `{email, authKey}` → `Me & {wrappedByPassword}`; 401 generic; 5/min/IP |
| `POST /api/auth/logout` | 204, ends this session |
| `GET /api/auth/me` | `Me & {wrappedByPassword}` or 401 |
| `POST /api/auth/recover/start` | `{email}` → `{wrappedByRecovery}`, always 200 |
| `POST /api/auth/recover` | new password keys via the recovery key; revokes every other session |
| `POST /api/auth/password` | change password; revokes other sessions |
| `POST /api/auth/recovery-key` | replace the recovery key (needs the current authKey) |
| `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` | list devices, sign one out |
| `GET /api/records?since=` | `{records, cursor, more, reset?}`, 500 per page, tombstones included after a cursor |
| `PUT /api/records/:id` | `{kind, iv, ct, baseVersion}` → `{version}`; 409 `{current}` if stale |
| `DELETE /api/records/:id[?baseVersion=]` | 204, leaves a tombstone; 409 if `baseVersion` is stale |
| `GET /api/export` | every live record plus the wrapped keys, as a download |
| `DELETE /api/account` | `{authKey}` → 204, deletes everything |
| `POST /api/narrate` | `{facts}` → `{text, model}` or 503 `unavailable`; 10/hour/user |
| `GET /api/test` | health, no D1 |
| `GET /internal/stats`, `POST /internal/prune` | need `x-internal-key`; otherwise 404 |

Sessions are an HttpOnly cookie `ss_session` (`Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
`Secure` dropped on plain-http local dev). D1 keeps SHA-256 of the token. Using a session moves its
expiry and the cookie's Max-Age forward (at most once an hour). Every POST, PUT and DELETE under
`/api` needs `Content-Type: application/json` and an Origin in `ALLOWED_ORIGINS` (CSRF).

Limits: 64 KB per record (413 `too_large`), 5,000 records and 5 MB per user (507 `too_large` with
`limit: 'records' | 'bytes'`). A daily cron (03:17 UTC) deletes expired sessions, tombstones older
than 90 days and old rate counters; a device whose cursor predates pruned tombstones gets
`reset: true` and a full listing.

Narration tries OpenRouter (free model), then Groq, then Gemini, 8 s each, with a strict prompt (two
or three plain sentences, no diagnosis, at most one practical tip, no talk of being an AI) and checks
the reply before using it. Only numbers, labels and the user's tags are sent; nothing is stored.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 execute safespace --local --file schema.sql
npm run dev            # wrangler dev --port 8789 → http://localhost:8789
```

The web app (`web/`, `npm run dev` on port 5175) talks to it with `VITE_VAULT_URL=http://localhost:8789`
in `web/.env.local`. `http://localhost:5175` is already an allowed origin.

```sh
npm test               # vitest: the Worker on node:sqlite, plus the web client's crypto end to end
npm run typecheck
```

## Deploy

1. `npx wrangler d1 create safespace` and put the printed `database_id` into `wrangler.jsonc`
   (it is a placeholder, `00000000-…`, until then).
2. `npx wrangler d1 execute safespace --remote --file schema.sql`
3. Secrets: `npx wrangler secret put PARAMS_SECRET` (a long random string; changing it later changes
   the fake salts, which is harmless) and `npx wrangler secret put INTERNAL_KEY` (the Switchboard's
   key). Optional, for AI-written notes: `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`.
   Model names can be overridden with the vars `OPENROUTER_MODEL`, `GROQ_MODEL`, `GEMINI_MODEL`.
4. `npm run deploy`. The custom domain `safespace-api.amittal.dev` is created from `routes`.
5. In `web/vercel.json`, add `https://safespace-api.amittal.dev` to the CSP `connect-src`, and set
   `VITE_VAULT_URL` if the host differs.
6. Check: `curl https://safespace-api.amittal.dev/api/test`.

The server-side hash uses 20,000 PBKDF2 rounds (not 100,000): the inputs are 256-bit keys, so rounds
only matter for guessing a password, and the browser already did 310,000 of those. Two hashes at
20k fit the Workers free plan's CPU budget; 100k would not.
