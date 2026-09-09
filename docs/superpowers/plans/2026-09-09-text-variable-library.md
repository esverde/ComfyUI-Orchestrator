# Text Variable Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable multi-variable prompt combinations, browser-local variable/template persistence, and versioned JSON import/export without breaking the current single-variable workflow.

**Architecture:** Keep prompt expansion and filename field generation in the pure `orchestrator-core.js` module. Add a dependency-free `orchestrator-library.js` module for IndexedDB CRUD plus pure JSON normalization/merge helpers. Integrate the library and a native `<dialog>` manager into the existing `orchestrator.js` panel; keep existing panel settings in `localStorage`.

**Tech Stack:** Browser ES modules, IndexedDB, `node:test`, Node.js built-ins, existing ComfyUI `app`/`api` APIs, and the current `cbo-` CSS system.

**Spec:** `docs/superpowers/specs/2026-09-09-text-variable-library-design.md`

## Global Constraints

- Add no npm or runtime dependencies; use IndexedDB, `Blob`, `FileReader`, and `crypto.randomUUID()` where available.
- Preserve the existing `variable + values` configuration and existing filename tokens `{{model}}`, `{{lora}}`, `{{value}}`, `{{index}}`, and `{{seed}}`.
- Persist the content library in IndexedDB; keep panel settings and per-output template overrides in the existing `localStorage` key.
- Use export schema `comfyui-batch-orchestrator-library` version `1`; imports merge by record id and `updatedAt`, then deduplicate equal variable content.
- Variable keys must match `[A-Za-z][A-Za-z0-9_]*`; tags are for filtering and are not automatically emitted into filenames.
- Reject invalid imported data and unknown prompt/file-name placeholders before preview or `/prompt`; do not evaluate imported strings as HTML or code.
- Keep the current max-job guard; the new product is `models × loras × ∏ variable-slot-values`.
- Update `README.md` and `AGENTS.md` when behavior or persistence boundaries change, and do not add `.codegraph/` or build output.

---

### Task 1: Extend the pure expansion engine to multiple variables

**Files:**
- Modify: `test/orchestrator-core.test.mjs`
- Modify: `web/js/orchestrator-core.js:113-260`

**Interfaces:**
- Consumes: existing `expandJobs(prompt, config)`, `countJobs(...dimensions)`, and current model/LoRA config.
- Produces: `expandJobs()` support for `config.variables = [{ key, values: [{ id, text, label, tags }] }]`, yielded `job.variables`, and filename fields such as `top` and `top_label`.

- [ ] **Step 1: Write the failing multi-variable tests**

Add a prompt with two variables and assert both replacements, combination order, independent prompt clones, and short filename labels:

```js
test("expands multiple text variables and filename labels", () => {
  const jobs = [...expandJobs(basePrompt, {
    unetId: "262",
    loraId: "273",
    textId: "264",
    template: "{{top}} with {{bottom}}",
    models: ["one.safetensors"],
    loras: ["style.safetensors"],
    variables: [
      { key: "top", values: [{ id: "t1", text: "white top", label: "white_top", tags: ["white"] }] },
      {
        key: "bottom",
        values: [
          { id: "b1", text: "black shorts", label: "black_shorts", tags: ["black"] },
          { id: "b2", text: "black skirt", label: "black_skirt", tags: ["black"] },
        ],
      },
    ],
    outputs: [{ id: "272", template: "out/{{top_label}}_{{bottom_label}}_{{index}}" }],
  })];

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].prompt["264"].inputs.text, "white top with black shorts");
  assert.equal(jobs[0].prompt["272"].inputs.filename_prefix, "out/white_top_black_shorts_001");
  assert.deepEqual(jobs.map((job) => job.variables.map(({ key, text }) => [key, text])), [
    [["top", "white top"], ["bottom", "black shorts"]],
    [["top", "white top"], ["bottom", "black skirt"]],
  ]);
});
```

Also add assertions that a missing slot value and an undefined `{{missing}}` placeholder throw before a job is yielded, and that the existing single-variable test remains unchanged.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
node --test test/orchestrator-core.test.mjs
```

Expected: the new test fails because `expandJobs()` currently only reads `config.variable` and `config.values`, and filename rendering does not receive per-variable fields.

- [ ] **Step 3: Implement normalized variable slots and replacement**

In `web/js/orchestrator-core.js`, add pure helpers with these contracts:

```js
function normalizeVariableSlots(config) {
  if (Array.isArray(config.variables) && config.variables.length) return config.variables;
  return [{
    key: String(config.variable || "").trim(),
    values: [...(config.values || [])].map((text) => ({ text: String(text), label: "", tags: [] })),
  }];
}

