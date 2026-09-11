# ComfyUI Batch Orchestrator

A local batch-job orchestration extension for ComfyUI. It reads the executable workflow on the current canvas, lets you select multiple UNET models and LoRAs, replaces one or more text variables with reusable values, and expands the combinations as a model × LoRA × text-slot Cartesian product.

**English** · [简体中文](README.zh-CN.md)

## Overview

It runs inside ComfyUI as a frontend extension rather than as a separate web service. It inserts a `Batch` button group into the ComfyUI topbar that opens the panel, and can:

- Read the current canvas as an API workflow.
- Discover enabled `UNETLoader`, `LoraLoaderModelOnly`, positive `CLIPTextEncode`, and nameable output nodes.
- Load model choices from the `UNETLoader` node definition and allow multi-selection.
- Load LoRA choices from the `LoraLoaderModelOnly` node definition and allow folder-based multi-selection.
- Replace a `{{variable}}` placeholder in a text template.
- Generate one job for every model/LoRA/value combination; workflows without a LoRA node keep the model/value behavior.
- Add any number of variables directly in the panel, such as `top × bottom × shoes`, with short filename labels, tags, and notes for each value.
- Save a whole set of variables as a named combination and load it back in one click.
- Persist variables, combinations, named templates, and up to 100 recent template uses in browser-local IndexedDB.
- Export and import a versioned JSON library for migration between browsers or ComfyUI installations.
- Configure a separate filename-prefix template for each output node.
- Show a local preview before submission; the number of jobs shown is configurable.
- Provide manual `Locate` buttons for UNET, CLIP, and output nodes.
- Exclude CLIP text nodes identified as negative conditioning.
- Track task state per batch, with cancel for unfinished jobs and retry for failed ones.

For example, 3 selected models, 2 LoRAs, 2 top values, and 3 bottom values produce 36 independent jobs.

Each job is a temporary in-memory copy of the API JSON. The extension does not create a new visual workflow and does not modify or save the current canvas. Jobs are sent to ComfyUI through `/prompt` only after `Submit jobs` is clicked.

## Requirements

- A current ComfyUI release with the Vue frontend (the extension targets the latest version and carries no compatibility shims).
- A modern browser with IndexedDB, `<dialog>`, and `structuredClone` support — the library features rely on them.
- No Python dependencies, no build step, no runtime npm dependencies. Node.js is only needed to run the tests.

## Installation

1. Download or clone this repository.
2. Copy the whole directory into ComfyUI's `custom_nodes` directory, keeping the directory name:

   ```text
   ComfyUI/custom_nodes/comfyui-orchestrator
   ```

3. Restart ComfyUI.
4. Refresh the browser and look for the `Batch` button group in the topbar.
5. Open the panel. It reads the canvas the first time it is expanded; click the refresh button `⟳` after switching workflows.

## Usage

### 1. Read the current canvas

The panel reads the canvas automatically the first time it is expanded. Click the refresh button `⟳` in the topbar `Batch` group after switching or editing the workflow. The panel only handles nodes that can be converted to an API workflow and are not disabled or bypassed.

Reading happens on first expansion rather than at extension load because ComfyUI restores the workflow into the graph after extension `setup()` runs — reading at load would always see an empty graph.

### 2. Select the UNET and models

Choose the target node from `UNET Loader`. Click its `Locate` button to center and highlight the node on the canvas.

Expand folders and check models in the `Models` tree. Checking a folder selects all models below it, and a partially selected folder shows an indeterminate checkbox. The entries come from ComfyUI's current `UNETLoader` node definition.

If the workflow contains `LoraLoaderModelOnly`, choose the target in `LoRA loader`, then select LoRAs in the `LoRAs` tree. Each job writes the selected value to `lora_name` and leaves `strength_model` unchanged. Without a LoRA node, the LoRA dimension is an implicit single empty value.

### 3. Select the positive CLIP text node

Choose the target from `CLIP text node`. Negative-conditioning nodes are omitted from this list. Click `Locate` when you need to inspect the node on the canvas.

Use an exact placeholder in `Text template`, for example:

```text
studio portrait of {{subject}}, soft daylight, neutral background
```

The text template box grows with its content and scrolls internally past a maximum height.

The `Variables` area starts with one variable named `subject`. `Insert` next to the name inserts `{{subject}}` at the textarea cursor; `Save to library` stores all of that variable's values.

