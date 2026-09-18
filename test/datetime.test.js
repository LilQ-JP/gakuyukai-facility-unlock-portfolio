import test from "node:test";
import assert from "node:assert/strict";
import { parseJapanDateTimeLocal } from "../src/datetime.js";

test("parseJapanDateTimeLocal treats reservation input as Japan time regardless of server timezone", () => {
  assert.equal(
    parseJapanDateTimeLocal("2030-05-01T10:30")?.toISOString(),
    "2030-05-01T01:30:00.000Z"
  );
});

test("parseJapanDateTimeLocal rejects malformed and impossible dates", () => {
  assert.equal(parseJapanDateTimeLocal(""), null);
  assert.equal(parseJapanDateTimeLocal("2030-02-30T10:30"), null);
  assert.equal(parseJapanDateTimeLocal("2030-05-01 10:30"), null);
});
