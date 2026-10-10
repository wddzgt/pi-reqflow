import { promises as fs } from "node:fs";
import path from "node:path";

if (process.env.REQFLOW_PHASE === "initialize") {
  await import("./fake-pi.mjs");
} else if (process.env.REQFLOW_PHASE === "implement") {
  await fs.appendFile(path.join(process.cwd(), "src", "calculator.mjs"), "\nexport const incomplete = true;\n");
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error",
    errorMessage: "simulated model failure", usage: { input: 80, output: 15, cacheRead: 0, cacheWrite: 0,
      cost: { total: 0.03 } } } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  process.exitCode = 1;
} else {
  await import("./fake-pi.mjs");
}
