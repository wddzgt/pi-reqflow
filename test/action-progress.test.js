import assert from "node:assert/strict";
import test from "node:test";
import { progressContext, reportProgress, publicPreview } from "../src/action-progress.js";

test("incremental public preview decodes incomplete strings without exposing other fields", () => {
  assert.equal(publicPreview('{"reply":"已确认'), "已确认");
  assert.equal(publicPreview('{"reply":"第一行\\n第二行\\u4f60\\u'), "第一行\n第二行你");
  assert.equal(publicPreview(JSON.stringify({ thinking: "private", apiKey: "secret", toolArguments: { path: "private" },
    reply: '业务答复中包含 "summary": "文字"', design: { approach: "复用现有流程" } })),
  '业务答复中包含 "summary": "文字"\n\n复用现有流程');
  assert.equal(publicPreview('{"thinking":"private","toolArguments":"secret"}'), "");
  assert.equal(publicPreview(JSON.stringify({ reply: "文".repeat(6000) })).length, 4000);
});

test("simultaneous actions keep transient progress scoped to their own request", async () => {
  const first = [], second = [];
  await Promise.all([
    progressContext.run(update => first.push(update), async () => {
      await new Promise(resolve => setTimeout(resolve, 5)); reportProgress("first");
    }),
    progressContext.run(update => second.push(update), async () => { reportProgress("second"); }),
  ]);
  reportProgress("outside");
  assert.deepEqual(first.map(row => row.message), ["first"]);
  assert.deepEqual(second.map(row => row.message), ["second"]);
});
