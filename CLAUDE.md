# School Agent: working notes for Claude

A personal agent for Ren's kids' school logistics, self-hosted (e.g. a DigitalOcean droplet), built to gain real agent-building experience and find the pain points. Single household; a second login (Ren's wife) comes later. Sibling dir `../ai-startup-ideation` has the background (Firecracker, microVM sandboxes, Lightpanda); read `ARCHITECTURE.md` here first.

## Status (2026-11-05)

Done and verified against the live Flexischools account:
- **`src/flexischools/`**: a complete, tested client (no LLM, no UI): login/refresh, students, services and exact cutoffs, order days, menu, order list/detail, `planOrder` / `placeOrder` / `cancelOrder`, and the pure reminder logic `checkOrders`.
- **`src/cli.ts`**: `npm run flexi -- <command>` (students, services, days, orders, order, menu, check, place, cancel). `place` and `cancel` are dry runs unless `--yes`.
- **Verified over plain HTTP with no browser**: real placement and cancellation of an order (Up & Go [Chocolate], $4.19, placed then cancelled).
- **`src/agent/`**: the LLM agent loop (2026-11-05): SDK tool runner over 10 typed tools, a host-side approval desk, a terminal chat (`npm run chat`). Smoke-tested live (read-only question, real data).
- **`src/web/` + `web/`**: the web chat (2026-11-05), for school.shao.io: Google sign-in (your two Google accounts, allowlisted via `ALLOWED_USERS`), one shared conversation persisted in SQLite (`.state/school.db`), live updates over SSE, Today strip, proposal cards. Verified locally in Chrome with dev login and live data (one real proposal, rejected). Deploy steps: `DEPLOY.md` (not deployed yet; Ren needs to create the Google OAuth client).
- **Memory** (2026-11-05): paused checks (standing rules and day exceptions) and notes, shared by web and terminal chat. Verified live in Chrome (phone width) with the scratch DB.
- **131 tests** (`npm test`), typecheck clean (`npm run typecheck`). Node 24+ runs the `.ts` directly: no build step.

**Not built yet: the scheduler/reminders, Web Push, the sandbox/Firecracker work.** See "Next" below.

## Run it

```
cp .env.example .env     # FLEXISCHOOL_USERNAME / FLEXISCHOOL_PASSWORD (gitignored; Ren has filled it in)
npm run flexi -- students
npm run flexi -- check --date tomorrow              # exit 1 if lunch is missing
npm run flexi -- menu Alice "Junior Recess" tomorrow
npm run flexi -- place Alice recess tomorrow "Up & Go [Chocolate]"       # dry run
npm run chat -- --user Ren                          # chat with the agent (needs ANTHROPIC_API_KEY in .env)
DEV_LOGIN=1 npm run web                             # web chat on http://localhost:8080, sign in without Google (localhost only)
npm test && npm run typecheck
```
Agent env overrides: `AGENT_MODEL` (default `claude-opus-5-5`), `AGENT_EFFORT` (default `medium`), `SCHOOL_AGENT_USER`. Each chat session logs every event to `.state/sessions/<id>.jsonl`.
Tokens are cached in `.state/flexischools-tokens.json` (0600, gitignored). Names are matched by first name / service substring.

## Hard rules (money and safety)

- **Never run `place --yes` or `cancel --yes` (or call `placeOrder`/`cancelOrder`) without explicit approval from Ren in chat** naming the kid, item(s), date and total. Re-confirm the total even if they approved the item. Dry runs are always fine.
- When a destructive command needs a key, **list keys read-only first and pass the literal key** (a combined command that derived the key was blocked as an unverifiable deletion scope).
- **Never type passwords into login pages.** If a real-Chrome session is logged out, ask Ren to log in. Credentials come from `.env` only and must never be printed or put in errors/logs.
- After any write, **trust the server's order list, not the write's response** (see the place-order gotcha below).
- Cancelled orders stay in history as `CancelledByUser` (`active: false`). They must never count as "ordered".
- Keep real names/keys out of the repo: tests use synthetic fixtures; `spike/out/` (real captures) is gitignored.

## Key facts about Flexischools (details and endpoint table in `ARCHITECTURE.md`)

- Australian service; React + GraphQL SPA, but everything we need is plain JSON over HTTP. Auth is AWS Cognito (`USER_PASSWORD_AUTH`, then refresh tokens); BFF wants `Authorization: Bearer <idToken>` plus `x-channel`/`x-brandid`. The menu (`itemlist`) needs no token.
- One parent login covers all kids. Kids have different schools and services.
- **Exact cutoffs** come from `available-services` (Junior Recess 09:00, Junior Lunch 09:30, Sydney local, on the due day). All dates are school-local (`Australia/Sydney`); `src/flexischools/dates.ts` handles it.
- Menu availability is the server's `inStock` (per item **and per option**, e.g. a sold-out flavour); never parse "Available fortnightly Friday" labels. Daily-special prices live in required option sets; option prices add into the line; the order fee (about $0.39) is added once per order.
- Order states: `Placed` (cancellable) → `Printed` (sent to the canteen) → `Closed`, or `CancelledByUser`. Future orders appear in `presentOrders`.
- **Place-order gotcha:** the real `POST /api/v2.0/orders` response is not the per-order record the web app keeps in its cart. Our first live placement failed to parse it although the order was placed. `placeOrder` therefore finds the result anywhere in the response, else reconciles against `order-history`, else says the order *may have been placed* (so nobody retries blindly and double-orders).

## Code map

```
src/flexischools/  auth.ts http.ts schemas.ts normalize.ts client.ts request.ts check.ts dates.ts types.ts index.ts
src/agent/         agent.ts (loop, turns, host approve/reject) tools.ts (the model's tools) approvals.ts (ApprovalDesk) memory.ts (skips + notes: shapes, pure rules) prompt.ts log.ts
src/cli.ts         the plain CLI
src/web/           store.ts (SQLite) household.ts (shared conversation, restore, fan-out) server.ts (routes, auth, CSRF, SSE) google.ts views.ts today.ts config.ts
web/               index.html app.js style.css login.html login.js icon.svg manifest.webmanifest (no build, no external requests)
src/web.ts         web server entry (`npm run web`)
src/chat.ts        terminal chat: the human approval UI (y/n per proposal, /approve, /reject, /pending, /usage)
test/              node:test, synthetic fixtures (fixtures.ts, helpers.ts)
spike/             throwaway discovery scripts (Lightpanda login/menu, Chrome capture); reference only
```
- `schemas.ts` (zod) validates every raw response; a failure means the API drifted and is a loud `FlexiError("schema")`.
- `request.ts`: `ItemRequest {item, quantity?, choices?: {set?, option}[]}` resolves by name to an `OrderLine` (keys); `buildOrderItem` validates stock, required/min/max option sets and prices generically. **`ItemRequest` is the intended shape of the LLM's `place_order` tool arguments.**
- Classes avoid TS parameter properties (Node type-stripping only supports erasable syntax); imports use `.ts` extensions.

## Gotchas learned

- **Lightpanda** (installed nightly `1.1.0-nightly.11062`; also tried 11739) reads the whole site but its `Add Item` click does not populate the cart (silent), so it cannot place orders. Real Chrome (the Claude in Chrome extension) works; that is how request bodies were captured (page `fetch` was wrapped to log and block the checkout POST, so no order was placed). Only needed if the HTTP path ever breaks.
- The `Order again?` sheet appears on the item list; the web cart is client-side (`USER_CART_MULTI` in localStorage) until checkout.
- **Open question:** the app says refunds go to the Flexischools wallet, but Ren said charges go to PayPal and the wallet balance did not move. Ask Ren what actually happened to the two test charges.
- Unverified: option prices with quantity > 1 (assumed to multiply); items with `questionSets` (checkout questions) are refused because their request shape was never captured.
- The Flexischools API is undocumented and its terms were not reviewed; keep the browser path as a fallback and keep schema/fixture tests current.

## The agent loop (built; how it works)

- **Tool runner** (`client.beta.messages.toolRunner`, `betaZodTool`), `thread: false`: `Agent` owns the append-only history (each reply verbatim, thinking blocks included, then its tool results via the runner's cached `generateToolResponse()`). One runner per user turn, `max_iterations` 12. Turns are serialized per `Agent`.
- **Request:** `claude-opus-5-5`, effort `medium`, no `thinking` param (Opus 5.5 always thinks; disabling is a 400), top-level `cache_control` (auto caching), `fallbacks: "default"` + beta `server-side-fallback-2026-07-01` (server-side refusal fallback). The system prompt is byte-stable; the time and the speaker go in a header on each user turn (`[Fri, 6 Nov 2026, 07:00 · Ren]`).
- **Tools:** list_students, list_service_slots, get_order_days, list_orders, get_order, get_menu, check_orders, plan_order, plan_cancel, list_proposals. They return compact JSON with no internal keys except `order_key`. Tool errors (FlexiError messages, zod validation) go back as `is_error` results.
- **Approval gate = approval executes.** There is no place/cancel tool at all. `plan_order`/`plan_cancel` store a proposal (`P1`, ...) in `ApprovalDesk`; only `Agent.approve(id, human)` (from the chat UI) executes it. Approval re-plans and refuses ("stale") if items/total changed or it became invalid; expires after 30 min; executes at most once; an unconfirmed result is `unknown` (FlexiError kind `outcome_unknown`) and is never retried. The outcome reaches the model as a `[host event]` text block on the next user turn. Proposals are in memory only (lost on restart, which is the safe direction).
- Tests guard this with mutation checks (`test/approvals.test.ts`, `test/agent.test.ts`, fake Messages API in the latter).
- Known rough edge: in `npm run chat`, a line typed while a turn is running is dropped (readline has no pending question). The web chat queues instead.

## The web chat (built; how it works)

- **One household conversation.** Every agent event (user turn, each model reply verbatim, tool results, proposals, decisions, usage) is a row in `events` (SQLite). On start, `Household` rebuilds the model's history for the current thread from the log (`repairHistory` answers a tool call left dangling by a crash), continues proposal ids after the log's highest, and re-delivers approval outcomes the model never saw.
- **One model context per school-local day** (thread = Sydney date). The page shows all days; the model sees today's. Cheap and day-shaped; cross-day memory is the "memory" item, not built.
- **Display records only** go to the browser (`views.ts`): no thinking, tool inputs or prompts. The page renders model text as text nodes (tiny markdown: bold, code, lists, tables). Strict CSP, no external requests.
- **Auth:** Google OIDC code flow (PKCE, nonce, single-use state bound to a cookie); ID token claims checked (iss, aud, exp, nonce, email_verified); `ALLOWED_USERS` maps email to display name, and the display name is the author in the conversation. Sessions: random token cookie (`__Host-sid` on https), sha256 stored, 30 days. POSTs need our Origin and a JSON body.
- **Approve** is `POST /api/proposals/:id/approve` from a signed-in human (two taps in the UI), into `Household.approve` -> `Agent.approve`. Concurrent approvals: one 200, one 409.
- **Live:** `GET /api/stream` (SSE), catch-up from `Last-Event-ID`, plus `status` (who is being answered, queue length) and `today` events. `GET /api/today` is the Today strip (`upcomingDay`: today while something can still be done, else the next order day), cached 60 s.
## Memory (built; how it works)

- **Two tables** in `.state/school.db`: `lunch_skips` (standing rule = no `to_date`, day exception = dates; optional `weekdays`; per child, per service or all) and `notes` (free text, per child or household). Soft delete (`removed_at`/`removed_by`); every change is also an event in the log and a line in the chat.
- **The user just chats.** The model picks the tool: `plan_skip` (proposes; a parent taps **Save** on a card, one tap since it spends nothing), `remember` (saves at once, Undo in the chat), `remove_skip` / `forget` (immediate; removing a skip only makes checks stricter), `list_memory`.
- **Who reads it:** the Today strip and `check_orders` (a paused row is `skipped` / `paused`, never "missing"; an order on a paused day stays "ordered", flagged); the reminder routine must use `findSkip` too. The model gets a `[household memory]` block at the start of each day's conversation; deletions made in the app reach it as `[host event]` notes. The page's "Remembered" panel lists both with delete buttons.
- `npm run chat` opens the same SQLite file for memory, so web and terminal share it.

- Verified in Chrome at phone width (500 px) and desktop. Not verified yet: a real phone (iOS Safari) and real Google sign-in (needs the OAuth client).

## Next (decisions already made)

Model: Opus 5.5 at medium effort for now; a cheaper tier or lower effort may be enough, so decide by testing on real conversations (`/usage` and the session logs show the cost). Remaining architecture intent (full version in `ARCHITECTURE.md`):

1. Tools stay thin wrappers over `FlexiClient`, never a raw browse/shell tool. (Done.)
2. Approval gate outside the model. (Done, see above; the web chat's Approve button must call `Agent.approve`, never anything the model can trigger.)
3. **Session model and memory:** done (event log with authorship, serialized turns, skips + notes). Possible later: per-user preferences, "the usual" order as a structured favourite.
4. **Reminder routine is deterministic, not a chat:** scheduler calls `checkOrders`; the LLM is only used to word the reminder when something is `missing`. Primary run about 07:00 on the day (cutoffs 09:00/09:30), optional evening-before run. Needs a push channel (ntfy / Telegram / web push; undecided).
5. Web chat: done (see above); deploy per `DEPLOY.md`. Then the sandbox work (Firecracker for Chromium/ffmpeg tasks: portal login, video download, HTML to PDF). The Flexischools HTTP client itself needs only an egress-limited process, not a VM. Firecracker needs `/dev/kvm` (DigitalOcean droplets likely lack it; DO's managed MicroVMs product is an alternative; Macs cannot run it, so keep the sandbox behind an interface).

Open questions for Ren: push channel for reminders (Web Push from the web chat is the leading candidate: service worker + VAPID via `web-push`; iOS only delivers it to a Home-Screen PWA, iOS 16.4+; notification actions should open the pending proposal, not approve it); which model tier; deploying (Google OAuth client, DNS for school.shao.io, droplet).

## Conventions

- Commit messages end with the `Co-Authored-By` line given in the session; commit when asked.
- Prefer small typed tools, fixtures + mutation checks for tests that guard money paths, and loud failures over silent fallbacks.
