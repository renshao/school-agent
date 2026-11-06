// School web chat: the household's shared conversation, the Today strip and proposal cards. No framework, no build.
// Everything the model or Flexischools wrote is inserted as text nodes (never innerHTML), so it cannot become markup.

const TZ = "Australia/Sydney";
const PAGE = 300;
const $ = (id) => document.getElementById(id);

/** h("div", { class: "x", onclick: fn }, child, "text") */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// ---------------------------------------------------------------- formatting

const money = (n) => `$${Number(n).toFixed(2)}`;
const ymdNow = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ymdDate = (ymd) => new Date(`${ymd}T12:00:00Z`);
const fmtDay = (ymd, opts) => new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", ...opts }).format(ymdDate(ymd));
const longDay = (ymd) => fmtDay(ymd, { weekday: "long", day: "numeric", month: "long" });
const shortDay = (ymd) => fmtDay(ymd, { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
const timeOf = (iso) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso)).replace(" ", " ");

function addDays(ymd, n) {
  const d = ymdDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Today", "Tomorrow" or "Monday". */
function relDay(ymd) {
  const today = ymdNow();
  if (ymd === today) return "Today";
  if (ymd === addDays(today, 1)) return "Tomorrow";
  return fmtDay(ymd, { weekday: "long" });
}

function untilText(iso) {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (min <= 0) return "cutoff passed";
  if (min < 60) return `${min} min left`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ${min % 60}m left`;
  return `cutoff ${fmtDay(new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso)), { weekday: "short" })} ${timeOf(iso)}`;
}

function avatar(name, small) {
  let n = 0;
  for (const ch of name) n = (n + ch.charCodeAt(0)) % 4;
  return h("span", { class: `avatar c${n + 1}${small ? " small" : ""}`, "aria-hidden": "true" }, name.slice(0, 1).toUpperCase());
}

// ---------------------------------------------------------------- tiny, safe markdown (text nodes only)

function inline(s) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|(?<![\w*])\*[^*\s][^*]*\*(?![\w*]))/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(h("strong", {}, t.slice(2, -2)));
    else if (t.startsWith("`")) out.push(h("code", {}, t.slice(1, -1)));
    else out.push(h("em", {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function renderText(text) {
  const root = h("div", { class: "text" });
  const kind = (l) => (/^\s*\|.*\|\s*$/.test(l) ? "table" : /^\s*[-*•]\s+/.test(l) ? "ul" : /^\s*\d+[.)]\s+/.test(l) ? "ol" : "p");
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    let i = 0;
    while (i < lines.length) {
      const k = kind(lines[i]);
      const run = [];
      while (i < lines.length && kind(lines[i]) === k) run.push(lines[i++]);
      if (k === "ul" || k === "ol") {
        root.append(h(k, {}, run.map((l) => h("li", {}, inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))))));
      } else if (k === "table") {
        const rows = run.filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        const [head, ...body] = rows;
        root.append(h("table", {}, h("thead", {}, h("tr", {}, (head ?? []).map((c) => h("th", {}, inline(c))))), h("tbody", {}, body.map((r) => h("tr", {}, r.map((c) => h("td", {}, inline(c))))))));
      } else {
        const p = h("p");
        run.forEach((l, j) => {
          if (j) p.append(h("br"));
          const heading = /^\s*#{1,6}\s+(.*)$/.exec(l);
          p.append(...(heading ? [h("strong", {}, inline(heading[1]))] : inline(l)));
        });
        root.append(p);
      }
    }
  }
  return root;
}

// ---------------------------------------------------------------- api

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// ---------------------------------------------------------------- state

const state = {
  me: null,
  views: [],
  seen: new Set(),
  maxSeq: 0,
  hasMore: false,
  proposals: new Map(),
  cards: new Map(),
  lastThread: null,
  status: { queued: 0 },
  today: null,
  todayError: null,
  todayOpen: false,
  memory: { skips: [], notes: [] },
};

const log = $("log");
const scroller = $("scroll");
const outbox = h("div", { class: "log outbox" });
log.after(outbox);

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
const toBottom = () => requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));

// ---------------------------------------------------------------- proposal cards

const effective = (p) => (p.status === "pending" && Date.parse(p.expiresAt) <= Date.now() ? "expired" : p.status);

