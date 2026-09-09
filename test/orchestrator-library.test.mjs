import test from "node:test";
import assert from "node:assert/strict";

import {
  LIBRARY_SCHEMA,
  LIBRARY_VERSION,
  MAX_TEMPLATE_HISTORY,
  mergeLibraryData,
  normalizeLibraryData,
  parseLibraryExport,
  serializeLibrary,
} from "../web/js/orchestrator-library.js";

test("normalizes variable records and rejects invalid keys", () => {
  const data = normalizeLibraryData({
    variables: [{ id: "v1", key: "top", text: "white top", tags: ["white", "white"] }],
  }, 100);

  assert.deepEqual(data.variables[0], {
    id: "v1",
    key: "top",
    text: "white top",
    label: "",
    tags: ["white"],
    note: "",
    createdAt: 100,
    updatedAt: 100,
  });
  assert.throws(() => normalizeLibraryData({ variables: [{ key: "上衣", text: "x" }] }), /key|变量/);
});

test("serializes and merges portable library data", () => {
  const current = normalizeLibraryData({
    variables: [{ id: "v1", key: "top", text: "old", updatedAt: 10 }],
  }, 20);
  const incoming = normalizeLibraryData({
    variables: [{ id: "v1", key: "top", text: "new", updatedAt: 30 }],
  }, 20);
  const merged = mergeLibraryData(current, incoming);

  assert.equal(merged.variables[0].text, "new");
  const parsed = parseLibraryExport(serializeLibrary(merged, 40));
  assert.equal(parsed.schema, LIBRARY_SCHEMA);
  assert.equal(parsed.version, LIBRARY_VERSION);
});

test("deduplicates equal variable content and caps template history", () => {
  const current = normalizeLibraryData({
    variables: [{ id: "v1", key: "top", text: "white", label: "white_top", updatedAt: 10 }],
  }, 20);
  const incoming = normalizeLibraryData({
    variables: [{ id: "v2", key: "top", text: "white", label: "white_top", updatedAt: 30 }],
  }, 20);
  const merged = mergeLibraryData(current, incoming);
  assert.equal(merged.variables.length, 1);
  assert.equal(merged.variables[0].id, "v2");

  const history = Array.from({ length: MAX_TEMPLATE_HISTORY + 5 }, (_, index) => ({
    id: `h${index}`,
    name: `template-${index}`,
    body: `{{top}}-${index}`,
    lastUsedAt: index,
  }));
  const data = normalizeLibraryData({ templateHistory: history }, 1000);
  assert.equal(data.templateHistory.length, MAX_TEMPLATE_HISTORY);
  assert.equal(data.templateHistory[0].lastUsedAt, MAX_TEMPLATE_HISTORY + 4);
});

test("rejects malformed export envelopes", () => {
  assert.throws(
    () => parseLibraryExport(JSON.stringify({ schema: "other", version: 1, variables: [], templates: [], templateHistory: [] })),
    /schema|格式|库/i,
  );
  assert.throws(
    () => parseLibraryExport(JSON.stringify({ schema: LIBRARY_SCHEMA, version: 1, variables: "bad", templates: [], templateHistory: [] })),
    /variables|数组|格式/i,
  );
});
