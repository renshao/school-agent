# School Agent — Architecture

A personal agent for my kids' school logistics. Single household, self-hosted on one server (e.g. a DigitalOcean droplet). Goal: gain real agent-building experience and find the pain points.

Context: see sibling `../ai-startup-ideation` (Firecracker, snapshot/fork, Lightpanda, "separate agent from computer").

## Scope

**v1:** web chat; multiple users (me, later my wife) sharing sessions that cover multiple kids; order lunch via Flexischools; morning routine that checks whether lunch is ordered today and reminds me if not.

**Next:** log into the school web portal, download videos, convert HTML to PDF, and similar tasks.

## Shape

```
 You / wife (browser)
        │ HTTPS + WebSocket/SSE
        ▼
 ┌─────────────────────────── Droplet (host) ────────────────────────────┐
 │  Caddy → Gateway (auth, sessions, live fan-out to all session members) │
 │             │                                                          │
 │   ┌─────────┴────────┐   ┌────────────┐   ┌───────────┐               │
 │   │ Agent runtime    │   │ Scheduler  │   │ Notifier  │               │
 │   │ (LLM loop, one   │   │ (morning   │   │ (push to  │               │
 │   │  turn at a time  │   │  routines) │   │  phone)   │               │
 │   │  per session)    │   └─────┬──────┘   └───────────┘               │
 │   └─────────┬────────┘         │                                      │
 │             ▼                  ▼                                      │
 │        Tool broker: policy · approvals · credentials · audit log      │
 │             │ vsock                                                   │
 │   ┌─────────▼──────────────────────────────┐    SQLite (WAL)          │
 │   │ Sandbox (one per task)                 │    users, kids, sessions,│
 │   │  `http`: policy-limited HTTP client    │    events, memory, jobs, │
 │   │  `browse-*`/`media`: Firecracker microVM│   approvals, audit,     │
 │   │   (Lightpanda / Chromium / ffmpeg)     │    artifacts             │
 │   │  egress allowlist per profile          │                          │
 │   └────────────────────────────────────────┘                          │
 └────────────────────────────────────────────────────────────────────────┘
        LLM API (outbound)            School sites (outbound, from the sandbox only)
```

## Flexischools integration (findings from the spikes in `spike/`)

Flexischools (Australia) is a React + GraphQL SPA, but everything the lunch flow needs is available as plain JSON over HTTP, so **no browser is required for reads**. Lightpanda renders the site fine and is how the API was discovered; it remains the fallback if the API changes.

**Auth.** AWS Cognito (`cognito-idp.ap-southeast-2.amazonaws.com`, public app-client id). `InitiateAuth` with `USER_PASSWORD_AUTH` returns ID/access/refresh tokens (1 h expiry); `REFRESH_TOKEN_AUTH` renews without the password. BFF calls need `Authorization: Bearer <idToken>` (the raw token and the access token are rejected) plus `x-channel: USERPORTAL` and `x-brandid: 8`.

**Endpoints** (all `bffordering.flexischools.com.au` unless noted):