function expiryText(p) {
  const min = Math.ceil((Date.parse(p.expiresAt) - Date.now()) / 60000);
  return min > 1 ? `expires in ${min} min` : "expires in a minute";
}

function resultBox(p, status) {
  const by = p.decidedBy ? ` · ${p.decidedBy}` : "";
  switch (status) {
    case "executing":
      return h("div", { class: "result" }, p.kind === "order" ? "Placing the order…" : "Cancelling…");
    case "done":
      return h("div", { class: "result done" }, `✓ ${p.outcome ?? "Done"}${by}`);
    case "rejected":
      return h("div", { class: "result" }, `Rejected${by}`);
    case "expired":
      return h("div", { class: "result" }, "Expired before anyone approved it. Ask the assistant again if you still want it.");
    case "stale":
      return h("div", { class: "result warn" }, p.outcome ?? "Not placed: it changed since it was proposed.");
    case "unknown":
      return h("div", { class: "result warn" }, `${p.outcome ?? "Outcome unknown."} Check the order list before trying again.`);
    default:
      return h("div", { class: "result bad" }, p.outcome ?? `Not done (${status})`);
  }
}

function renderSkipCard(p, status) {
  const card = h("div", { class: "card skip", "data-id": p.id });
  card.append(
    h("div", { class: "card-head" }, h("span", { class: "card-kind" }, `Pause checks · ${p.id}`), status === "pending" ? h("span", { class: "card-expiry" }, expiryText(p)) : null),
    h("div", { class: "card-title" }, "No order needed"),
    h("ul", { class: "skip-lines" }, p.lines.map((l) => h("li", {}, l.label))),
  );
  if (status !== "pending") {
    const by = p.decidedBy ? ` · ${p.decidedBy}` : "";
    card.append(
      status === "done"
        ? h("div", { class: "result done" }, `✓ Saved${by}. Reminders skip it; it's listed under Remembered.`)
        : status === "rejected"
          ? h("div", { class: "result" }, `Not saved${by}`)
          : resultBox(p, status),
    );
    return card;
  }
  // One tap: this spends nothing, and it can be undone from the Remembered list.
  const save = h("button", { class: "btn primary", type: "button" }, "Save");
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
  save.addEventListener("click", () => decide(p, "approve", save, cancel));
  cancel.addEventListener("click", () => decide(p, "reject", save, cancel));
  card.append(h("div", { class: "actions" }, save, cancel), h("div", { class: "hint" }, "Checks and reminders skip these days once saved."));
  return card;
}

function renderCard(p) {
  const status = effective(p);
  if (p.kind === "skip") return renderSkipCard(p, status);
  const isOrder = p.kind === "order";
  const card = h("div", { class: `card ${p.kind}`, "data-id": p.id });
  const expiry = status === "pending" ? h("span", { class: "card-expiry" }, expiryText(p)) : null;
  card.append(
    h("div", { class: "card-head" }, h("span", { class: "card-kind" }, `${isOrder ? "Order" : "Cancel order"} · ${p.id}`), expiry),
    h("div", { class: "card-title" }, `${p.student} · ${p.service}`),
    h("div", { class: "card-sub" }, longDay(p.date)),
    h(
      "table",
      { class: "lines" },
      h(
        "tbody",
        {},
        p.lines.map((l) => h("tr", {}, h("td", {}, l.label), h("td", { class: "amt" }, l.amount != null ? money(l.amount) : ""))),
        p.fee != null ? h("tr", { class: "fee" }, h("td", {}, "Order fee"), h("td", { class: "amt" }, money(p.fee))) : null,
        h("tr", { class: "total" }, h("td", {}, isOrder ? "Total" : "Order total"), h("td", { class: "amt" }, money(p.total))),
      ),
    ),
    p.warnings.map((w) => h("div", { class: "warning" }, w)),
  );

  if (status !== "pending") {
    card.append(resultBox(p, status));
    return card;
  }

  let armed = false;
  let timer;
  const approve = h("button", { class: `btn ${isOrder ? "primary" : "danger"}`, type: "button" }, isOrder ? `Approve ${money(p.total)}` : "Approve cancellation");
  const reject = h("button", { class: "btn", type: "button" }, "Reject");
  const hint = h("div", { class: "hint" }, "Nothing happens until one of you approves.");
  const reset = () => {
    armed = false;
    approve.classList.remove("armed");
    approve.textContent = isOrder ? `Approve ${money(p.total)}` : "Approve cancellation";
  };
  approve.addEventListener("click", () => {
    if (!armed) {
      // Two taps: a stray tap on a phone must not spend money.
      armed = true;
      approve.classList.add("armed");
      approve.textContent = isOrder ? `Tap again to place ${money(p.total)}` : "Tap again to cancel it";
      timer = setTimeout(reset, 5000);
      return;
    }
    clearTimeout(timer);
    decide(p, "approve", approve, reject);
  });
  reject.addEventListener("click", () => decide(p, "reject", approve, reject));
  card.append(h("div", { class: "actions" }, approve, reject), hint);
  return card;
}

