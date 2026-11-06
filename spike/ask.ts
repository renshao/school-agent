// One read-only question to the real agent (no memory DB, nothing approved). Usage: node --env-file=.env spike/ask.ts "question"
import Anthropic from "@anthropic-ai/sdk";
import { Agent, configFromEnv } from "../src/agent/agent.ts";
import { ApprovalDesk } from "../src/agent/approvals.ts";
import { createFlexiClient } from "../src/flexischools/index.ts";
const client = createFlexiClient();
const agent = new Agent({
  anthropic: new Anthropic(), client, desk: new ApprovalDesk(client), config: configFromEnv(process.env),
  onEvent: (e: any) => { if (e.type === "assistant") for (const b of e.message.content) if (b.type === "tool_use") console.log(`  -> ${b.name} ${JSON.stringify(b.input)}`); },
});
const r = await agent.send("Ren", process.argv[2]!);
console.log("\n" + r.text);
