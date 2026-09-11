import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModelTree,
  countJobs,
  discoverTargets,
  expandJobs,
  renderFilename,
  sanitizeFilenamePrefix,
} from "../web/js/orchestrator-core.js";

const basePrompt = {
  "262": {
    class_type: "UNETLoader",
    inputs: { unet_name: "models/one.safetensors", weight_dtype: "default" },
  },
  "273": {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["262", 0], lora_name: "styles/one.safetensors", strength_model: 0.8 },
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
  assert.deepEqual(targets.lora.map((target) => target.id), ["273"]);
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
    variables: [{ key: "subject", values: [{ text: "cat" }, { text: "dog" }] }],
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

test("adds LoRA choices to the Cartesian product and prompt clone", () => {
  assert.equal(countJobs(["one", "two"], ["style_a", "style_b"], ["cat", "dog"]), 8);

  const jobs = [...expandJobs(basePrompt, {
    unetId: "262",
    loraId: "273",
    textId: "264",
    outputs: [
      { id: "272", template: "batch/{{model}}/{{lora}}/{{value}}/{{index}}" },
    ],
    models: ["one.safetensors"],
    loras: ["styles/style_a.safetensors", "styles/style_b.safetensors"],
    variables: [{ key: "subject", values: [{ text: "cat" }, { text: "dog" }] }],
  })];

  assert.equal(jobs.length, 4);
  assert.deepEqual(
    jobs.map(({ model, lora, value }) => [model, lora, value]),
    [
      ["one.safetensors", "styles/style_a.safetensors", "cat"],
      ["one.safetensors", "styles/style_a.safetensors", "dog"],
      ["one.safetensors", "styles/style_b.safetensors", "cat"],
      ["one.safetensors", "styles/style_b.safetensors", "dog"],
    ],
  );
  assert.equal(jobs[0].prompt["273"].inputs.lora_name, "styles/style_a.safetensors");
  assert.equal(jobs[0].prompt["273"].inputs.strength_model, 0.8);
  assert.equal(jobs[0].prompt["272"].inputs.filename_prefix, "batch/one_safetensors/style_a_safetensors/cat/001");
});

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

test("rejects an empty variable slot before yielding a job", () => {
  assert.throws(() => [...expandJobs(basePrompt, {
    unetId: "262",
    textId: "264",
    template: "{{top}}",
    models: ["one.safetensors"],
    variables: [{ key: "top", values: [] }],
  })], /值|value/i);
});

test("rejects an undefined multi-variable placeholder before yielding a job", () => {
  assert.throws(() => [...expandJobs(basePrompt, {
    unetId: "262",
    textId: "264",
    template: "{{top}} {{missing}}",
    models: ["one.safetensors"],
    variables: [{ key: "top", values: [{ text: "white top" }] }],
  })], /变量|placeholder/i);
});

test("uses the edited template instead of the original text node", () => {
  const [job] = expandJobs(basePrompt, {
    unetId: "262",
    textId: "264",
    template: "edited {{subject}}",
    outputs: [{ id: "272", template: "batch/{{index}}" }],
    models: ["one.safetensors"],
    variables: [{ key: "subject", values: [{ text: "cat" }] }],
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
    variables: [{ key: "subject", values: [{ text: "cat" }] }],
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

test("exposes the first variable as the job value", () => {
  const [job] = expandJobs(basePrompt, {
    unetId: "262",
    textId: "264",
    models: ["one.safetensors"],
    variables: [{ key: "subject", values: [{ text: "cat" }] }],
  });

  assert.equal(job.value, "cat");
  assert.deepEqual(job.variables.map(({ key, text }) => [key, text]), [["subject", "cat"]]);
});

test("supports non-ASCII variable names", () => {
  const [job] = expandJobs(basePrompt, {
    unetId: "262",
    textId: "264",
    template: "edited {{上衣}}",
    outputs: [{ id: "272", template: "out/{{上衣}}_{{index}}" }],
    models: ["one.safetensors"],
    variables: [{ key: "上衣", values: [{ text: "white top" }] }],
  });

  assert.equal(job.prompt["264"].inputs.text, "edited white top");
  assert.equal(job.prompt["272"].inputs.filename_prefix, "out/white top_001");
});

test("rejects a config with no variables at all", () => {
  assert.throws(() => [...expandJobs(basePrompt, {
    unetId: "262",
    textId: "264",
    models: ["one.safetensors"],
  })], /变量/);
});
