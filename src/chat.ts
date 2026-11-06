// Terminal chat with the agent (a stand-in for the web chat). Usage: npm run chat [-- --user Ren]
//
// Approval happens HERE, in the host, from what a human types: the model can only propose. A proposal is shown with
// the child, service, date, every item and the total, and only "y" (or /approve <id>) places or cancels it.
import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Agent, configFromEnv } from "./agent/agent.ts";
import type { AgentEvent } from "./agent/agent.ts";
import { ApprovalDesk, describeProposal } from "./agent/approvals.ts";
import type { Proposal } from "./agent/approvals.ts";
import { SessionLog } from "./agent/log.ts";
import { createFlexiClient } from "./flexischools/index.ts";
import { Store } from "./web/store.ts";

const HELP = `Commands:
  /approve <id>   approve a proposal (places or cancels it)
  /reject <id>    reject a proposal
  /pending        list proposals waiting for approval
  /usage          tokens used this session
  /quit           exit`;

const dim = (s: string): string => (stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string): string => (stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { user: { type: "string" }, verbose: { type: "boolean", short: "v" } } });
  const user = values.user ?? process.env.SCHOOL_AGENT_USER ?? "Parent";

  const client = createFlexiClient();
  // The same SQLite file as the web chat, so both share what the household asked the assistant to remember.
  const memory = new Store(process.env.SCHOOL_DB ?? join(process.cwd(), ".state", "school.db"));
  const desk = new ApprovalDesk(client, { memory });
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  const log = new SessionLog(join(process.cwd(), ".state", "sessions"), sessionId);

  const onEvent = (e: AgentEvent): void => {
    log.append(e);
    if (e.type === "assistant") {
      // Narration between tool calls, and which tools are being called.
      for (const b of e.message.content) {
        if (b.type === "tool_use") console.log(dim(`  · ${b.name}${values.verbose ? ` ${JSON.stringify(b.input)}` : ""}`));
      }
      if (e.message.stop_reason === "tool_use") {
        const text = e.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
        if (text) console.log(dim(`  ${text}`));
      }
    }
    if (e.type === "tool_results" && Array.isArray(e.message.content)) {
      for (const r of e.message.content) {
        if (r.type === "tool_result" && r.is_error) console.log(dim(`  ! ${typeof r.content === "string" ? r.content : JSON.stringify(r.content)}`.slice(0, 300)));
      }
    }
  };

  const env = process.env;
  const agent = new Agent({
    anthropic: new Anthropic(),
    client,
    desk,
    onEvent,
    config: configFromEnv(env),
    memory,
  });

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  const rl = createInterface({ input: stdin, output: stdout });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const decide = async (p: Proposal, approve: boolean): Promise<void> => {
    try {
      const done = approve ? await agent.approve(p.id, user) : agent.reject(p.id, user);
      console.log(bold(`${done.id}: ${done.status}`) + (done.outcome ? ` · ${done.outcome}` : ""));
    } catch (e) {
      console.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const offer = async (p: Proposal): Promise<void> => {
    console.log(`\n${bold(`Proposal ${p.id}`)}  ${describeProposal(p)}`);
    if (p.kind === "order") for (const w of p.warnings) console.log(`  ⚠ ${w}`);
    const a = (await rl.question(`Approve ${p.id}${p.kind === "order" ? `, ${p.summary.student}, total $${p.summary.total.toFixed(2)}` : ""}? [y = approve / n = reject / Enter = later] `)).trim().toLowerCase();
    if (a === "y" || a === "yes") await decide(p, true);
    else if (a === "n" || a === "no") await decide(p, false);
    else console.log(dim(`  left pending: /approve ${p.id} or /reject ${p.id} (expires ${p.expiresAt.toLocaleTimeString()})`));
  };

  console.log(`School agent · ${agent.config.model} (effort ${agent.config.effort}) · you are ${user} · /help for commands`);
  console.log(dim(`log: ${log.path}`));

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(`\n${user}> `)).trim();
    } catch {
      break; // stdin closed
    }
    if (!line) continue;

    const [cmd, arg] = line.split(/\s+/, 2);
    if (cmd === "/quit" || cmd === "/exit") break;
    if (cmd === "/help") {
      console.log(HELP);
      continue;
    }
    if (cmd === "/pending") {
      const pending = desk.pending();
      console.log(pending.length ? pending.map((p) => `${p.id}  ${describeProposal(p)}`).join("\n") : "(nothing pending)");
      continue;
    }
    if (cmd === "/usage") {
      console.log(`${totals.requests} requests · input ${totals.input} · output ${totals.output} · cache read ${totals.cacheRead} · cache write ${totals.cacheWrite}`);
      continue;
    }
    if (cmd === "/approve" || cmd === "/reject") {
      const p = arg ? desk.get(arg) : undefined;
      if (!p) {
        console.log(`usage: ${cmd} <id>  (see /pending)`);
        continue;
      }
      if (cmd === "/approve") {
        // Show exactly what will happen, and confirm once more.
        console.log(describeProposal(p));
        const a = (await rl.question("Confirm? [y/N] ")).trim().toLowerCase();
        if (a !== "y" && a !== "yes") continue;
      }
      await decide(p, cmd === "/approve");
      continue;
    }
    if (cmd?.startsWith("/")) {
      console.log(`unknown command ${cmd}\n${HELP}`);
      continue;
    }

    try {
      const r = await agent.send(user, line);
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r.usage[k];
      console.log(`\n${r.text}`);
      console.log(dim(`  [${r.usage.requests} req · in ${r.usage.input} + cached ${r.usage.cacheRead} · out ${r.usage.output}]`));
      for (const p of r.proposals) if (p.status === "pending") await offer(p);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) console.log("! Anthropic API key rejected: check ANTHROPIC_API_KEY in .env");
      else if (e instanceof Anthropic.RateLimitError) console.log("! Rate limited by the Anthropic API; try again in a moment");
      else if (e instanceof Anthropic.APIError) console.log(`! Anthropic API error ${e.status}: ${e.message}`);
      else console.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  rl.close();
}

main().catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
