# James TL — WAF-1010 Diagnostics

The active blocker was **Cloudflare WAF error 1010** on the Groq proxy: a real chat
`POST https://vlm-report.vercel.app/api/profiles?k=<secret>` came back `403` with a
plain-text body `error code: 1010`, so James couldn't reach the AI and showed
"Connection hiccup — try again."

## ✅ STATUS: root cause confirmed + fix implemented

`__jamesDiag()` settled it. The isolation matrix (run live in the ReadyMode console):

| Case | Secret in URL | Body | Result |
|------|---------------|------|--------|
| A | fake `hello` | trivial | `400 agents array required` → reached the code |
| **B** | **real** | trivial | **403 ⛔ 1010** |
| C | fake `hello` | messages | `400 agents array required` → reached the code |
| D | real | messages | 403 ⛔ 1010 |
| E | real | full | 403 ⛔ 1010 |

**B = 1010 while C is clean** → the trigger is the **real 40-char secret value sitting
in the URL query string** (Cloudflare's managed rules flag a high-entropy token in a
URL). The `messages[]` body is exonerated. The `k` *param name* is fine — it's the
*value*.

**Fix (shipped in this repo + `vlm-report`):** the secret no longer rides in the URL.

- **Route** now travels on the non-secret `?do=chat` / `?do=audio` params (same
  WAF-safe pattern as `?do=heartbeat`).
- **Chat** carries the secret in the **JSON body** field `k` (injected by `groqChat`);
  stays a `text/plain` simple request, no preflight.
- **Audio** (multipart, can't hold a JSON field) carries the secret in the
  **`X-James-Key` header**; the server's `do_OPTIONS`/`_cors` handle the preflight.
- **Server** (`profiles.py::_handle_llm_proxy`) resolves the secret from query-`k`
  (legacy) **or** `X-James-Key` **or** the JSON body `k`, strips `k` before forwarding
  to Groq, and dispatches the proxy route on `?do=chat|audio`. **Backward compatible**
  — old `?k=` clients still work, so the server can deploy before the client.

Verified locally (8/8 request-shape checks): new body-secret chat, wrong/no secret →
401, legacy `?k=`, bad model → 400, audio header-secret, and heartbeat regression.

### Deploy sequence (order matters, but both are safe)

1. **Server first** — deploy `vlm-report` to Vercel production (`main`). It's
   backward-compatible, so nothing breaks while the old client is still live.
2. **Client** — get `james-readymode.js` onto `@main`, then
   `https://purge.jsdelivr.net/gh/Kikie7/james-tl@main/james-readymode.js`, then
   **fully close and reopen** the ReadyMode tab (re-injection guards block reload).
3. **Verify** on the live page: `__jamesDiag()` — case B should now be non-1010, and
   James should coach without "Connection hiccup." Debug line (`Ctrl+Shift+J`) shows
   `reqs:` climbing with no `waf1010`.

---

## Reference — the hardening changes and how to re-run the probe

The client also gained WAF-aware error surfacing (`groqChat`) and the `__jamesDiag()`
probe. The procedure below is kept for re-diagnosing if anything regresses.

---

## 1. What changed in the client (`james-readymode.js`)

### `groqChat(bodyObj, timeoutMs)` — WAF-aware chat helper
All three LLM call sites (coaching loop, Ask James, post-call debrief) now go
through one helper instead of raw `fetch(...).json()`.

Why it matters: a WAF 1010 is an **HTTP 403 with a non-JSON body**. The old code
called `r.json()` without checking `r.ok`, so parsing threw and the failure was
logged as a generic `fetch:Unexpected token …` — the real cause (403 / 1010) was
lost. `groqChat` now:

- checks `r.ok` **before** parsing;
- on failure, reads the body and writes `groq:<status> [waf1010] <snippet>` to the
  debug line (e.g. `groq:403 waf1010 error code: 1010`);
- increments `dbgReqs` once per request (it was previously never incremented for
  Ask/Debrief and double-counted nowhere — the counter now reflects real requests);
- adds a per-call timeout (coaching 12s, ask 12s, debrief 18s) and **one** retry,
  but only for transient network/timeout errors — never for a deterministic 403.

**See it:** press `Ctrl+Shift+J` in ReadyMode to reveal the debug line. A blocked
request shows the real status and `waf1010` instead of a misleading parse error.

### `window.__jamesDiag()` — isolation probe
A console tool that fires the isolation matrix using the **real in-page constants**
(`JAMES_KEY`, `PROXY_BASE`, `GROQ_MODEL`) so nothing drifts from what James actually
sends. It prints status + body snippet per case, flags `WAF-1010`, and returns / `console.table`s the result.

---

## 2. How to run the isolation test

1. Open ReadyMode in Chrome, open DevTools → Console (must be a real `https` page —
   `curl` from Windows CMD hits the WAF and `chrome://` pages can't fetch).
2. Make sure James is loaded (you'll see `[James]` logs). If a stale build is
   cached, fully close the tab and open a new one (re-injection guards block reload).
3. Run:

   ```js
   __jamesDiag()
   ```

4. Read the matrix it prints.

### The matrix

| Case | Secret in URL | Body shape        | Purpose                         |
|------|---------------|-------------------|---------------------------------|
| A    | fake (`hello`)| `{test:1}`        | control — should pass           |
| B    | **real**      | `{test:1}`        | isolates the secret string      |
| C    | fake (`hello`)| `{messages:[…]}`  | isolates the messages body      |
| D    | **real**      | `{messages:[…]}`  | secret + body together          |
| E    | **real**      | full real payload | the exact request James sends   |

### Interpreting it

- **B = 1010** → the **secret string in the URL** is the trigger.
  Fix: stop putting the secret in the query string — move it into the POST body
  (e.g. `{k:"<secret>", …}`) and have `profiles.py` read it from the body, or
  rename/reshape the param. (Backend change in `vlm-report`.)
- **C or D = 1010** (with B passing) → the **`messages:[{role,content}]` body** is
  the trigger (WAFs flag LLM-payload / prompt-injection patterns).
  Fix: base64-encode the payload client-side and decode it server-side before
  forwarding to Groq, so the WAF only sees an opaque blob. (Client + backend.)
- **Only E = 1010** (A–D all pass) → it's the **combination**; from E, drop one
  field at a time (`reasoning_effort`, `include_reasoning`, `max_tokens`, then
  shrink `messages`) and re-run to find the offending field.
- **A = 1010** → the block is not payload-specific at all; the proxy/path itself is
  being blocked. Re-check the Vercel routing and Cloudflare rules.

> Reminder from the handoff truth table: the `k` param existing, POST method, the
> secret param existing, and the model string `openai/gpt-oss-120b` (slash tested)
> are all confirmed **NOT** the cause. The two unisolated variables are exactly
> **B** (real secret value in URL) and **C/D** (the messages body). This probe
> settles both in one run.

---

## 3. Fallback if the WAF won't budge

Revert `PROXY_BASE` to the Deno proxy `https://jamestl.iaremodelings.deno.net`
(endpoints `/chat`, `/audio`, auth header `x-james-key`) and add a payment card to
Deno Deploy to lift the free-tier throttle. `groqChat` still applies — only the
endpoint/headers change.

---

## 4. Notes

- The base64 route (case C/D outcome) needs a **matching server decode** in
  `vlm-report/api/profiles.py` before switching the client on — deploy the server
  first, or gate it behind a flag, or every request breaks.
- The `MODEL_ALIASES` / `expand_model()` mechanism is harmless and backward-
  compatible but the SLASH test already proved it doesn't fix 1010.