function replacePlaceholders(template, replacements) {
  const source = String(template);
  const names = new Set(Object.keys(replacements));
  for (const name of source.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) {
    if (!names.has(name[1])) throw new Error(`文本模板中没有找到变量 ${name[1]}`);
  }
  return source.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key) => String(replacements[key]));
}
```

Keep `replacePlaceholder(template, variable, value)` as a compatibility wrapper around `replacePlaceholders()` so existing callers and tests remain valid. In `expandJobs()`, validate every key, require at least one value per slot, build the variable product in slot order, replace all placeholders, and populate:

```js
const filenameFields = { model, lora, value, index, seed };
for (const item of combination) {
  filenameFields[item.key] = item.text;
  filenameFields[`${item.key}_label`] = item.label || item.text;
}
```

Yield `variables: combination` in each job and preserve `lora`/`value` compatibility fields.

- [ ] **Step 4: Run the core tests and syntax check**

Run:

```powershell
npm test
node --check web/js/orchestrator-core.js
```

Expected: all existing tests and the new multi-variable tests pass.

- [ ] **Step 5: Commit the core engine**

```powershell
git add test/orchestrator-core.test.mjs web/js/orchestrator-core.js
git commit -m "feat: expand multiple text variables"
```

### Task 2: Add IndexedDB library and JSON migration helpers

**Files:**
- Create: `web/js/orchestrator-library.js`
- Create: `test/orchestrator-library.test.mjs`

**Interfaces:**
- Consumes: normalized variable/template records from the UI and a browser `indexedDB` factory.
- Produces: pure import/export helpers and async CRUD functions for `variables`, `templates`, and `templateHistory`.

- [ ] **Step 1: Write failing pure data tests**

Create tests for these exported functions and constants:

```js
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
  const data = normalizeLibraryData({ variables: [{ id: "v1", key: "top", text: "white top", tags: ["white", "white"] }] }, 100);
  assert.deepEqual(data.variables[0], {
    id: "v1", key: "top", text: "white top", label: "", tags: ["white"], note: "",
    createdAt: 100, updatedAt: 100,
  });
  assert.throws(() => normalizeLibraryData({ variables: [{ key: "上衣", text: "x" }] }), /key|变量/);
});

test("serializes and merges portable library data", () => {
  const current = normalizeLibraryData({ variables: [{ id: "v1", key: "top", text: "old", updatedAt: 10 }] }, 20);
  const incoming = normalizeLibraryData({ variables: [{ id: "v1", key: "top", text: "new", updatedAt: 30 }] }, 20);
  const merged = mergeLibraryData(current, incoming);
  assert.equal(merged.variables[0].text, "new");
  const parsed = parseLibraryExport(serializeLibrary(merged, 40));
  assert.equal(parsed.schema, LIBRARY_SCHEMA);
  assert.equal(parsed.version, LIBRARY_VERSION);
});

test("caps and deduplicates template history", () => {
  const history = Array.from({ length: MAX_TEMPLATE_HISTORY + 5 }, (_, index) => ({
    id: `h${index}`, name: `template-${index}`, body: `{{top}}-${index}`, lastUsedAt: index,
  }));
  const data = normalizeLibraryData({ templateHistory: history }, 1000);
  assert.equal(data.templateHistory.length, MAX_TEMPLATE_HISTORY);
});
```

- [ ] **Step 2: Run the library tests to verify they fail**

Run:

```powershell
node --test test/orchestrator-library.test.mjs
```

Expected: FAIL because the new module and exported helpers do not exist.

- [ ] **Step 3: Implement normalization and JSON helpers**

Define the public constants and pure functions. `normalizeLibraryData()` returns a `LibraryData` envelope containing `schema`, `version`, `variables`, `templates`, and `templateHistory`; storage writes use the three record arrays while JSON export adds the same envelope metadata:

```js
export const LIBRARY_SCHEMA = "comfyui-batch-orchestrator-library";
export const LIBRARY_VERSION = 1;
export const MAX_TEMPLATE_HISTORY = 100;

