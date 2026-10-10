import { get } from "node:http";
const origin = new URL(process.env.REQFLOW_PUBLIC_ORIGIN);
const request = get("http://127.0.0.1:4173/healthz", {
  headers: { Host: origin.host }, signal: AbortSignal.timeout(3000),
}, (response) => {
  response.resume();
  if (response.statusCode !== 200) {
    process.stderr.write(`Health check failed: ${response.statusCode}\n`);
    process.exitCode = 1;
  }
});
request.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