Type a value in the variable's input and press Enter to add it; several values can be pasted at once separated by newlines or commas. Added values are listed as chips, and the `×` on a chip removes it. Typing suggests values already stored in the library under that name.

`+ Add variable` adds as many variables as you need, so the template can read:

```text
studio portrait, {{top}}, {{bottom}}, {{shoes}}
```

The job count is the product of the models, LoRAs, and each variable's values; variable order is expansion order. Variable names may start with any Unicode letter, so `{{上衣}}` is valid too.

Once a set of variables is configured, `Save combination` stores it under a name; loading it from the `Variable library` dialog replaces all variables in the panel.

### 4. Configure output filenames

Select the output nodes to name. Every output row has its own filename template and `Locate` button, so multiple `SaveImage` nodes can be configured independently.

Default template:

```text
orchestrator/{{model}}_{{value}}_{{index}}
```

Static `/` creates a relative subdirectory below ComfyUI's output directory:

```text
orchestrator/{{model}}/{{value}}_{{index}}
```

Open `Settings` from the topbar to change the maximum job count, preview count, default output filename template, whether the LoRA dimension is enabled, and whether the task log is cleared before each new batch. Settings are stored only in the current browser's `localStorage`, not in the repository; per-output template overrides made in either panel are remembered too.

### 5. Preview and submit

Click `Generate preview` to expand the preview area and show the total job count and the configured number of jobs (five by default), including their model, LoRA, variable values, and filename. Preview generation stays in the panel; it does not call `/prompt` and does not enqueue anything. The preview collapses automatically after submission to leave room for the task log.

After checking the count and names, click `Submit jobs`. The extension sends one `/prompt` request per combination in order, then polls task history and displays queued, running, completed, or failed states.

`Maximum jobs` defaults to 500 to reduce accidental oversized batches; the preview count defaults to five and can be set up to 50. Both values are changed from `Settings` in the topbar.

## Task monitoring

After submission the task log is grouped by batch, with a divider before each batch showing its number, submission time, task count, and completed count. The log scrolls horizontally on its own so long filenames can be read without moving the rest of the panel.

Polling also reads the ComfyUI queue, so the job currently executing is shown as running and highlighted while the rest stay queued.

`Cancel` in the toolbar removes this log's unfinished tasks from the ComfyUI queue. It only calls interrupt when the currently executing job actually belongs to this extension, so jobs from other sources are never stopped. `Retry` resubmits failed tasks using their original batch configuration and filenames, and the results stay under the original batch. `Clear` only empties the on-screen log and does not touch anything already queued.

To support retry, each batch keeps one snapshot of the config and base workflow it was submitted with; retry re-expands jobs by index instead of storing a workflow JSON per task.

## Fictional example

The model names, text values, and prompt below are fictional interface examples. They are not bundled models and do not refer to any real machine or workflow.

| Setting | Example |
| --- | --- |
| UNET models | `demo/aurora_v1.safetensors`, `demo/aurora_v2.safetensors` |
| Text template | `editorial portrait of {{subject}}, soft studio light` |
| Text values | `red umbrella`, `yellow raincoat` |
| Output template | `orchestrator/{{model}}/{{value}}_{{index}}` |

Two models × two text values = four jobs:

```text
001  aurora_v1 × red umbrella
002  aurora_v1 × yellow raincoat
003  aurora_v2 × red umbrella
004  aurora_v2 × yellow raincoat
```

## Filename templates

Supported dynamic variables:

| Variable | Meaning |
| --- | --- |
| `{{model}}` | Selected model name, sanitized for a safe filename |
| `{{lora}}` | Selected LoRA name, sanitized for a safe filename |
| `{{value}}` | Value of the first variable, sanitized for a safe filename |
| `{{<key>}}` | Full text for a multi-variable slot, such as `{{top}}` |
| `{{<key>_label}}` | Short filename label for a multi-variable slot, such as `{{top_label}}` |
| `{{index}}` | One-based job number, padded as `001`, `002`, and so on |
| `{{seed}}` | The first seed found in the base workflow, when available |

Rules:

- The template cannot be empty.
- Only the variables above are supported; variable names must match `\p{L}[\p{L}\p{N}_]*`, that is, start with a Unicode letter.
- Absolute paths, drive-letter paths, and `..` path segments are rejected.
- Static `/` is for relative subdirectories below the output directory.
- Windows-reserved characters in dynamic values are replaced with underscores.
- ComfyUI still adds the file extension according to the output node.