async function decide(p, action, approveBtn, rejectBtn) {
  approveBtn.disabled = rejectBtn.disabled = true;
  if (action === "approve") approveBtn.textContent = p.kind === "order" ? "Placing…" : p.kind === "skip" ? "Saving…" : "Cancelling…";
  try {
    const { proposal } = await api(`/api/proposals/${encodeURIComponent(p.id)}/${action}`, {});
    updateProposal(proposal);
  } catch (e) {
    const card = state.cards.get(p.id);
    if (e.status === 409 || e.status === 404) {
      card?.querySelector(".actions")?.replaceWith(h("div", { class: "result bad" }, e.message));
      card?.querySelector(".hint")?.remove();
    } else {
      approveBtn.disabled = rejectBtn.disabled = false;
      approveBtn.textContent = p.kind === "order" ? `Approve ${money(p.total)}` : p.kind === "skip" ? "Save" : "Approve cancellation";
      card?.append(h("div", { class: "result bad" }, `Could not reach the server: ${e.message}`));
    }
  }
}

function updateProposal(p) {
  state.proposals.set(p.id, p);
  const old = state.cards.get(p.id);
  if (old) {
    const fresh = renderCard(p);
    old.replaceWith(fresh);
    state.cards.set(p.id, fresh);
  }
  renderToday();
}

function flashCard(id) {
  const card = state.cards.get(id);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1600);
  if (state.todayOpen && matchMedia("(max-width: 959px)").matches) toggleToday(false);
}

// ---------------------------------------------------------------- chat log

function renderView(v) {
  const nodes = [];
  if (v.thread !== state.lastThread) {
    const isToday = v.thread === ymdNow();
    nodes.push(h("div", { class: "day" }, isToday ? `Today · ${longDay(v.thread)}` : longDay(v.thread)));
    if (state.lastThread && isToday) nodes.push(h("div", { class: "day-note" }, "The assistant starts each day fresh; it can still look up any order."));
    state.lastThread = v.thread;
  }
  switch (v.kind) {
    case "user": {
      const mine = v.author === state.me.name;
      nodes.push(
        h(
          "div",
          { class: `msg ${mine ? "mine" : "other"}` },
          mine ? null : avatar(v.author, true),
          h("div", { class: "body" }, h("div", { class: "meta" }, mine ? timeOf(v.ts) : `${v.author} · ${timeOf(v.ts)}`), h("div", { class: "bubble" }, v.text)),
        ),
      );
      break;
    }
    case "assistant": {
      const el = h("div", { class: `assistant${v.final ? "" : " interim"}` });
      if (v.text) el.append(h("div", { class: "meta" }, `Assistant · ${timeOf(v.ts)}`), renderText(v.text));
      if (v.steps.length) el.append(h("div", { class: "steps" }, v.steps.map((s) => h("span", { class: "step" }, s))));
      nodes.push(el);
      break;
    }
    case "proposal": {
      const p = state.proposals.get(v.proposal.id) ?? v.proposal;
      state.proposals.set(p.id, p);
      const card = renderCard(p);
      state.cards.set(p.id, card);
      nodes.push(card);
      break;
    }
    case "decision": {
      const p = v.proposal;
      const verb = p.kind === "skip" ? (p.status === "rejected" ? "didn't save" : "saved") : p.status === "rejected" ? "rejected" : "approved";
      const tone = p.status === "done" ? "ok" : p.status === "rejected" ? "" : "bad";
      nodes.push(h("div", { class: `note ${tone}` }, `${p.decidedBy ?? "Someone"} ${verb} ${p.id} · ${timeOf(v.ts)}`));
      break;
    }
    case "error":
      nodes.push(h("div", { class: "error-box" }, v.text));
      break;
    case "memory": {
      const c = v.change;
      const label = { note_added: "Remembered", note_removed: "Forgot", skip_added: "Paused checks", skip_removed: "Checks back on" }[c.action] ?? c.action;
      const line = h("div", { class: `note${c.action === "note_added" ? " ok" : ""}` }, `${label}: ${c.text} · ${c.by}`);
      if (c.action === "note_added" && state.memory.notes.some((n) => n.ref === c.ref)) {
        const undo = h("button", { class: "link undo", type: "button" }, "Undo");
        undo.addEventListener("click", () => forget(c.ref).then(() => undo.remove()));
        line.append(undo);
      }
      nodes.push(line);
      break;
    }
  }
  return nodes;
}

