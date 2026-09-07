const INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/g;
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/;
export const DEFAULT_FILENAME_TEMPLATE = "orchestrator/{{model}}_{{value}}_{{index}}";

function asInputs(node) {
  return node && typeof node.inputs === "object" && node.inputs !== null ? node.inputs : {};
}

function nodeTitle(id, graphNode) {
  if (!graphNode) return `节点 ${id}`;
  if (typeof graphNode.getTitle === "function") return graphNode.getTitle();
  return graphNode.title || graphNode.properties?.["Node name for S&R"] || graphNode.type || `节点 ${id}`;
}

function target(id, node, graphNode) {
  return {
    id: String(id),
    classType: String(node.class_type || ""),
    title: nodeTitle(id, graphNode),
    inputs: asInputs(node),
  };
}

function isUnetTarget(node) {
  const type = String(node?.class_type || "");
  return /unet/i.test(type) && Object.hasOwn(asInputs(node), "unet_name");
}

function isTextTarget(node) {
  const type = String(node?.class_type || "");
  return /cliptextencode/i.test(type) && typeof asInputs(node).text === "string";
}

function negativeTextIds(prompt) {
  const ids = new Set();
  for (const node of Object.values(prompt || {})) {
    for (const [name, value] of Object.entries(asInputs(node))) {
      if (/negative|负面|负向/i.test(name) && Array.isArray(value) && value.length) {
        ids.add(String(value[0]));
      }
    }
  }
  return ids;
}

function graphTextLabel(graphNode) {
  return [
    graphNode?.title,
    graphNode?.properties?.["Node name for S&R"],
    typeof graphNode?.getTitle === "function" ? graphNode.getTitle() : "",
  ].filter(Boolean).join(" ");
}

function isNegativeTextTarget(id, graphNode, negativeIds) {
  return negativeIds.has(String(id)) || /negative|负面|负向/i.test(graphTextLabel(graphNode));
}

function isOutputTarget(node) {
  return Object.hasOwn(asInputs(node), "filename_prefix");
}

export function discoverTargets(prompt, graphNodes = []) {
  const graphById = new Map(graphNodes.map((node) => [String(node.id), node]));
  const negativeIds = negativeTextIds(prompt);
  const entries = Object.entries(prompt || {});
  return {
    unet: entries.filter(([, node]) => isUnetTarget(node)).map(([id, node]) => target(id, node, graphById.get(id))),
    text: entries
      .filter(([id, node]) => isTextTarget(node) && !isNegativeTextTarget(id, graphById.get(id), negativeIds))
      .map(([id, node]) => target(id, node, graphById.get(id))),
    outputs: entries.filter(([, node]) => isOutputTarget(node)).map(([id, node]) => target(id, node, graphById.get(id))),
  };
}

export function countJobs(models, values) {
  return models.length * values.length;
}

export function replacePlaceholder(template, variable, value) {
  const name = String(variable || "").trim();
  if (!name) throw new Error("文本变量名不能为空");
  const placeholder = `{{${name}}}`;
  if (!String(template).includes(placeholder)) {
    throw new Error(`文本模板中没有找到 placeholder（占位符）${placeholder}`);
  }
  return String(template).split(placeholder).join(String(value));
}

function cloneJson(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function dynamicToken(value) {
  const base = String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .pop() || "";
  return base
    .replace(INVALID_SEGMENT_CHARS, "_")
    .replaceAll(".", "_")
    .trim();
}

function filenameIndex(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number).padStart(3, "0") : dynamicToken(value);
}

function firstSeed(prompt) {
  for (const node of Object.values(prompt || {})) {
    const seed = node?.inputs?.seed;
    if (typeof seed === "number" || typeof seed === "string") return seed;
  }
  return "";
}

export function sanitizeFilenamePrefix(prefix) {
  const original = String(prefix ?? "").trim();
  if (!original) throw new Error("输出文件名前缀不能为空");
  if (ABSOLUTE_PATH.test(original)) throw new Error("输出文件名不能使用绝对路径");

  const normalized = original.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("输出文件名不能包含 .. 路径段");
  }

  const safe = segments
    .map((segment) => segment.replace(INVALID_SEGMENT_CHARS, "_").replace(/[. ]+$/g, "").trim())
    .filter(Boolean)
    .join("/");
  if (!safe) throw new Error("输出文件名前缀清理后为空");
  return safe;
}

export function renderFilename(template, fields) {
  const source = String(template ?? "").trim();
  if (!source) throw new Error("输出文件名模板不能为空");
  const rendered = source.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    if (!Object.hasOwn(fields, key)) throw new Error(`不支持的文件名变量 ${match}`);
    if (key === "index") return filenameIndex(fields[key]);
    return dynamicToken(fields[key]);
  });
  return sanitizeFilenamePrefix(rendered);
}

export function* expandJobs(prompt, config) {
  const models = [...(config.models || [])];
  const values = [...(config.values || [])];
  if (!models.length) throw new Error("至少选择一个 UNET 模型");
  if (!values.length) throw new Error("至少提供一个文本变量值");

  const unetId = String(config.unetId);
  const textId = String(config.textId);
  const baseText = typeof config.template === "string"
    ? config.template
    : prompt?.[textId]?.inputs?.text;
  if (typeof baseText !== "string") throw new Error(`找不到文本节点 ${textId}`);
  if (!prompt?.[unetId]?.inputs || !Object.hasOwn(prompt[unetId].inputs, "unet_name")) {
    throw new Error(`找不到 UNET 节点 ${unetId}`);
  }

  const outputs = config.outputs
    ? config.outputs.map((output) => ({ id: String(output.id), template: output.template }))
    : [...(config.outputIds || [])].map((id) => ({ id: String(id), template: config.filenameTemplate }));
  const total = countJobs(models, values);
  let index = 1;
  for (const model of models) {
    for (const value of values) {
      const jobPrompt = cloneJson(prompt);
      jobPrompt[unetId].inputs.unet_name = model;
      jobPrompt[textId].inputs.text = replacePlaceholder(baseText, config.variable, value);

      const filenameFields = {
        model,
        value,
        index,
        seed: config.seed ?? firstSeed(prompt),
      };
      const filenamePrefixes = outputs.map((output) => ({
        id: output.id,
        prefix: renderFilename(output.template || DEFAULT_FILENAME_TEMPLATE, filenameFields),
      }));
      for (const { id, prefix } of filenamePrefixes) {
        const outputInputs = jobPrompt[id]?.inputs;
        if (outputInputs && Object.hasOwn(outputInputs, "filename_prefix")) {
          outputInputs.filename_prefix = prefix;
        }
      }

      yield {
        index,
        total,
        model,
        value,
        filenamePrefix: filenamePrefixes[0]?.prefix || "",
        filenamePrefixes,
        prompt: jobPrompt,
      };
      index += 1;
    }
  }
}
