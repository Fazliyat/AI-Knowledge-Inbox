import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanCitationMarkers,
  extractCitationMetadata,
  isCitationMarker,
} from "./citation.js";

test("raw [SOURCE id=... title=\"...\"] markers are removed from displayed answer", () => {
  const rawAnswer = 'Your application uses Node.js 24.15.0 [SOURCE id=98 title="Note"].';
  const cleaned = cleanCitationMarkers(rawAnswer);
  assert.equal(cleaned, "Your application uses Node.js 24.15.0.");
});

test("multiple source markers and comma-separated citations are removed cleanly", () => {
  const rawAnswer =
    'Based on your saved materials, your application uses **SQLite** for persistent database storage [SOURCE id=98 type=note title="Note"], [SOURCE id=82 type=note title="Note"].';
  const cleaned = cleanCitationMarkers(rawAnswer);
  assert.equal(
    cleaned,
    "Based on your saved materials, your application uses **SQLite** for persistent database storage."
  );
});

test("multiple bulleted citations across lines are handled correctly", () => {
  const rawAnswer =
    "Based on your saved materials:\n\n* **Node.js version:** Your application uses **Node.js 24.15.0** [SOURCE id=98 title=\"Note\"].\n* **Frontend framework:** Your application uses **React with Vite** [SOURCE id=98 title=\"Note\"].";
  const cleaned = cleanCitationMarkers(rawAnswer);
  assert.equal(
    cleaned,
    "Based on your saved materials:\n\n* **Node.js version:** Your application uses **Node.js 24.15.0**.\n* **Frontend framework:** Your application uses **React with Vite**."
  );
});

test("handles markers with titles containing spaces and varied quote styles", () => {
  const variations = [
    'Uses SQLite [SOURCE id=98 title="Production Note with Spaces"].',
    "Uses SQLite [SOURCE id=98 title='Production Note with Spaces'].",
    'Uses SQLite [SOURCE id=98 type=note title="Production Note"].',
    'Uses SQLite [SOURCE id="98" title="Production Note"].',
    "Uses SQLite [SOURCE id=98].",
    "Uses SQLite [SOURCE id=98 /].",
    "Uses SQLite [/SOURCE].",
  ];

  for (const raw of variations) {
    assert.equal(cleanCitationMarkers(raw), "Uses SQLite.");
  }
});

test("handles shorthand markers and parenthetical source references", () => {
  const variations = [
    "Uses SQLite [SOURCE #98].",
    "Uses SQLite [SOURCE: 98].",
    "Uses SQLite [SOURCE 98].",
    "Uses SQLite [SOURCE id: 98].",
    "Uses SQLite (Source #98).",
    "Uses SQLite (Source 98).",
    "Uses SQLite (Note #98).",
    "Uses SQLite (see Source #98).",
  ];

  for (const raw of variations) {
    assert.equal(cleanCitationMarkers(raw), "Uses SQLite.");
  }
});

test("answers without citations are unaffected", () => {
  const plainAnswer = "Here is a general explanation of how SQLite works under concurrent transactions.";
  assert.equal(cleanCitationMarkers(plainAnswer), plainAnswer);
});

test("preserves legitimate brackets and non-citation bracketed content", () => {
  const answerWithBrackets =
    "Here is an array: [1, 2, 3] and an index lookup arr[i]. Check [SOURCE_CODE in repository].";
  assert.equal(cleanCitationMarkers(answerWithBrackets), answerWithBrackets);
});

test("cleans parenthetical citation markers without leaving empty parentheses", () => {
  const answer = "Your application uses SQLite ([SOURCE id=98 title=\"Note\"]).";
  assert.equal(cleanCitationMarkers(answer), "Your application uses SQLite.");

  const answerWithSee = "Your application uses SQLite (see [SOURCE id=98 title=\"Note\"]).";
  assert.equal(cleanCitationMarkers(answerWithSee), "Your application uses SQLite.");
});

test("extractCitationMetadata extracts full metadata correctly", () => {
  const meta = extractCitationMetadata('SOURCE id=98 type=note title="Knowledge Base Note" url=https://example.com');
  assert.equal(meta.id, 98);
  assert.equal(meta.type, "note");
  assert.equal(meta.title, "Knowledge Base Note");
  assert.equal(meta.url, "https://example.com");
});

test("isCitationMarker differentiates real citations from general brackets", () => {
  assert.equal(isCitationMarker('SOURCE id=98 title="Note"'), true);
  assert.equal(isCitationMarker("SOURCE id=82"), true);
  assert.equal(isCitationMarker("/SOURCE"), true);
  assert.equal(isCitationMarker("1, 2, 3"), false);
  assert.equal(isCitationMarker("SOURCE_CODE in repository"), false);
  assert.equal(isCitationMarker("NOTE: reminder to check later"), false);
});