/** Decisions update their proposal's card wherever it is. */
function absorb(v) {
  if (v.kind === "decision") {
    state.proposals.set(v.proposal.id, v.proposal);
    return true;
  }
  return false;
}

function renderAll() {
  state.lastThread = null;
  state.cards.clear();
  state.proposals.clear();
  for (const v of state.views) if (v.kind === "decision") state.proposals.set(v.proposal.id, v.proposal);
  log.replaceChildren(...state.views.flatMap(renderView));
  $("load-earlier").hidden = !state.hasMore;
  updateEmpty();
  renderToday();
}

function addView(v) {
  if (state.seen.has(v.seq)) return;
  state.seen.add(v.seq);
  state.maxSeq = Math.max(state.maxSeq, v.seq);
  state.views.push(v);
  const stick = nearBottom() || (v.kind === "user" && v.author === state.me.name);
  if (absorb(v)) updateProposal(v.proposal);
  if (v.kind === "user" && v.clientId) outbox.querySelector(`[data-client="${CSS.escape(v.clientId)}"]`)?.remove();
  log.append(...renderView(v));
  if (v.kind === "proposal") renderToday();
  updateEmpty();
  if (stick) toBottom();
}

function updateEmpty() {
  $("empty").hidden = state.views.length > 0 || outbox.childElementCount > 0;
}

