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

function isLoraTarget(node) {
  const type = String(node?.class_type || "");
  return /loraloadermodelonly/i.test(type) && Object.hasOwn(asInputs(node), "lora_name");
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
    lora: entries.filter(([, node]) => isLoraTarget(node)).map(([id, node]) => target(id, node, graphById.get(id))),
    text: entries
      .filter(([id, node]) => isTextTarget(node) && !isNegativeTextTarget(id, graphById.get(id), negativeIds))
      .map(([id, node]) => target(id, node, graphById.get(id))),
    outputs: entries.filter(([, node]) => isOutputTarget(node)).map(([id, node]) => target(id, node, graphById.get(id))),
  };
}

export function countJobs(...dimensions) {
  return dimensions.reduce((total, values) => total * values.length, 1);
}

export function buildModelTree(values) {
  const roots = [];
  const folders = new Map();
  const seen = new Set();

  for (const value of values || []) {
    if (typeof value !== "string" || !value.trim() || seen.has(value)) continue;
    seen.add(value);
    const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
    if (!segments.length) continue;

    let children = roots;
    let path = "";
    for (const segment of segments.slice(0, -1)) {
      path = path ? `${path}/${segment}` : segment;
      let folder = folders.get(path);
      if (!folder) {
        folder = { type: "folder", name: segment, path, children: [] };
        folders.set(path, folder);
        children.push(folder);
      }
      children = folder.children;
    }
    children.push({ type: "model", name: segments[segments.length - 1], value });
  }
  return roots;
}

const VARIABLE_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

function normalizeVariableValue(value) {
  const record = typeof value === "object" && value !== null ? value : { text: value };
  const text = String(record.text ?? "");
  if (!text.trim()) throw new Error("文本变量值不能为空");
  return {
    ...(record.id ? { id: String(record.id) } : {}),
    text,
    label: String(record.label ?? ""),
    tags: Array.isArray(record.tags) ? [...record.tags].map(String) : [],
  };
}

export function normalizeVariableSlots(config) {
  const isLegacy = !(Array.isArray(config.variables) && config.variables.length);
  const source = isLegacy
    ? [{
        key: config.variable,
        values: [...(config.values || [])].map((text) => ({ text, label: "", tags: [] })),
      }]
    : config.variables;
  const keys = new Set();
  return source.map((slot) => {
    const key = String(slot?.key || "").trim();
    if (!key || (!isLegacy && !VARIABLE_KEY.test(key))) {
      throw new Error(`文本变量 key 无效：${key || "不能为空"}`);
    }
    if (keys.has(key)) throw new Error(`文本变量 key 重复：${key}`);
    keys.add(key);
    const values = Array.isArray(slot?.values) ? slot.values.map(normalizeVariableValue) : [];
    if (!values.length) throw new Error(`文本变量 ${key} 至少需要一个值`);
    return { key, values };
  });
}

export function replacePlaceholders(template, replacements) {
  const source = String(template);
  const names = new Set(Object.keys(replacements || {}));
  for (const match of source.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) {
    if (!names.has(match[1])) throw new Error(`文本模板中没有找到变量 ${match[1]}`);
  }
  return source.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key) => String(replacements[key]));
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

function* variableCombinations(slots, slotIndex = 0, selected = []) {
  if (slotIndex === slots.length) {
    yield selected;
    return;
  }
  for (const value of slots[slotIndex].values) {
    yield* variableCombinations(slots, slotIndex + 1, [
      ...selected,
      { ...value, key: slots[slotIndex].key },
    ]);
  }
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
  const loras = config.loras === undefined ? [""] : [...(config.loras || [])];
  if (!models.length) throw new Error("至少选择一个 UNET 模型");
  if (!loras.length) throw new Error("至少选择一个 LoRA");
  const variables = normalizeVariableSlots(config);

  const unetId = String(config.unetId);
  const loraId = config.loraId ? String(config.loraId) : "";
  const textId = String(config.textId);
  const baseText = typeof config.template === "string"
    ? config.template
    : prompt?.[textId]?.inputs?.text;
  if (typeof baseText !== "string") throw new Error(`找不到文本节点 ${textId}`);
  if (!prompt?.[unetId]?.inputs || !Object.hasOwn(prompt[unetId].inputs, "unet_name")) {
    throw new Error(`找不到 UNET 节点 ${unetId}`);
  }
  if (loraId && (!prompt?.[loraId]?.inputs || !Object.hasOwn(prompt[loraId].inputs, "lora_name"))) {
    throw new Error(`找不到 LoRA 节点 ${loraId}`);
  }
  if (loras.some(Boolean) && !loraId) throw new Error("缺少 LoRA 节点");
  for (const { key } of variables) {
    if (!baseText.includes(`{{${key}}}`)) {
      throw new Error(`文本模板中没有找到变量 ${key}`);
    }
  }

  const outputs = (config.outputs || []).map((output) => ({ id: String(output.id), template: output.template }));
  const total = countJobs(models, loras, ...variables.map(({ values: slotValues }) => slotValues));
  let index = 1;
  for (const model of models) {
    for (const lora of loras) {
      for (const combination of variableCombinations(variables)) {
        const jobPrompt = structuredClone(prompt);
        jobPrompt[unetId].inputs.unet_name = model;
        if (loraId) jobPrompt[loraId].inputs.lora_name = lora;
        const replacements = Object.fromEntries(combination.map((item) => [item.key, item.text]));
        jobPrompt[textId].inputs.text = variables.length === 1 && !VARIABLE_KEY.test(variables[0].key)
          ? replacePlaceholder(baseText, variables[0].key, combination[0].text)
          : replacePlaceholders(baseText, replacements);

        const value = combination[0].text;
        const filenameFields = {
          model,
          lora,
          value,
          index,
          seed: config.seed ?? firstSeed(prompt),
        };
        for (const item of combination) {
          filenameFields[item.key] = item.text;
          filenameFields[`${item.key}_label`] = item.label || item.text;
        }
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
          lora,
          value,
          variables: combination,
          filenamePrefixes,
          prompt: jobPrompt,
        };
        index += 1;
      }
    }
  }
}
