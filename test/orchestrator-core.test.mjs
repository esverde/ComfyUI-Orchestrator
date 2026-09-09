import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModelTree,
  countJobs,
  discoverTargets,
  expandJobs,
  renderFilename,
  replacePlaceholder,
  sanitizeFilenamePrefix,
} from "../web/js/orchestrator-core.js";

const basePrompt = {
  "262": {
    class_type: "UNETLoader",
    inputs: { unet_name: "models/one.safetensors", weight_dtype: "default" },
  },
  "264": {
    class_type: "CLIPTextEncode",
    inputs: { text: "a {{subject}}", clip: ["258", 0] },
  },
  "272": {
    class_type: "SaveImage",
    inputs: { filename_prefix: "ComfyUI", images: ["271", 0] },
  },
};

test("discovers executable UNET, CLIP text, and output targets", () => {
  const targets = discoverTargets(basePrompt, [
    { id: 262, title: "Active UNET" },
    { id: 264, title: "Positive prompt" },
    { id: 272, title: "Save image" },
  ]);

  assert.deepEqual(targets.unet.map((target) => target.id), ["262"]);
  assert.equal(targets.text[0].title, "Positive prompt");
  assert.equal(targets.outputs[0].id, "272");
});

test("builds ordered nested folders from model paths", () => {
  assert.deepEqual(buildModelTree([
    "checkpoints/realvis/model_a.safetensors",
    "checkpoints\\realvis\\model_b.safetensors",
    "checkpoints/sdxl/model_c.safetensors",
    "root.safetensors",
    "root.safetensors",
  ]), [
    {
      type: "folder",
      name: "checkpoints",
      path: "checkpoints",
      children: [
        {
          type: "folder",
          name: "realvis",
          path: "checkpoints/realvis",
          children: [
            { type: "model", name: "model_a.safetensors", value: "checkpoints/realvis/model_a.safetensors" },
            { type: "model", name: "model_b.safetensors", value: "checkpoints\\realvis\\model_b.safetensors" },
          ],
        },
        {
          type: "folder",
          name: "sdxl",
          path: "checkpoints/sdxl",
          children: [
            { type: "model", name: "model_c.safetensors", value: "checkpoints/sdxl/model_c.safetensors" },
          ],
        },
      ],
    },
    { type: "model", name: "root.safetensors", value: "root.safetensors" },
  ]);
});

test("excludes CLIP text nodes used as negative conditioning", () => {
  const prompt = {
    "255": {
      class_type: "CLIPTextEncode",
      inputs: { text: "bad", clip: ["258", 0] },
    },
    "264": {
      class_type: "CLIPTextEncode",
      inputs: { text: "a {{subject}}", clip: ["258", 0] },
    },
    "202": {
      class_type: "KSampler",
      inputs: { positive: ["264", 0], negative: ["255", 0] },
    },
  };

  const targets = discoverTargets(prompt, [
    { id: 255, title: "负面条件" },
    { id: 264, title: "正面条件" },
    { id: 202, title: "KSampler" },
  ]);

  assert.deepEqual(targets.text.map((target) => target.id), ["264"]);
});

test("expands a Cartesian product into independent prompt clones", () => {
  assert.equal(countJobs(["one", "two", "three"], ["cat", "dog", "bird", "fox"]), 12);

  const jobs = [...expandJobs(basePrompt, {
    unetId: "262",
    textId: "264",
    outputs: [
      { id: "272", template: "batch/{{model}}/{{value}}/{{index}}" },
    ],
    models: ["one.safetensors", "two.safetensors"],
    values: ["cat", "dog"],
    variable: "subject",
  })];

  assert.equal(jobs.length, 4);
  assert.deepEqual(
    jobs.map(({ model, value }) => [model, value]),
    [
      ["one.safetensors", "cat"],
      ["one.safetensors", "dog"],
      ["two.safetensors", "cat"],
      ["two.safetensors", "dog"],
    ],
  );
  assert.equal(jobs[0].prompt["262"].inputs.unet_name, "one.safetensors");
  assert.equal(jobs[0].prompt["264"].inputs.text, "a cat");
  assert.equal(jobs[0].prompt["272"].inputs.filename_prefix, "batch/one_safetensors/cat/001");
  assert.deepEqual(jobs[0].filenamePrefixes, [{ id: "272", prefix: "batch/one_safetensors/cat/001" }]);
  assert.notStrictEqual(jobs[0].prompt, jobs[1].prompt);
  assert.equal(basePrompt["264"].inputs.text, "a {{subject}}");
});

test("replaces a named text placeholder and rejects a missing placeholder", () => {
  assert.equal(replacePlaceholder("portrait of {{subject}}", "subject", "a cat"), "portrait of a cat");
  assert.throws(() => replacePlaceholder("portrait", "subject", "a cat"), /placeholder/i);
});

test("uses the edited template instead of the original text node", () => {
  const [job] = expandJobs(basePrompt, {
    unetId: "262",
    textId: "264",
    template: "edited {{subject}}",
    outputs: [{ id: "272", template: "batch/{{index}}" }],
    models: ["one.safetensors"],
    values: ["cat"],
    variable: "subject",
  });

  assert.equal(job.prompt["264"].inputs.text, "edited cat");
});

test("supports an independent filename template for each output node", () => {
  const prompt = {
    ...basePrompt,
    "285": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ComfyUI", images: ["271", 0] },
    },
  };
  const [job] = expandJobs(prompt, {
    unetId: "262",
    textId: "264",
    outputs: [
      { id: "272", template: "images/{{model}}/{{index}}" },
      { id: "285", template: "preview/{{value}}/{{index}}" },
    ],
    models: ["one.safetensors"],
    values: ["cat"],
    variable: "subject",
  });

  assert.equal(job.prompt["272"].inputs.filename_prefix, "images/one_safetensors/001");
  assert.equal(job.prompt["285"].inputs.filename_prefix, "preview/cat/001");
  assert.deepEqual(job.filenamePrefixes, [
    { id: "272", prefix: "images/one_safetensors/001" },
    { id: "285", prefix: "preview/cat/001" },
  ]);
});

test("renders and sanitizes output filename fields", () => {
  assert.equal(
    renderFilename("out/{{model}}_{{value}}_{{index}}_{{seed}}", {
      model: "C:\\models\\one.safetensors",
      value: "a:cat?",
      index: 7,
      seed: 42,
    }),
    "out/one_safetensors_a_cat__007_42",
  );
  assert.throws(() => sanitizeFilenamePrefix("C:\\outside\\file"), /绝对路径|absolute|path/i);
  assert.throws(() => sanitizeFilenamePrefix("../outside"), /路径段|parent|path/i);
  assert.throws(() => sanitizeFilenamePrefix("/outside"), /绝对路径|absolute|path/i);
});