async function loadEarlier() {
  const oldest = state.views[0]?.seq;
  if (!oldest) return;
  const btn = $("load-earlier");
  btn.disabled = true;
  try {
    const r = await api(`/api/history?before=${oldest}`);
    const older = r.events.filter((v) => !state.seen.has(v.seq));
    older.forEach((v) => state.seen.add(v.seq));
    state.views = [...older, ...state.views];
    state.hasMore = r.hasMore;
    const before = scroller.scrollHeight;
    renderAll();
    scroller.scrollTop += scroller.scrollHeight - before;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- composer

const input = $("input");
const sendBtn = $("send");
const coarse = matchMedia("(pointer: coarse)").matches;

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  sendBtn.disabled = !input.value.trim();
}

function setComposer(text) {
  input.value = text;
  autosize();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

async function send(text, existing) {
  const clientId = existing?.dataset.client ?? (crypto.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(36).slice(2)}`);
  const status = h("div", { class: "status" }, "Sending…");
  const bubble =
    existing ??
    h("div", { class: "msg mine pending", "data-client": clientId }, h("div", { class: "body" }, h("div", { class: "bubble" }, text), status));
  if (existing) {
    existing.classList.remove("failed");
    existing.classList.add("pending");
    existing.querySelector(".status").replaceWith(status);
  } else outbox.append(bubble);
  updateEmpty();
  toBottom();
  try {
    await api("/api/messages", { text, clientId });
    status.textContent = state.status.answering ? "Waiting for the assistant…" : "Sent";
  } catch (e) {
    bubble.classList.remove("pending");
    bubble.classList.add("failed");
    const retry = h("button", { class: "link", type: "button", onclick: () => send(text, bubble) }, "Retry");
    status.replaceChildren(`Not sent: ${e.message}. `, retry);
  }
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autosize();
  send(text);
});
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

const CHIPS = ["What's missing for tomorrow?", "What's on the lunch menu tomorrow?", "Show this week's orders", "When are the cutoffs?"];
$("chips").replaceChildren(...CHIPS.map((c) => h("button", { class: "chip", type: "button", onclick: () => send(c) }, c)));

// ---------------------------------------------------------------- status (assistant working)

function renderStatus() {
  const s = state.status;
  const typing = $("typing");
  typing.hidden = !s.answering;
  if (s.answering) {
    const who = s.answering === state.me.name ? "Working on it" : `Answering ${s.answering}`;
    $("typing-text").textContent = `${who}…${s.queued ? ` (${s.queued} more waiting)` : ""}`;
    if (nearBottom()) toBottom();
  }
}

// ---------------------------------------------------------------- today strip

function toggleToday(open = !state.todayOpen) {
  state.todayOpen = open;
  $("today").classList.toggle("open", open);
  $("today-toggle").setAttribute("aria-expanded", String(open));
}
$("today-toggle").addEventListener("click", () => toggleToday());

async function loadToday(refresh = false) {
  try {
    state.today = await api(`/api/today${refresh ? "?refresh=1" : ""}`);
    state.todayError = null;
  } catch (e) {
    state.todayError = e.message;
  }
  renderToday();
}

function kidRow(r, date) {
  const mark = { ordered: "✓", missing: "!", missed_cutoff: "–", no_order_day: "–", skipped: "–" }[r.status] ?? "?";
  const detail = h("div", { class: "kid-detail" });
  if (r.status === "ordered") {
    detail.append(h("span", {}, r.items.join(", ") || "Ordered"));
    if (r.total != null) detail.append(h("span", { class: "amount" }, money(r.total)));
  } else if (r.status === "missing") {
    detail.append(h("span", {}, `Not ordered${r.cutoffUtc ? ` · ${untilText(r.cutoffUtc)}` : ""}`));
    detail.append(h("button", { class: "order-btn", type: "button", onclick: () => setComposer(`Order ${r.service.toLowerCase()} for ${r.student} for ${relDay(date) === "Today" || relDay(date) === "Tomorrow" ? relDay(date).toLowerCase() : longDay(date)}: `) }, "Order"));
  } else if (r.status === "skipped") {
    detail.append(h("span", {}, `No order needed · ${r.skip?.reason ?? "paused"}`));
  } else if (r.status === "missed_cutoff") {
    detail.append(h("span", {}, "Not ordered · cutoff passed"));
  } else {
    detail.append(h("span", {}, r.closureReason || "No ordering this day"));
  }
  if (r.skip && r.status === "ordered") detail.append(h("span", { class: "skip-warn" }, `Marked “${r.skip.reason}”, but an order exists`));
  return h("li", { class: `kid ${r.status}` }, h("span", { class: "mark", "aria-hidden": "true" }, mark), h("div", { class: "kid-line" }, h("span", { class: "kid-name" }, r.student), h("span", { class: "kid-service" }, r.service)), detail);
}

function renderToday() {
  $("hdr-date").textContent = longDay(ymdNow());
  const t = state.today;
  const pending = [...state.proposals.values()].filter((p) => effective(p) === "pending");

  $("today-title").textContent = t ? `${relDay(t.date)} · ${shortDay(t.date)}` : "Today";
  $("today-rows").replaceChildren(...(t ? t.rows.map((r) => kidRow(r, t.date)) : []));
  $("today-error").hidden = !state.todayError;
  $("today-error").textContent = state.todayError ? `${state.todayError}` : "";
  $("today-updated").textContent = t ? `Checked ${timeOf(t.checkedAt)}` : "";

  $("today-pending").hidden = !pending.length;
  $("today-pending-list").replaceChildren(
    ...pending.map((p) =>
      h("li", {}, h("button", { type: "button", onclick: () => flashCard(p.id) }, p.kind === "skip" ? `${p.id} · Pause checks for ${p.student}` : `${p.id} · ${p.kind === "order" ? "Order" : "Cancel"} for ${p.student} · ${money(p.total)}`)),
    ),
  );

  // One line for phones.
  const summary = $("today-summary-text");
  if (!t && !state.todayError) return;
  const parts = [h("strong", {}, t ? `${relDay(t.date)} ${shortDay(t.date)}` : "Today")];
  if (state.todayError) parts.push(h("span", { class: "pill bad" }, "can't check"));
  else {
    const missing = t.rows.filter((r) => r.status === "missing").length;
    const ordered = t.rows.filter((r) => r.status === "ordered").length;
    if (missing) parts.push(h("span", { class: "pill bad" }, `${missing} missing`));
    else if (ordered || t.rows.some((r) => r.status === "skipped")) parts.push(h("span", { class: "pill good" }, "all set"));
  }
  if (pending.length) parts.push(h("span", { class: "pill wait" }, `${pending.length} to approve`));
  summary.replaceChildren(...parts);
}
$("today-refresh").addEventListener("click", () => loadToday(true));

// ---------------------------------------------------------------- memory panel

async function forget(ref) {
  try {
    const r = await api(`/api/memory/${encodeURIComponent(ref)}/delete`, {});
    state.memory = r.memory;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  renderMemory();
}

function memoryItem(ref, text, by, what) {
  const del = h("button", { class: "del", type: "button", title: `Delete ${what}`, "aria-label": `Delete ${what}: ${text}` }, "×");
  del.addEventListener("click", () => {
    del.disabled = true;
    forget(ref).catch(() => (del.disabled = false));
  });
  return h("li", {}, h("span", { class: "what" }, text, h("span", { class: "by" }, `${ref} · added by ${by}`)), del);
}

function renderMemory() {
  const { skips, notes } = state.memory;
  $("memory-skips").replaceChildren(...skips.map((s) => memoryItem(s.ref, s.text, s.by, "paused check")));
  $("memory-notes").replaceChildren(...notes.map((n) => memoryItem(n.ref, n.text, n.by, "note")));
  $("memory-skips-box").hidden = !skips.length;
  $("memory-notes-box").hidden = !notes.length;
  $("memory-empty").hidden = Boolean(skips.length || notes.length);
}

// ---------------------------------------------------------------- live stream

let source;
function connect() {
  source?.close();
  source = new EventSource(`/api/stream?after=${state.maxSeq}`);
  source.onopen = () => ($("conn").hidden = true);
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.kind === "event") addView(e.event);
    else if (e.kind === "status") {
      state.status = e;
      renderStatus();
    } else if (e.kind === "memory") {
      state.memory = e.memory;
      renderMemory();
    } else if (e.kind === "today") {
      state.today = e.today;
      state.todayError = null;
      renderToday();
    }
  };
  source.onerror = () => {
    $("conn").hidden = false;
    if (source.readyState === EventSource.CLOSED) {
      // Not a plain network blip (e.g. signed out, server restarting): check the session, then reconnect.
      setTimeout(() => api("/api/me").then(connect, () => setTimeout(connect, 5000)), 3000);
    }
  };
}

// ---------------------------------------------------------------- user menu

const userBtn = $("user-btn");
const menu = $("user-menu");
userBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  userBtn.setAttribute("aria-expanded", String(!menu.hidden));
});
document.addEventListener("click", () => {
  menu.hidden = true;
  userBtn.setAttribute("aria-expanded", "false");
});
$("sign-out").addEventListener("click", async () => {
  await api("/auth/logout", {}).catch(() => {});
  location.href = "/login";
});

// ---------------------------------------------------------------- start

async function start() {
  state.me = await api("/api/me");
  $("user-name").textContent = state.me.name;
  $("user-email").textContent = state.me.email;
  $("user-avatar").replaceWith(avatar(state.me.name));

  state.memory = await api("/api/memory");
  renderMemory();
  const r = await api("/api/history");
  for (const v of r.events) state.seen.add(v.seq);
  state.views = r.events;
  state.maxSeq = r.lastSeq;
  state.hasMore = r.hasMore;
  state.status = r.status;
  renderAll();
  renderStatus();
  scroller.scrollTop = scroller.scrollHeight;
  connect();
  loadToday();

  // Countdowns and expiries move on their own.
  setInterval(() => {
    for (const p of state.proposals.values()) {
      const card = state.cards.get(p.id);
      if (!card) continue;
      if (p.status === "pending" && effective(p) === "expired") updateProposal(p);
      else if (p.status === "pending") card.querySelector(".card-expiry")?.replaceChildren(expiryText(p));
    }
    renderToday();
  }, 20_000);
  setInterval(() => document.visibilityState === "visible" && loadToday(), 5 * 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && loadToday());
}

$("load-earlier").addEventListener("click", loadEarlier);
autosize();
start().catch((e) => {
  if (e.message !== "Signed out") $("log").replaceChildren(h("div", { class: "error-box" }, `Could not load the chat: ${e.message}`));
});
