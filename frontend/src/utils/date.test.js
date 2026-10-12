import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDate, parseUtcTimestamp } from "./date.js";

test("SQLite UTC timestamps are parsed as UTC instead of browser-local time", () => {
  assert.equal(
    parseUtcTimestamp("2026-10-11 12:00:00").toISOString(),
    "2026-10-11T12:00:00.000Z"
  );
});

test("timestamps with explicit zones keep their instant and invalid dates are not fabricated", () => {
  assert.equal(
    parseUtcTimestamp("2026-10-11T12:00:00.000Z").toISOString(),
    "2026-10-11T12:00:00.000Z"
  );
  assert.equal(parseUtcTimestamp("not-a-date"), null);
  assert.equal(formatDate("not-a-date"), "Date unavailable");
});
