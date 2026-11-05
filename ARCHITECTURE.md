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
| `place_order` | `POST /api/v2.0/orders` (HTTP 200; response `{orderRequestId, orderId, orderKey, studentKey, supplierServiceKey, supplierKey, supplierName, orderPlaced, error}`). Request body not captured byte-for-byte; the app builds it from its client cart: per order `{orderRequestId (client-generated GUID), date, studentKey, supplierServiceKey, supplierKey, supplierDistributionTimeKey, orderOrigin:"Normal", orderItems:[{supplierItemKey, quantity, options, questions}]}`. **Verify the exact body before relying on it.** | token |
| `cancel_order` | `DELETE /api/v1.0/orders/{orderKey}`, request body is the orderKey string; HTTP 200, empty response. Only while `canCancelOrder` is true. Refund goes to the Flexischools **wallet**. | token |
| `get_order_days` | `POST /api/v1.0/students/{student}/supplierservices/{service}/next-order-fulfillment-dates?includeUnavailableDates=true` → per day `fulfillmentDate`, `hasCutOffTimePassed`, `closureReason`, `supplierDistributionTimeKey` | token |
| `get_menu` | `GET /api/v2.0/suppliers/{supplier}/supplierservices/{service}/itemlist?studentKey=&dueDate=&schoolKey=` → categories → items with server-computed `inStock` for that date | **none** |
| students, services, balance | GraphQL at `servicebff.flexischools.com.au/api/v1.0/graphql/` | token |

**Menu notes.**
- `inStock` already resolves the fortnightly rotation ("Available fortnightly Friday" labels are display text). Normalize from `inStock`, never from labels.
- Daily specials have `itemPrice: 0`; the real price lives in required option sets (e.g. Size: Medium/Small, `minQuantity: 1`). `place_order` must pick valid options and verify the total.
- The student/supplier/service/school keys are GUIDs discovered through authenticated calls; cache them per kid.

**Ordering UI flow** (verified in real Chrome): Home → Order food → student → service → date → items list (deep-linkable URL with `fulfillmentDate`; an "Order again?" sheet offers last time's items) → item dialog (required option sets, quantity) → cart (`/Food/cart`, shows item, **Order Fee $0.39**, total) → Checkout → `POST /api/v2.0/orders` → confirmation. The cart is client-side only (`USER_CART_MULTI` in localStorage; `placeOrderResponse` is stored there after checkout), so there is no server cart to reconcile; `Add Item` makes no request. Order detail page: `/Food/orders/{orderKey}` with Order again / Send receipt / Cancel order (in-page confirm modal, not a native dialog).

**Order lifecycle.** `orderState`: `Placed` (cancellable) → `Printed` (sent to the canteen, no longer cancellable) → `Closed`; or `CancelledByUser`. **Future-dated orders appear in `presentOrders`** (today and later, newest date first), not `pastOrders`; `orderTotal` there includes the order fee ($5.80 item → $6.19). **Cancelled orders stay in the history** with `state=CancelledByUser`, so `list_orders` consumers (e.g. the reminder check) must exclude them.

**Lightpanda limitation.** Lightpanda (nightlies 11062 and 11739) can read the whole site but its `Add Item` click does not populate the cart (silent, no console error), so ordering through it fails. Real Chrome works. This is another reason the HTTP path is primary.

**Timing.** Cutoff for a day is the morning of that day (the services showed "17–18 hrs left" the afternoon before), so a same-morning reminder may arrive after cutoff. An evening-before check ("nothing ordered for tomorrow") is more useful, with the morning run as a last-chance nudge. Verify the exact cutoff time.

**Still unknown.** The exact `POST /api/v2.0/orders` request body (and whether orderRequestId makes retries idempotent); refresh-token lifetime; the exact cutoff time per service; behaviour if Flexischools adds MFA; how/when the wallet refund appears (payment was PayPal, the app says refunds go to the wallet).

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
The scheduler runs a deterministic job: for each kid, call `get_order_days` (is the target day an order day, has its cutoff passed) and `list_orders` (is there already an order). The LLM is woken only if something is missing, and then only to word the reminder. The result is posted to the household session and pushed to the phone through the notifier (ntfy, Telegram or web push; a web chat cannot ping at 7am). Because cutoff is in the morning of the due day, the primary run is the evening before, with a morning last-chance nudge (see Timing above).

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
1b. ✅ Order flow captured in real Chrome (place, view upcoming, cancel). Still to do: replay `POST /api/v2.0/orders` over HTTP with a cancel-after test, capturing the exact body first.
2. CLI agent with `list_orders`, `get_order_days`, `get_menu` over HTTP and the LLM loop, no VM.
3. Web chat: auth, sessions, members and kids, live fan-out.
4. `place_order` with the approval gate.
5. Scheduler, morning routine, push notifications.
6. Move the runner into Firecracker with the egress allowlist; deploy to the server.
7. `browse-full` profile with PDF render (forces the artifact store).
8. Portal login, then video download.

## Open questions

- Host language: Rust (strength, single binary, matches Firecracker work; hand-roll the Messages API client) vs. TypeScript/Python (faster agent iteration).
- Push channel for reminders: ntfy, Telegram or web push.
- ~~Flexischools accounts~~ Resolved: one parent login covers all kids ("students").
- Exact cutoff time per service.
- Cookie jar vs. fresh login for portals.
