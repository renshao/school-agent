# School Agent — Architecture

A personal agent for my kids' school logistics. Single household, self-hosted on one server (e.g. a DigitalOcean droplet). Goal: gain real agent-building experience and find the pain points.

Context: see sibling `../ai-startup-ideation` (Firecracker, snapshot/fork, Lightpanda, "separate agent from computer").

## Scope

**v1:** web chat; multiple users (me, later my wife) sharing sessions that cover multiple kids; order lunch via Flexischool; morning routine that checks whether lunch is ordered today and reminds me if not.

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
 │   │ Firecracker microVM (one per task)     │    users, kids, sessions,│
 │   │  runner + Lightpanda / Chromium / ffmpeg│   events, memory, jobs, │
 │   │  egress allowlist per profile          │    approvals, audit,     │
 │   └────────────────────────────────────────┘    artifacts             │
 └────────────────────────────────────────────────────────────────────────┘
        LLM API (outbound)            School sites (outbound, from the VM only)
```

## Key design decisions

### 1. The agent loop runs on the host, not in the VM
The loop mostly waits on LLM calls and needs the DB and credentials. The VM is the disposable "hands" for browser and media work. The loop calls typed tools (`flexischool.get_orders(kid, range)`, `flexischool.place_order(kid, date, item)`, `portal.download(video_id)`, `render.to_pdf(artifact_id)`), never a raw "browse the web" or shell tool. A narrow tool surface is safer and easier to debug.

### 2. Session model (multi-user, multi-kid)
- `session` has many `session_members` (users) and many `session_kids`.
- `events` is an append-only log of user messages, assistant messages, tool calls and results, and approvals. Each event records its author (a specific parent, the agent, or the scheduler).
- Agent turns are serialized per session. If two parents send at once, the messages queue and the agent never runs twice concurrently.
- Memory has three scopes: **kid** (allergies, usual order), **household** (budget, rules), **user** (preferences). A session loads household memory plus memory for the kids attached to it.
- The append-only event log doubles as record/replay material (ideation Idea 2).

### 3. Approval gate outside the model
Ordering spends money. `place_order` returns a pending approval; the chat shows an Approve button; any session member can approve. The broker enforces this, not the prompt. Read-only tools and reminders need no approval. Standing rules ("auto-order the usual Mon–Thu") come later, once trusted.

### 4. Morning check is a routine, not a chat
The scheduler runs a deterministic job: for each kid, call `get_orders(today)`. The LLM is woken only if something is missing, and then only to word the reminder. The result is posted to the household session and pushed to the phone through the notifier (ntfy, Telegram or web push; a web chat cannot ping at 7am). Whether today is a school day can be inferred from menu availability.

### 5. Credentials stay in the broker
Passwords live encrypted on the host and are delivered to the runner over vsock for a single task. The VM holds no other secrets and can reach only allowlisted hosts (tap device plus nftables). A prompt-injected page cannot exfiltrate data or reach the wider internet.

### 6. Sandbox profiles
| Profile | Contents | Used for |
|---|---|---|
| `browse-light` | Lightpanda (CDP) | Forms and DOM: Flexischool, simple portals |
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
3. **Lightpanda vs. Flexischool.** Lightpanda has partial Web API coverage and no rendering. Spike first: log in, list orders, place one. If it fails, find the HTTP calls the site or app makes and call them directly; keep the tool interface identical either way.
4. **Firecracker is overkill for lunch ordering.** It is justified here by the learning goal and by the later Chromium and ffmpeg work. A container with seccomp, resource limits and an egress allowlist is a defensible lighter alternative, so keep the sandbox swappable.
5. **Prompt injection grows with capability.** Private data, untrusted content and outbound access together are the risk; the egress allowlist and approval gate are the mitigations.

## Build order

1. Spike: Lightpanda → Flexischool, read-only (orders for a day).
2. CLI agent with `get_orders` and the LLM loop, no VM.
3. Web chat: auth, sessions, members and kids, live fan-out.
4. `place_order` with the approval gate.
5. Scheduler, morning routine, push notifications.
6. Move the runner into Firecracker with the egress allowlist; deploy to the server.
7. `browse-full` profile with PDF render (forces the artifact store).
8. Portal login, then video download.

## Open questions

- Host language: Rust (strength, single binary, matches Firecracker work; hand-roll the Messages API client) vs. TypeScript/Python (faster agent iteration).
- Push channel for reminders: ntfy, Telegram or web push.
- Flexischool accounts: one parent login covering all kids, or separate logins.
- Cookie jar vs. fresh login for portals.