For multi-variable batches, prefer labels so full prompt text does not become a filename:

```text
orchestrator/{{top_label}}_{{bottom_label}}_{{index}}
```

Tags are used for library search and filtering; they are not automatically emitted into filenames.

## Preview versus submission

| Action | Copies API JSON | Calls `/prompt` | Changes the current canvas |
| --- | ---: | ---: | ---: |
| `Generate preview` | Yes, temporarily | No | No |
| `Submit jobs` | Yes, once per job | Yes | No |

## Variable library, templates, and migration

`Variable library` and `Template library` are two separate dialogs opened from the panel.

`Variable library` manages saved combinations and individual variable values: search across names, text, labels, and notes, exact tag filtering, and edit/delete. `Template library` manages named templates and recent history; each template can be previewed in place, loaded into the panel, edited, or deleted. Each history entry can be previewed, loaded, or promoted with `Save as template`, which names it and stores it among the saved templates — history is an automatic log and is not edited in place; promote it first and then edit it the usual way. History is capped at 100 entries and deduplicated by template body.

Variables, combinations, templates, and history are stored in the current browser's IndexedDB database, `comfyui-batch-orchestrator-library`. Panel settings and output-template overrides remain in the current browser's `localStorage`. If IndexedDB is unavailable you can still configure and submit batches; only library CRUD, history, and migration are unavailable.

`Export library JSON` in the settings dialog writes the `comfyui-batch-orchestrator-library` schema, the current version, variables, combinations, templates, and history. Imports merge by default rather than clearing the current library: equal ids keep the newer timestamp, and variable records with equal `key + text + label` are deduplicated. The JSON is validated before replacement; a failed import leaves existing data unchanged.

## Architecture

### Module layout

```text
__init__.py                    ComfyUI extension entry point; only exposes the web directory
web/js/orchestrator.js         Panel, topbar mounting, preview, submission, polling, library UI
web/js/orchestrator-core.js    Pure batch logic: discovery, expansion, filename rendering
web/js/orchestrator-library.js IndexedDB storage, normalization, JSON import/export
web/css/orchestrator.css       Panel styling
test/                          Native Node.js tests for the two pure modules
```

The split follows one rule: everything that can be tested without a DOM lives in `orchestrator-core.js` or `orchestrator-library.js`, and everything that touches `document`, `app`, or `api` lives in `orchestrator.js`. That is why the two lower modules have full test coverage and the panel has none — they hold all the logic worth testing.

### Data flow

```text
canvas ──app.graphToPrompt()──> API JSON
                                   │
                   discoverTargets(prompt, graphNodes)
                                   │
                   ┌───────────────┴────────────────┐
              UNET / LoRA / CLIP / output targets   │
                                   │                │
                        user selection in panel ────┘
                                   │
                        expandJobs(prompt, config)   generator
                                   │
              { index, model, lora, variables, filenamePrefixes, prompt }
                                   │
                 preview (panel only)   ──or──   POST /prompt per job
                                                        │
                                          poll /history/{id} + /queue
                                                        │
                                                   task log UI
```

`expandJobs` is a generator and is fully deterministic: the same `(prompt, config)` pair always yields the same jobs in the same order. Preview, submission, and retry all call it, which is what makes index-based retry possible without storing a workflow JSON per task.

### State

| Where | What | Lifetime |
| --- | --- | --- |
| In-memory `state` | Discovered targets, selections, tasks, batch snapshots | Current page |
| `localStorage` | Panel settings and per-output filename templates | Current browser |
| IndexedDB | Variables, combinations, templates, template history | Current browser |
| ComfyUI server | Queued and executing jobs | Server-side |

Nothing is written to the repository, and the current canvas is never modified or saved.

### Notifications

Every user-facing message goes through one `setStatus` call, which forwards to `app.extensionManager.toast.add`. Nothing is ever written into the topbar or a status element — the panel has no status line at all.

## Implementation notes

These constraints are not obvious from the code and are easy to break.

### Topbar mounting

The control group is injected into the ComfyUI top menu bar. Three hard requirements:

- **Insert once, never move afterwards.** An earlier version checked `getBoundingClientRect` after insertion and removed the element when it measured zero. Initial layout has not settled at that point, so it always measured zero, producing an insert → remove → insert loop. Combined with the Crystools monitor mutating the DOM every second to refresh its readouts, this made the menu flicker continuously.
- **Locate the topbar container via the official settings button group's parent** (`app.menu.settingsGroup.element.parentElement`) rather than guessing class names.
- **Sit to the left of Crystools**: wait for it, then insert before it. Its container class differs across versions, so matching uses the `[class*='crystools']` prefix, scoped to the topbar container — an unscoped query also matches elements inside its settings panel and would insert in the wrong place. Without Crystools installed, fall back to inserting before the settings button group. The topbar is rendered asynchronously by Vue, so polling has a grace period.

The panel element is built before the topbar is attached to the document, so the internal `byId` helper falls back to querying the detached topbar subtree. Without that fallback every listener binding silently resolves to `null` and the UI renders but does not respond.

### Variable name rules

Variable names may start with any Unicode letter, so both `{{subject}}` and `{{上衣}}` are valid; the rule is `/^\p{L}[\p{L}\p{N}_]*$/u`. It must stay identical in `orchestrator-core.js` and `orchestrator-library.js`, otherwise names accepted by the panel cannot be saved to the library.

### Library version

Exports carry `schema` and `version`. The current version is 2, adding the `variableSets` store on top of v1. Imports accept v1 files and treat missing stores as empty arrays; files newer than the current version are rejected because their structure cannot be anticipated. IndexedDB creates the new store automatically through `onupgradeneeded`.

Per-record type coercion and required-field validation all happen in `normalizeLibraryData`; the import path only additionally validates the outer envelope (schema, version, and that each store is an array).

## Troubleshooting

- **The panel is missing**: confirm the directory is `custom_nodes/comfyui-orchestrator`, restart ComfyUI, and refresh the browser.
- **Canvas loading fails**: open the workflow first, then click the topbar refresh button `⟳`.
- **The model list is empty**: make sure the selected node is an enabled `UNETLoader` and that ComfyUI returns model choices for it.
- **No CLIP node is available**: make sure an enabled `CLIPTextEncode` exists; negative-conditioning nodes are filtered out.
- **The placeholder is reported as missing**: if the variable name is `subject`, the template must contain the exact `{{subject}}`, including braces and case.
- **The variable library cannot open**: check whether the current ComfyUI origin allows browser IndexedDB; variables can still be entered and submitted, they just cannot be saved to the library.
- **Import fails**: only `comfyui-batch-orchestrator-library` JSON no newer than the current version is accepted; malformed input does not overwrite existing data.
- **Preview reports an error**: check the model selection, text values, output selection, and maximum-job limit, then generate the preview again.
- **Locate does nothing**: refresh the current canvas first. Locate only acts on the currently open canvas and does not change workflow content.
- **Settings are not retained**: settings are stored in the current browser's `localStorage`; if site storage is disabled, they only apply to the current page.

## Current limitations

- Only enabled nodes that can be converted to an API workflow are supported.
- The LoRA selector only handles `LoraLoaderModelOnly`; other LoRA node types are not modified.
- An output node must expose a `filename_prefix` input to be listed as a nameable output.
- Jobs are submitted sequentially. There is currently no concurrent submission, pause/resume, or persistent batch feature.
- The panel's task list is kept in the current page and is not restored after a page refresh; queued jobs themselves are unaffected.
- The variable library, named templates, and up to 100 history entries live in the current browser's IndexedDB; they are not synced across browsers or ComfyUI installations without JSON export/import.
- Negative-CLIP detection uses connection input names or node titles. For complex custom workflows with fully custom naming, verify the discovered target list.

## Development and testing

There is no frontend build artifact; ComfyUI loads the ES modules directly from `web`. Run the checks:

```bash
npm test
node --check web/js/orchestrator-core.js
node --check web/js/orchestrator-library.js
node --check web/js/orchestrator.js
```

`npm test` uses Node.js's built-in test runner; there are no npm dependencies to install.

## Data boundary

The extension does not provide a cloud service and contains no telemetry logic. It reads the canvas and node definitions exposed by the current ComfyUI frontend; after submission, the workflow copies and parameters are sent back to that ComfyUI instance. The variable library, templates, and history stay in browser-local IndexedDB; JSON migration is an explicit local export/import action, not server synchronization.

Relevant ComfyUI documentation:

- [Server communication routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Workflow API format](https://docs.comfy.org/development/api-development/workflow-api-format)
- [LoRA Loader (Model Only)](https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/LoraLoaderModelOnly/zh.md)

## License

[MIT](LICENSE)