| Tool | Endpoint | Auth |
|---|---|---|
| `list_orders` | `POST /api/v1.0/orders/order-history` `{pageIndex,pageSize,fromDate,toDate}` → `presentOrders` (today), `pastOrders`; per order: student, service, items, total, `orderState` (`Printed` = already sent to the canteen, `Closed` = past) | token |
| `list_orders` (ranges) | same endpoint with `fromDate`/`toDate` (`YYYY-MM-DD`) filters; verified for past ranges (e.g. "yesterday" returns exactly yesterday's orders). No future-dated orders existed to observe how they are returned. | token |
| `get_order` | `GET /api/v1.0/orders/{orderKey}` → items, `totalPrice`, `totalGst`, `orderFee`, `canCancelOrder`, `orderState`, `stateHistory[]` (`New Order` → `Placed` → `Cancelled By User`, with timestamps) | token |
| `place_order` | `POST /api/v2.0/orders` (HTTP 200; response `{orderRequestId, orderId, orderKey, studentKey, supplierServiceKey, supplierKey, supplierName, orderPlaced, error}`). **Exact request body (captured from the app, request blocked before sending):** `{"cartKey":"<guid>","totalCartAmount":6.19,"placeOrderRequests":[{"orderRequestId":"<guid>","studentKey":"…","supplierServiceKey":"…","supplierKey":"…","dueDate":"2026-11-06T10:30:00","orderAmount":5.8,"items":[{"itemKey":"…","quantity":1,"options":[],"questions":[]}],"orderOrigin":"Normal"}]}`. `totalCartAmount` = items + order fee; `orderAmount` = that order's item subtotal; `dueDate` is the service's `dueDate` from `itemlist`. The app sends `x-channel: ORDERINGPORTAL` (the user portal uses `USERPORTAL`), `x-brandid: 8`, and a per-request `x-correlation-id`. `cartKey` and `orderRequestId` look client-generated GUIDs (unverified). Chosen options go in each item's `options` as `{"optionKey":"…","quantity":1,"isExcluded":false,"isDefault":<the menu option's isDefault>}` (captured with Up & Go [flavour] and Ham & Cheese Sandwich [bread, GLUTEN FREE +$1]); an option's price is added into the line, so `orderAmount` = Σ (item price + chosen option prices) and `totalCartAmount` = `orderAmount` + order fee. One order can hold several items. Sold-out options (`inStock:false`, greyed out in the app) must not be sent. | token |
| `cancel_order` (verified with this client) | `DELETE /api/v1.0/orders/{orderKey}`, request body is the orderKey string; HTTP 200, empty response. Only while `canCancelOrder` is true. Refund goes to the Flexischools **wallet**. | token |
| `list_students` | `GET /api/v2.0/service-categories/1/students` → each student with `schoolKey`, `schoolSiteKey` and their `services[]` (service key, supplier key, site keys). One parent login covers all kids. | token |
| `list_service_slots` | `POST /api/v1.0/available-services` with the student's services (each plus `schoolKey`, `schoolSiteKey`) → per service the **exact cutoff** (`cutOffTime` local, `cutOffTimeUtc`), `nextOrderFulfillmentDate`, `supplierDistributionTimeKey` | token |
| `get_order_days` | `POST /api/v1.0/students/{student}/supplierservices/{service}/next-order-fulfillment-dates?includeUnavailableDates=true` → per day `fulfillmentDate`, `hasCutOffTimePassed`, `closureReason`, `supplierDistributionTimeKey` | token |
| `get_menu` | `GET /api/v2.0/suppliers/{supplier}/supplierservices/{service}/itemlist?studentKey=&dueDate=&schoolKey=` → categories → items with server-computed `inStock` for that date | **none** |
| students, services, balance | GraphQL at `servicebff.flexischools.com.au/api/v1.0/graphql/` | token |

**Menu notes.**
- `inStock` already resolves the fortnightly rotation ("Available fortnightly Friday" labels are display text). Normalize from `inStock`, never from labels.
- Daily specials have `itemPrice: 0`; the real price lives in required option sets (e.g. Size: Medium/Small, `minQuantity: 1`). `place_order` must pick valid options and verify the total.
- The student/supplier/service/school keys are GUIDs discovered through authenticated calls; cache them per kid.

**Ordering UI flow** (verified in real Chrome): Home → Order food → student → service → date → items list (deep-linkable URL with `fulfillmentDate`; an "Order again?" sheet offers last time's items) → item dialog (required option sets, quantity) → cart (`/Food/cart`, shows item, **Order Fee $0.39**, total) → Checkout → `POST /api/v2.0/orders` → confirmation. The cart is client-side only (`USER_CART_MULTI` in localStorage; `placeOrderResponse` is stored there after checkout), so there is no server cart to reconcile; `Add Item` makes no request. Order detail page: `/Food/orders/{orderKey}` with Order again / Send receipt / Cancel order (in-page confirm modal, not a native dialog).

**Order lifecycle.** `orderState`: `Placed` (cancellable) → `Printed` (sent to the canteen, no longer cancellable) → `Closed`; or `CancelledByUser`. **Future-dated orders appear in `presentOrders`** (today and later, newest date first), not `pastOrders`; `orderTotal` there includes the order fee ($5.80 item → $6.19). **Cancelled orders stay in the history** with `state=CancelledByUser`, so `list_orders` consumers (e.g. the reminder check) must exclude them.

**Place-order response.** The real `POST /api/v2.0/orders` response is **not** the per-order record the web app keeps in its cart state (our first live placement failed to parse it, yet the order had been placed). The client therefore does not rely on its shape: it looks for the order anywhere in the response (matching `orderRequestId`), and otherwise reconciles against `order-history` (a new active order for that student and service on that date). If the outcome still cannot be confirmed, the error says the order **may have been placed** and how to check, so a blind retry cannot double-order. Lesson: after any write, trust the server's list, not the write's response.

**Lightpanda limitation.** Lightpanda (nightlies 11062 and 11739) can read the whole site but its `Add Item` click does not populate the cart (silent, no console error), so ordering through it fails. Real Chrome works. This is another reason the HTTP path is primary.

**Timing.** Cutoffs are exact and come from `available-services` (`cutOffTime` local, `cutOffTimeUtc`): for the Junior school here, Recess closes at **09:00** and Lunch at **09:30** (Sydney time) on the due day, with fulfilment at 10:30 / 12:30. A ~07:00 reminder on the day therefore leaves about two hours; an optional evening-before check ("nothing ordered for tomorrow") gives more notice. Cutoffs differ per service and school, so always read them from the API instead of hard-coding.

**Still unknown.** whether option prices multiply with quantity > 1 (assumed, not observed), items that ask questions at checkout (`questionSets`; request shape not captured), whether `orderRequestId` makes retries idempotent; refresh-token lifetime; the exact cutoff time per service; behaviour if Flexischools adds MFA; how/when the wallet refund appears (payment was PayPal, the app says refunds go to the wallet).

## Code layout

```
src/flexischools/   the Flexischools client (no LLM, no UI)
  auth.ts           Cognito login + refresh, tokens cached 0600 in .state/ (never logs secrets)
  http.ts           bearer + x-channel/x-brandid headers, one retry on 401, errors carry path only
  schemas.ts        zod schemas for each raw response; failure = API drift (FlexiError "schema")
  normalize.ts      raw -> domain types (pure): inStock availability, price-from, active vs cancelled
  client.ts         listStudents / listServiceSlots / getOrderDays / listOrders / getOrder / getMenu
                    planOrder (validates + builds the exact body, sends nothing) / placeOrder / cancelOrder
  request.ts        by-name requests -> keys (parseItemSpec/resolveLine) and generic option-set validation + pricing
                    (buildOrderItem: stock, required/min/max, sold-out options with alternatives) (pure)
  check.ts          checkOrders: ordered | missing | missed_cutoff | no_order_day (pure)
