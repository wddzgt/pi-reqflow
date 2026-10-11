import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { localRuntimeStatus, startLocalRuntime, stopLocalRuntime } from "../src/local-runtime.js";
import { firstVerificationQuality, firstDeliveryQuality } from "../src/admission.js";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reqflow-runtime-"));
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  t.after(async () => { await stopLocalRuntime(directory); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, port, url: `http://127.0.0.1:${port}/` };
}

test("local runtime starts real services, reuses them and stops the process group", async t => {
  const { directory, port, url } = await fixture(t);
  const command = [process.execPath, "-e", `require('node:http').createServer((req,res)=>res.end('local acceptance')).listen(${port},'127.0.0.1')`];
  const result = await startLocalRuntime(directory, directory, [{ name: "web", command, url }], directory, []);
  assert.equal(result.status, "running");
  assert.equal(await (await fetch(url)).text(), "local acceptance");
  assert.deepEqual((await startLocalRuntime(directory, directory, [{ name: "web", command, url }], directory, [])).services,
    result.services);
  assert.equal((await stopLocalRuntime(directory)).status, "stopped");
  assert.equal(localRuntimeStatus(directory).status, "stopped");
  await assert.rejects(fetch(url), /fetch failed/);
});

test("startup failure records output, closes all services and permits a clean retry", async t => {
  const { directory, url } = await fixture(t);
  const command = [process.execPath, "-e", "console.error('missing local dependency');process.exit(2)"];
  const error = await startLocalRuntime(directory, directory, [{ name: "bad", command, url }], directory, [])
    .then(() => assert.fail("Startup must fail"), error => error);
  assert.match(error.message, /missing local dependency/);
  assert.equal(localRuntimeStatus(directory).status, "stopped");
  assert.match(await fs.readFile(error.runtime.services[0].logFile, "utf8"), /missing local dependency/);
  assert.equal((await startLocalRuntime(directory, directory, [], directory, [])).status, "not_applicable");
});

test("an occupied port cannot be mistaken for successful startup", async t => {
  const { directory, port, url } = await fixture(t);
  const occupied = createServer((req, res) => res.end("different app"));
  await new Promise(resolve => occupied.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  await assert.rejects(startLocalRuntime(directory, directory,
    [{ name: "web", command: [process.execPath, "-e", "throw Error('must not execute')"], url }], directory, []), /端口已占用/);
  assert.equal(await (await fetch(url)).text(), "different app");
  assert.deepEqual(await fs.readdir(directory), []);
});

test("unhealthy startup times out and stops every service without discarding its logs", async t => {
  const { directory, port, url } = await fixture(t);
  const command = [process.execPath, "-e", `require('node:http').createServer((req,res)=>{res.statusCode=503;res.end('not ready')}).listen(${port},'127.0.0.1');console.log('unhealthy service')`];
  const error = await startLocalRuntime(directory, directory, [{ name: "web", command, url }], directory, [], 400)
    .then(() => assert.fail("Unhealthy service must fail"), error => error);
  assert.match(error.message, /未就绪.*web/s);
  assert.match(await fs.readFile(error.runtime.services[0].logFile, "utf8"), /unhealthy service/);
  await assert.rejects(fetch(url), /fetch failed/);
});

test("manual validation pending is excluded from automated pass-rate metrics", () => {
  const pending = { events: [{ type: "implemented", detail: { telemetry: { developmentChecks: [{ status: "manual_pending" }] } } },
    { type: "verified", detail: { checks: [], verificationMode: "manual_pending" } }] };
  assert.equal(firstVerificationQuality([pending]).sampleSize, 0);
  assert.equal(firstDeliveryQuality([pending]).sampleSize, 0);
  assert.equal(firstVerificationQuality([pending]).rate, null);
});
