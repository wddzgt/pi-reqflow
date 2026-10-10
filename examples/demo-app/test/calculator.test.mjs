import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/calculator.mjs";

test("add returns the sum", () => {
  assert.equal(add(2, 3), 5);
});