src/agent/          the LLM loop (SDK tool runner): tools.ts (typed tools over the client), approvals.ts (ApprovalDesk:
                    proposals that only a human approval executes), agent.ts (turns, history, host approve/reject),
                    memory.ts (paused checks and notes: shapes, skipApplies, the [household memory] block)
src/web/            the web chat server (`npm run web`, plain node:http, no framework):
  store.ts          SQLite (node:sqlite, WAL, 0600): append-only event log, web sessions, OAuth logins in progress
  household.ts      the one shared conversation: persists + fans out every event, rebuilds the model's history on
                    restart, one model context per school day, serialized turns, Today strip (cached)
  google.ts         Google sign-in (OIDC code flow + PKCE + nonce + single-use state); server.ts: routes, cookies,
                    CSRF (Origin + JSON), SSE live stream, strict CSP; views.ts: events -> display records; today.ts
web/                the page: index.html, app.js (vanilla, text nodes only), style.css (warm paper, dark mode), login
src/web.ts          entry point; DEPLOY.md: Google OAuth client, systemd, Caddy for school.shao.io
src/chat.ts         `npm run chat`: terminal chat, including the approval prompt
src/cli.ts          `npm run flexi -- <command>`; read commands, plus place/cancel as dry runs unless --yes
test/               node:test with synthetic fixtures (fake names/ids); `npm test`, `npm run typecheck`
spike/              throwaway discovery scripts (Lightpanda, Chrome capture); kept for reference
```

Node 24+ runs the TypeScript directly (type stripping), so there is no build step. `placeOrder` is the only function that spends money; it takes a plan from `planOrder` and verifies by reading the order back. Option sets are handled generically from the menu's own metadata, so flavours, breads and sizes share one code path; only items with checkout questions are still refused.

## Key design decisions

### 1. The agent loop runs on the host, not in the VM
The loop mostly waits on LLM calls and needs the DB and credentials. The sandbox is the disposable "hands": a policy-limited HTTP client for Flexischools, a microVM for browser and media work. The loop calls typed tools (`flexischools.list_orders(kid, range)`, `flexischools.get_menu(kid, date)`, `flexischools.get_order_days(kid)`, `flexischools.place_order(kid, date, item)`, `portal.download(video_id)`, `render.to_pdf(artifact_id)`), never a raw "browse the web" or shell tool. A narrow tool surface is safer and easier to debug.

### 2. Session model (multi-user, multi-kid)
- `session` has many `session_members` (users) and many `session_kids`.
- `events` is an append-only log of user messages, assistant messages, tool calls and results, and approvals. Each event records its author (a specific parent, the agent, or the scheduler).
- Agent turns are serialized per session. If two parents send at once, the messages queue and the agent never runs twice concurrently.
- Memory has three scopes: **kid** (allergies, usual order), **household** (budget, rules), **user** (preferences). A session loads household memory plus memory for the kids attached to it.
- The append-only event log doubles as record/replay material (ideation Idea 2).

### 3. Approval gate outside the model
Ordering spends money. `place_order` returns a pending approval; the chat shows an Approve button; any session member can approve. The broker enforces this, not the prompt. Read-only tools and reminders need no approval. Standing rules ("auto-order the usual Mon–Thu") come later, once trusted.

### 4. The reminder check is a routine, not a chat
The scheduler runs a deterministic job: for each kid, call `get_order_days` (is the target day an order day, has its cutoff passed) and `list_orders` (is there already an order). The LLM is woken only if something is missing, and then only to word the reminder. The result is posted to the household session and pushed to the phone through the notifier (ntfy, Telegram or web push; a web chat cannot ping at 7am). Cutoff is 09:00–09:30 local on the due day (see Timing above), so the primary run is ~07:00 that morning, with an optional evening-before run for the next day. This logic exists as the pure function `checkOrders` (`src/flexischools/check.ts`), exposed as `flexi check`.

### 5. Credentials stay in the broker
Secrets live encrypted on the host and are delivered to the sandbox for a single task. For Flexischools the broker holds a Cognito **refresh token** and mints short-lived ID tokens; the password is needed only for the first login or after the refresh token expires. A sandbox holds no other secrets and can reach only allowlisted hosts (for Flexischools: the Cognito endpoint and `*.flexischools.com.au`; for VMs, tap device plus nftables). A prompt-injected page cannot exfiltrate data or reach the wider internet.

### 6. Sandbox profiles
| Profile | Contents | Used for |
|---|---|---|
| `http` | HTTP client, egress allowlist; a host process or container is enough | Flexischools reads and (likely) ordering |
| `browse-light` | Lightpanda (CDP) | Forms and DOM: portals with no API; Flexischools fallback |
| `browse-full` | Chromium | JS-heavy portals, PDF printing (Lightpanda has no rendering) |
| `media` | yt-dlp, ffmpeg | Video download and conversion |

They can share one rootfs at first and split later. Firecracker is the strongest boundary for Chromium and ffmpeg, the two biggest attack surfaces; Chromium's own sandbox is awkward in containers but unnecessary inside a microVM. Boot from a plain rootfs first; snapshot/restore for fast starts is a later experiment.

### 7. Artifact store
Files produced in the VM (video, PDF) are handed to the host, stored content-addressed, and recorded in SQLite. The agent receives an artifact ID, not a path. The host checks size and type before accepting. The web UI serves artifacts.

### 8. Egress policy
Allowlist per profile and domain. Video CDNs differ from portal domains, so log denied domains and promote them by hand. Tasks on local HTML (e.g. rendering a saved page to PDF) run with no network at all. For simple static HTML, WeasyPrint is a lighter JS-free alternative to Chromium.

### 9. Resource limits
Per-task CPU, memory, disk and wall-clock timeout. Chromium is about 300–500 MB per VM; plan for a droplet of 4 GB or more.

### 10. Session persistence for portals
Either store an encrypted cookie jar in the broker or log in fresh each task. Fresh login is simpler and safer until a portal requires 2FA.

## Risks to check first

1. **Droplet KVM.** Firecracker needs `/dev/kvm`. DigitalOcean droplets generally don't expose nested virtualization (verify with `ls /dev/kvm` on a cheap droplet). Fallbacks: Hetzner or Scaleway bare metal, AWS `.metal`, or gVisor (no KVM needed).
2. **macOS dev.** Firecracker does not run on a Mac. Put the sandbox behind a trait with a `LocalProcess` implementation for dev and `Firecracker` for the server, or develop inside a Linux VM.
3. ~~Lightpanda vs. Flexischools.~~ Resolved by the spikes: Lightpanda handles the site, and the underlying JSON API works over plain HTTP, which is now the primary path.
4. **Firecracker is overkill for the lunch flow.** With the HTTP-first finding, the Firecracker case rests on the later Chromium, ffmpeg and API-less portal work (and the learning goal). A container with seccomp, resource limits and an egress allowlist is a defensible lighter alternative, so keep the sandbox swappable.
5. **Prompt injection grows with capability.** Private data, untrusted content and outbound access together are the risk; the egress allowlist and approval gate are the mitigations.
6. **Terms of service and fragility of the Flexischools API.** It is undocumented, used in place of the official app, and I have not read Flexischools' terms. Expect it to change without notice: normalize responses in code, test against saved fixtures, fail loudly on shape changes, and keep the browser path as a fallback. MFA being added would break the password flow.

## Build order

1. ✅ Spikes (`spike/`): Lightpanda login and menu; API discovery; HTTP-only Cognito login with read-only calls.
1b. ✅ Order flow captured in real Chrome (place, view upcoming, cancel). Exact `POST /api/v2.0/orders` body captured, then **verified over plain HTTP with no browser**: this client placed an Up & Go (Chocolate) order for tomorrow ($4.19) and cancelled it 47 s later (state history New Order → Placed → Cancelled By User).
2. ✅ Plain Flexischools client + CLI in TypeScript (`src/`, no LLM): students, services, days, orders, order, menu, check, and place/cancel (dry-run unless `--yes`). 74 unit tests, including a two-item order with options that matches the body captured from the app. Next: the LLM loop on top of the same functions.
2b. ✅ LLM agent loop (`src/agent/`, `npm run chat`) with the approval gate: the model proposes (`plan_order` / `plan_cancel`), only a human approval executes, re-validated at approval time. 96 tests.
3. ✅ Web chat (`src/web/`, `web/`, `npm run web`): Google sign-in with an email allowlist, one shared household conversation in SQLite (survives restarts), live fan-out over SSE, Today strip, proposal cards with two-tap Approve. 119 tests. Deploy: `DEPLOY.md`. Memory: paused checks (rules + day exceptions, confirmed by a parent) and notes, in SQLite, read by the Today strip, check_orders and the model. 131 tests. Still to do: Web Push.
4. ~~`place_order` with the approval gate.~~ Done in 2b.
5. Scheduler, morning routine, push notifications.
6. Move the runner into Firecracker with the egress allowlist; deploy to the server.
7. `browse-full` profile with PDF render (forces the artifact store).
8. Portal login, then video download.

## Open questions

- Host language: Rust (strength, single binary, matches Firecracker work; hand-roll the Messages API client) vs. TypeScript/Python (faster agent iteration).
- Push channel for reminders: ntfy, Telegram or web push.
- ~~Flexischools accounts~~ Resolved: one parent login covers all kids ("students").
- Cookie jar vs. fresh login for portals.