// normalizeLibraryData(value, now) -> normalized LibraryData
// serializeLibrary(data, now) -> versioned JSON string
// parseLibraryExport(text) -> validated normalized LibraryData
// mergeLibraryData(current, incoming) -> normalized merged LibraryData
```

Normalize arrays, string fields, de-duplicated tags, timestamps, template history ordering, and generated IDs. `parseLibraryExport()` must parse JSON, validate the exact schema/version, and call `normalizeLibraryData()`; it must throw a Chinese-readable error for malformed data. `mergeLibraryData()` must use newer `updatedAt` for equal IDs and remove equal variable records by `key + text + label`.

- [ ] **Step 4: Implement the browser storage adapter**

Use one database and three object stores, created in `onupgradeneeded`:

```js
const DB_NAME = "comfyui-batch-orchestrator-library";
const STORE_NAMES = ["variables", "templates", "templateHistory"];
```

Export async functions with these signatures:

```js
// listLibraryRecords(storeName) -> Promise<LibraryRecord[]>
// putLibraryRecord(storeName, record) -> Promise<void>
// deleteLibraryRecord(storeName, id) -> Promise<void>
// replaceLibraryData(data) -> Promise<void>
```

Reject unknown store names, normalize before writes, and surface `indexedDB` absence as `浏览器不支持本地变量库` instead of silently losing data.

- [ ] **Step 5: Run tests, syntax check, and commit the library module**

```powershell
npm test
node --check web/js/orchestrator-library.js
git add web/js/orchestrator-library.js test/orchestrator-library.test.mjs
git commit -m "feat: add portable text library storage"
```

### Task 3: Add the variable/template manager dialog

**Files:**
- Modify: `web/js/orchestrator.js:1-1000`
- Modify: `web/css/orchestrator.css`

**Interfaces:**
- Consumes: `listLibraryRecords`, `putLibraryRecord`, `deleteLibraryRecord`, `normalizeLibraryData`, `parseLibraryExport`, `serializeLibrary`, and `mergeLibraryData` from `web/js/orchestrator-library.js`.
- Produces: `state.library`, a multi-slot selection config, CRUD controls, tag filtering, template history controls, and JSON import/export actions.

- [ ] **Step 1: Add library state and loading helpers**

Extend the existing state with:

```js
library: { variables: [], templates: [], templateHistory: [], ready: false },
variableSlots: [],
```

Add `loadLibraryState()` that loads the three stores with `Promise.all`, normalizes them, and sets `ready`; on IndexedDB failure, retain an empty in-memory library and show a non-blocking status message. Call it before the first `refresh()` in `setup()`.

- [ ] **Step 2: Add the dialog DOM and event targets**

Extend `buildPanel()` with a native dialog containing these stable IDs:

```text
cbo-variable-manager
cbo-variable-slots
cbo-variable-search
cbo-variable-tag-filter
cbo-variable-records
cbo-template-records
cbo-library-import
cbo-library-export
cbo-library-close
```

Keep the current quick single-variable controls visible. Add a `组合变量` button beside them and a compact slot summary in the main panel. Use `textContent`, `createElement`, and event listeners for user records; do not interpolate record text into `innerHTML`.

- [ ] **Step 3: Implement variable CRUD and tag filtering**

Add UI functions with these responsibilities: `renderVariableRecords()` clears and rebuilds the filtered record list; `openVariableEditor(record)` fills the add/edit form; `saveVariableRecord(form)` validates and persists one normalized record; `removeVariableRecord(id)` confirms and deletes one record; and `filteredVariableRecords()` returns records matching the current search and tag controls.

The editor must validate a non-empty ASCII key and text, normalize comma/newline-separated tags, allow editing `label`, and delete only after an explicit confirmation. Search matches key, text, label, note, and tags; the tag filter is exact after case-folding.

- [ ] **Step 4: Implement slot selection and direct paste**

Each slot row must support add/remove, key editing, selected-record checkboxes, and a value count. A “从当前输入保存” action converts the legacy textarea lines into records using the current key. Selecting a record stores its full record in the slot config so a later library edit does not silently change an already prepared batch.

- [ ] **Step 5: Implement template save/history CRUD**

Add named template records with `name`, `body`, `tags`, `createdAt`, `updatedAt`, and `lastUsedAt`. `saveCurrentTemplate()` updates an existing named record or creates a new one. `recordTemplateUse()` deduplicates by body and caps history at `MAX_TEMPLATE_HISTORY`. Provide load, edit, delete, and clear-history actions. Record history when the user generates a preview or submits a batch, not on every keystroke.

- [ ] **Step 6: Implement JSON import/export**

Export with a browser download:

```js
const blob = new Blob([serializeLibrary(state.library)], { type: "application/json" });
const url = URL.createObjectURL(blob);
// attach a temporary <a download="comfyui-batch-orchestrator-library.json"> and click it
URL.revokeObjectURL(url);
```

Import with a file input, `File.text()`, `parseLibraryExport()`, `mergeLibraryData()`, and `replaceLibraryData()`. Refresh the dialog only after the IndexedDB transaction succeeds; on error leave existing records untouched.

- [ ] **Step 7: Add focused CSS and manually verify the dialog**

Add only `cbo-` rules for the dialog, slot rows, record list, tag chips, empty states, destructive buttons, and import/export controls. Keep the current fixed/floating panel layout and keyboard focus visible. Manually verify: open/close dialog, add/edit/delete a record, filter by tag, select two slots, save/load a template, export, refresh the page, and import in a second browser profile.

- [ ] **Step 8: Commit the manager UI**

```powershell
node --check web/js/orchestrator.js
git diff --check
git add web/js/orchestrator.js web/css/orchestrator.css
git commit -m "feat: add variable and template manager"
```

### Task 4: Integrate multi-variable configuration with preview and submit

**Files:**
- Modify: `web/js/orchestrator.js:606-830`
- Modify: `web/js/orchestrator-core.js` if Task 1 exposes additional field helpers
- Modify: `test/orchestrator-core.test.mjs` for compatibility cases

**Interfaces:**
- Consumes: `state.variableSlots`, legacy `cbo-variable`/`cbo-values`, and `expandJobs()` multi-variable output.
- Produces: one normalized config for preview and submission, with accurate counts and readable variable summaries.

- [ ] **Step 1: Add a compatibility-focused failing test**

Assert that the old configuration still yields one variable and keeps the old fields:

```js
test("keeps the legacy single-variable shape", () => {
  const [job] = expandJobs(basePrompt, {
    unetId: "262", textId: "264", variable: "subject", values: ["cat"],
  });
  assert.equal(job.value, "cat");
  assert.deepEqual(job.variables.map(({ key, text }) => [key, text]), [["subject", "cat"]]);
});
```

- [ ] **Step 2: Normalize UI config and enforce max jobs**

Update `collectConfig()` to prefer `state.variableSlots` when the combination editor has slots; otherwise use the existing `variable` and `values` controls. Calculate:

```js
const variableDimensions = variables.map((slot) => slot.values);
const total = countJobs(models, loras, ...variableDimensions);
```

Reject empty slots, missing template keys, and totals above `state.settings.maxJobs` before creating an iterator.

- [ ] **Step 3: Update preview and task rows**

Show the product dimensions and, for each sample, show each variable label with a short text preview. Keep `job.model`, `job.lora`, and `job.value` in task history for compatibility, and add `job.variables` for the new detail view. Use `{{key_label}}` output fields in the same `renderFilename()` path as submitted jobs.

- [ ] **Step 4: Record template history at the two user actions**

Call `recordTemplateUse()` only from the explicit `生成预览` button after `updatePreview(true)` succeeds, and once before submission begins. Do not call it from the automatic `updatePreview()` input/change listeners, and do not record failed configurations.

- [ ] **Step 5: Run all checks and commit integration**

```powershell
npm test
node --check web/js/orchestrator-core.js
node --check web/js/orchestrator.js
git diff --check
git add web/js/orchestrator.js web/js/orchestrator-core.js test/orchestrator-core.test.mjs
git commit -m "feat: integrate text combinations into batch jobs"
```

### Task 5: Document and validate the end-to-end feature

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test/inspect: `docs/superpowers/specs/2026-09-09-text-variable-library-design.md`

**Interfaces:**
- Consumes: the final UI, core, and library behavior from Tasks 1-4.
- Produces: user-facing instructions and maintained repository guidance.

- [ ] **Step 1: Update README in Chinese and English**

Document the multi-variable syntax, variable record fields, `{{key_label}}` filenames, tag filtering, IndexedDB scope, JSON export/import merge behavior, template history limit, and the difference between preview and submission. Keep the existing single-variable quick path documented.

- [ ] **Step 2: Update AGENTS.md**

Add the new files, data flow, schema boundary, compatibility rules, and manual browser verification limits. State explicitly that static tests do not prove IndexedDB or real ComfyUI rendering.

- [ ] **Step 3: Run the final verification matrix**

```powershell
npm test
node --check web/js/orchestrator-core.js
node --check web/js/orchestrator-library.js
node --check web/js/orchestrator.js
git diff --check
git status --short
```

Then manually verify in a running ComfyUI instance:

```text
1. Existing one-variable workflow previews and submits as before.
2. Two variable slots produce the expected product count and prompt text.
3. Labels appear in output prefixes without the full prompt text.
4. Variable/template CRUD survives a browser refresh.
5. Export from browser A imports into browser B and preserves tags, labels, templates, and history.
6. Malformed JSON does not erase existing library data.
7. Empty selections and max-job overflow block /prompt.
```

- [ ] **Step 4: Commit documentation and final verification**

```powershell
git add README.md
git add -f AGENTS.md
git commit -m "docs: document text variable library"
```
