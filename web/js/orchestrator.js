import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import {
  buildModelTree,
  countJobs,
  DEFAULT_FILENAME_TEMPLATE,
  discoverTargets,
  expandJobs,
} from "./orchestrator-core.js";

const EXTENSION_NAME = "comfyui-batch-orchestrator";
const DEFAULT_MAX_JOBS = 500;
const DEFAULT_PREVIEW_LIMIT = 5;
const MAX_PREVIEW_LIMIT = 50;
const SETTINGS_STORAGE_KEY = "comfyui-batch-orchestrator.settings";

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function normalizePosition(value) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null;
  return { x: Math.round(Number(value.x)), y: Math.round(Number(value.y)) };
}

function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const outputTemplates = Object.fromEntries(
    Object.entries(source.outputTemplates || {})
      .filter(([id, template]) => id && typeof template === "string" && template.trim()),
  );
  const filenameTemplate = typeof source.filenameTemplate === "string" && source.filenameTemplate.trim()
    ? source.filenameTemplate.trim()
    : DEFAULT_FILENAME_TEMPLATE;
  return {
    maxJobs: positiveInteger(source.maxJobs, DEFAULT_MAX_JOBS),
    previewLimit: positiveInteger(source.previewLimit, DEFAULT_PREVIEW_LIMIT, MAX_PREVIEW_LIMIT),
    panelMode: source.panelMode === "floating" ? "floating" : "fixed",
    position: normalizePosition(source.position),
    filenameTemplate,
    outputTemplates,
  };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeSettings();
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings));
    return true;
  } catch {
    return false;
  }
}

const state = {
  prompt: null,
  targets: { unet: [], lora: [], text: [], outputs: [] },
  tasks: [],
  taskOrder: "desc",
  templateDirty: false,
  pollTimer: null,
  settings: loadSettings(),
};

let panel;

function byId(id) {
  return document.getElementById(id);
}

function setStatus(message, kind = "") {
  const element = byId("cbo-status");
  if (!element) return;
  element.textContent = message;
  element.className = `cbo-status ${kind}`;
}

function setFieldMessage(message, kind = "") {
  const element = byId("cbo-preview");
  if (!element) return;
  element.textContent = message;
  element.className = `cbo-preview ${kind}`;
}

function graphNodes() {
  return Array.isArray(app.graph?._nodes) ? app.graph._nodes : [];
}

function locateNode(id) {
  const node = graphNodes().find((item) => String(item.id) === String(id));
  const canvas = app.canvas;
  if (!node || !canvas) {
    setStatus(`画布中找不到节点 #${id}`, "error");
    return;
  }
  if (typeof canvas.deselectAll === "function") canvas.deselectAll();
  if (typeof canvas.select === "function") canvas.select(node);
  else if (typeof canvas.selectNode === "function") canvas.selectNode(node);
  else {
    node.selected = true;
    if (canvas.selected_nodes) canvas.selected_nodes[node.id] = node;
  }
  if (typeof canvas.centerOnNode === "function") canvas.centerOnNode(node);
  else if (typeof canvas.fitViewToSelectionAnimated === "function") canvas.fitViewToSelectionAnimated();
  canvas.setDirty?.(true, true);
  setStatus(`已定位并高亮：${node.title || node.type || `节点 #${id}`}`, "ok");
}

async function currentPrompt() {
  if (typeof app.graphToPrompt !== "function") {
    throw new Error("当前 ComfyUI 前端不支持 graphToPrompt()");
  }
  const result = await app.graphToPrompt();
  const prompt = result?.output || result;
  if (!prompt || typeof prompt !== "object" || !Object.keys(prompt).length) {
    throw new Error("当前画布没有可执行的 API 工作流");
  }
  return prompt;
}

async function getJson(path) {
  const response = await api.fetchApi(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
  return response.json();
}

function optionValuesFromObjectInfo(data, nodeType, inputName) {
  const definitions = data?.[nodeType] ? [data[nodeType]] : Object.values(data || {});
  for (const definition of definitions) {
    const raw = definition?.input?.required?.[inputName];
    const values = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw;
    if (Array.isArray(values)) {
      const strings = values.filter((value) => typeof value === "string");
      if (strings.length) return strings;
    }
  }
  return [];
}

function optionValuesFromModels(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map((value) => typeof value === "string" ? value : value?.name)
    .filter((value) => typeof value === "string" && value.length);
}

async function modelOptions(currentValue) {
  try {
    const values = optionValuesFromObjectInfo(await getJson("/object_info/UNETLoader"), "UNETLoader", "unet_name");
    if (values.length) return values;
  } catch {
    // The models route below handles older or restricted ComfyUI builds.
  }
  try {
    const values = optionValuesFromModels(await getJson("/models/diffusion_models"));
    if (values.length) return values;
  } catch {
    // A current workflow value is still useful for a one-combination smoke test.
  }
  return currentValue ? [currentValue] : [];
}

async function loraOptions(currentValue) {
  try {
    const values = optionValuesFromObjectInfo(
      await getJson("/object_info/LoraLoaderModelOnly"),
      "LoraLoaderModelOnly",
      "lora_name",
    );
    if (values.length) return values;
  } catch {
    // The models route below handles older or restricted ComfyUI builds.
  }
  try {
    const values = optionValuesFromModels(await getJson("/models/loras"));
    if (values.length) return values;
  } catch {
    // A current workflow value is still useful for a one-combination smoke test.
  }
  return currentValue ? [currentValue] : [];
}

function fillSelect(select, values, selected = []) {
  select.replaceChildren();
  for (const item of values) {
    const value = typeof item === "string" ? item : item.value ?? item.id;
    const label = typeof item === "string" ? item : item.label ?? item.title ?? value;
    const option = document.createElement("option");
    option.value = String(value ?? "");
    option.textContent = String(label ?? value ?? "");
    option.selected = selected.includes(option.value);
    select.append(option);
  }
}

function selectedValues(select, kind = "model") {
  if (select?.selectedOptions) return [...select.selectedOptions].map((option) => option.value);
  return [...(select?.querySelectorAll(`input[data-${kind}-value]:checked`) || [])]
    .map((input) => input.dataset[`${kind}Value`]);
}

function treeLeavesIn(row, kind) {
  return [...(row?.nextElementSibling?.querySelectorAll(`input[data-${kind}-value]`) || [])];
}

function updateTreeStates(container, kind) {
  [...container.querySelectorAll(`input[data-${kind}-folder]`)].forEach((folder) => {
    const leaves = treeLeavesIn(folder.closest(`.cbo-${kind}-tree-row`), kind);
    const selected = leaves.filter((leaf) => leaf.checked).length;
    folder.checked = leaves.length > 0 && selected === leaves.length;
    folder.indeterminate = selected > 0 && selected < leaves.length;
    folder.closest(`.cbo-${kind}-tree-row`)?.setAttribute(
      "aria-checked",
      folder.indeterminate ? "mixed" : String(folder.checked),
    );
  });
}

function appendTreeNode(container, node, selected, level, kind) {
  const row = document.createElement("div");
  row.className = `cbo-${kind}-tree-row cbo-${kind}-tree-${node.type}`;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(level));

  if (node.type === "folder") {
    row.setAttribute("aria-expanded", "true");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `cbo-${kind}-tree-toggle`;
    toggle.textContent = "⌄";
    toggle.setAttribute("aria-label", `折叠${node.name}`);
    const label = document.createElement("label");
    label.className = `cbo-${kind}-tree-label`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset[`${kind}Folder`] = node.path;
    const text = document.createElement("span");
    text.textContent = node.name;
    label.append(checkbox, text);
    row.append(toggle, label);

    const children = document.createElement("div");
    children.className = `cbo-${kind}-tree-children`;
    children.setAttribute("role", "group");
    node.children.forEach((child) => appendTreeNode(children, child, selected, level + 1, kind));
    container.append(row, children);

    toggle.addEventListener("click", () => {
      const expanded = !children.hidden;
      children.hidden = expanded;
      row.setAttribute("aria-expanded", String(!expanded));
      toggle.textContent = expanded ? "›" : "⌄";
      toggle.setAttribute("aria-label", `${expanded ? "展开" : "折叠"}${node.name}`);
    });
    checkbox.addEventListener("change", () => {
      treeLeavesIn(row, kind).forEach((leaf) => { leaf.checked = checkbox.checked; });
      updateTreeStates(container, kind);
    });
    return;
  }

  const spacer = document.createElement("span");
  spacer.className = `cbo-${kind}-tree-spacer`;
  const label = document.createElement("label");
  label.className = `cbo-${kind}-tree-label`;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset[`${kind}Value`] = node.value;
  checkbox.checked = selected.has(node.value);
  const text = document.createElement("span");
  text.textContent = node.name;
  text.title = node.value;
  label.append(checkbox, text);
  row.append(spacer, label);
  container.append(row);
  checkbox.addEventListener("change", () => updateTreeStates(container, kind));
}

function renderValueTree(container, values, selectedValuesList, kind, emptyLabel, rootName) {
  container.replaceChildren();
  container.setAttribute("role", "tree");
  const tree = buildModelTree(values);
  if (!tree.length) {
    const empty = document.createElement("div");
    empty.className = `cbo-${kind}-tree-empty`;
    empty.textContent = emptyLabel;
    container.append(empty);
    return;
  }
  const selected = new Set(selectedValuesList);
  appendTreeNode(container, { type: "folder", name: rootName, path: "", children: tree }, selected, 1, kind);
  updateTreeStates(container, kind);
}

function renderModelTree(container, values, selectedValuesList = []) {
  renderValueTree(container, values, selectedValuesList, "model", "没有可用模型", "全部模型");
}

function renderLoraTree(container, values, selectedValuesList = []) {
  renderValueTree(container, values, selectedValuesList, "lora", "没有可用 LoRA", "全部 LoRA");
}

async function refreshModelSelect() {
  const selectedUnet = state.targets.unet.find((target) => target.id === byId("cbo-unet-node").value);
  const currentModel = selectedUnet?.inputs?.unet_name || "";
  const values = await modelOptions(currentModel);
  const selected = currentModel ? [currentModel] : selectedValues(byId("cbo-models"), "model");
  renderModelTree(byId("cbo-models"), values, selected);
}

async function refreshLoraSelect() {
  const selectedLora = state.targets.lora.find((target) => target.id === byId("cbo-lora-node").value);
  const currentLora = selectedLora?.inputs?.lora_name || "";
  const values = selectedLora ? await loraOptions(currentLora) : [];
  const selected = currentLora ? [currentLora] : selectedValues(byId("cbo-loras"), "lora");
  renderLoraTree(byId("cbo-loras"), values, selected);
}

function outputTemplateFor(id) {
  // ponytail: node-id keys are enough for the current workflow; use a workflow fingerprint if cross-workflow collisions matter.
  const key = String(id);
  return Object.hasOwn(state.settings.outputTemplates, key)
    ? state.settings.outputTemplates[key]
    : state.settings.filenameTemplate;
}

function syncOutputTemplateInputs(id, value = outputTemplateFor(id)) {
  const key = String(id);
  document.querySelectorAll(".cbo-output-template, .cbo-setting-output-template").forEach((input) => {
    if (input.dataset.outputId === key) input.value = value;
  });
}

function setOutputTemplate(id, value, sourceInput = null) {
  const key = String(id);
  const source = String(value ?? "");
  if (!source.trim() || source.trim() === state.settings.filenameTemplate) {
    delete state.settings.outputTemplates[key];
  } else {
    state.settings.outputTemplates[key] = source;
  }
  const resolved = outputTemplateFor(key);
  document.querySelectorAll(".cbo-output-template, .cbo-setting-output-template").forEach((input) => {
    if (input.dataset.outputId === key && input !== sourceInput) input.value = resolved;
  });
  saveSettings();
}

function renderOutputTemplateSettings() {
  const container = byId("cbo-setting-output-templates");
  if (!container) return;
  container.replaceChildren();
  if (!state.targets.outputs.length) {
    const empty = document.createElement("div");
    empty.className = "cbo-settings-hint";
    empty.textContent = "刷新画布后可为每个输出节点设置单独模板。";
    container.append(empty);
    return;
  }
  state.targets.outputs.forEach((target) => {
    const label = document.createElement("label");
    label.className = "cbo-setting-output-row";
    label.textContent = `${target.title} (#${target.id})`;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cbo-setting-output-template";
    input.dataset.outputId = target.id;
    input.value = outputTemplateFor(target.id);
    input.spellcheck = false;
    input.addEventListener("input", () => {
      setOutputTemplate(target.id, input.value, input);
      updatePreview();
    });
    label.append(input);
    container.append(label);
  });
}

function clampPanelPosition(position) {
  const width = panel?.offsetWidth || 370;
  const height = panel?.offsetHeight || 120;
  const maxX = Math.max(8, window.innerWidth - width - 8);
  const maxY = Math.max(8, window.innerHeight - height - 8);
  return {
    x: Math.min(maxX, Math.max(8, Number(position.x))),
    y: Math.min(maxY, Math.max(8, Number(position.y))),
  };
}

function setPanelPosition(position) {
  const safe = clampPanelPosition(position);
  panel.style.left = `${safe.x}px`;
  panel.style.top = `${safe.y}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  return safe;
}

function defaultFloatingPosition() {
  return {
    x: Math.max(8, window.innerWidth - (panel?.offsetWidth || 370) - 16),
    y: 64,
  };
}

function applyPanelPosition(fallback = null) {
  if (!panel) return;
  if (state.settings.panelMode === "floating") {
    const rect = panel.getBoundingClientRect();
    panel.classList.add("cbo-floating");
    const position = state.settings.position || fallback || { x: rect.left, y: rect.top };
    state.settings.position = setPanelPosition(position);
    return;
  }
  panel.classList.remove("cbo-floating", "cbo-dragging");
  ["left", "top", "right", "bottom"].forEach((property) => {
    panel.style[property] = "";
  });
}

function updateSettingsForm() {
  const mode = byId("cbo-setting-panel-mode");
  const maxJobs = byId("cbo-setting-max-jobs");
  const previewLimit = byId("cbo-setting-preview-limit");
  const filenameTemplate = byId("cbo-setting-filename-template");
  if (!mode || !maxJobs || !previewLimit || !filenameTemplate) return;
  mode.value = state.settings.panelMode;
  maxJobs.value = String(state.settings.maxJobs);
  previewLimit.value = String(state.settings.previewLimit);
  filenameTemplate.value = state.settings.filenameTemplate;
  renderOutputTemplateSettings();
}

function saveSettingsFromForm() {
  try {
    const maxJobs = Number(byId("cbo-setting-max-jobs").value);
    const previewLimit = Number(byId("cbo-setting-preview-limit").value);
    const filenameTemplate = byId("cbo-setting-filename-template").value.trim();
    if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error("最大任务数必须是正整数");
    if (!Number.isInteger(previewLimit) || previewLimit < 1 || previewLimit > MAX_PREVIEW_LIMIT) {
      throw new Error(`预览任务数必须是 1-${MAX_PREVIEW_LIMIT} 的整数`);
    }
    if (!filenameTemplate) throw new Error("默认保存图片模板不能为空");
    const oldTemplate = state.settings.filenameTemplate;
    state.settings = normalizeSettings({
      ...state.settings,
      maxJobs,
      previewLimit,
      panelMode: byId("cbo-setting-panel-mode").value,
      filenameTemplate,
    });
    if (oldTemplate !== state.settings.filenameTemplate) {
      state.targets.outputs.forEach((target) => {
        if (!Object.hasOwn(state.settings.outputTemplates, target.id)) {
          syncOutputTemplateInputs(target.id, state.settings.filenameTemplate);
        }
      });
    }
    applyPanelPosition();
    updateSettingsForm();
    updateSummary();
    updatePreview();
    const persisted = saveSettings();
    setStatus(persisted ? "设置已保存" : "设置已应用，但浏览器未允许保存", persisted ? "ok" : "error");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function resetPanelPosition() {
  state.settings.position = null;
  if (state.settings.panelMode === "floating") applyPanelPosition(defaultFloatingPosition());
  else applyPanelPosition();
  const persisted = saveSettings();
  setStatus(persisted ? "面板位置已重置" : "面板位置已重置，但未能保存", persisted ? "ok" : "error");
}

function installPanelDrag(element) {
  const header = element.querySelector(".cbo-header");
  let drag;
  const finish = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    header.releasePointerCapture?.(event.pointerId);
    drag = null;
    element.classList.remove("cbo-dragging");
    saveSettings();
  };
  header.addEventListener("pointerdown", (event) => {
    if (state.settings.panelMode !== "floating" || event.button !== 0 || event.target.closest?.("button, input, select, textarea")) return;
    const rect = element.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    header.setPointerCapture?.(event.pointerId);
    element.classList.add("cbo-dragging");
  });
  header.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    state.settings.position = setPanelPosition({
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY,
    });
  });
  header.addEventListener("pointerup", finish);
  header.addEventListener("pointercancel", finish);
}

function updateSummary() {
  const summary = byId("cbo-summary");
  if (!summary) return;
  summary.textContent = `可执行节点：${Object.keys(state.prompt || {}).length}；UNET ${state.targets.unet.length}；LoRA ${state.targets.lora.length}；文本 ${state.targets.text.length}；输出 ${state.targets.outputs.length}；上限 ${state.settings.maxJobs}；预览 ${state.settings.previewLimit} 项`;
}

function setTargetControls() {
  const unetSelect = byId("cbo-unet-node");
  const loraSelect = byId("cbo-lora-node");
  const textSelect = byId("cbo-text-node");
  const outputContainer = byId("cbo-output-nodes");

  fillSelect(
    unetSelect,
    state.targets.unet.map((target) => ({ id: target.id, label: `${target.title} (#${target.id})` })),
    state.targets.unet[0] ? [state.targets.unet[0].id] : [],
  );
  fillSelect(
    loraSelect,
    state.targets.lora.map((target) => ({ id: target.id, label: `${target.title} (#${target.id})` })),
    state.targets.lora[0] ? [state.targets.lora[0].id] : [],
  );
  fillSelect(
    textSelect,
    state.targets.text.map((target) => ({ id: target.id, label: `${target.title} (#${target.id})` })),
    state.targets.text[0] ? [state.targets.text[0].id] : [],
  );

  Promise.all([refreshModelSelect(), refreshLoraSelect()])
    .then(updatePreview)
    .catch((error) => setStatus(`读取模型或 LoRA 列表失败：${error.message}`, "error"));

  outputContainer.replaceChildren();
  state.targets.outputs.forEach((target, index) => {
    const row = document.createElement("div");
    row.className = "cbo-output-row";
    row.dataset.id = target.id;
    const header = document.createElement("div");
    header.className = "cbo-output-header";
    const label = document.createElement("label");
    label.className = "cbo-check-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = target.id;
    checkbox.checked = index === 0;
    checkbox.addEventListener("change", updatePreview);
    const text = document.createElement("span");
    text.textContent = `${target.title} (#${target.id})`;
    label.append(checkbox, text);
    const locate = document.createElement("button");
    locate.type = "button";
    locate.className = "cbo-locate";
    locate.textContent = "定位";
    locate.addEventListener("click", () => locateNode(target.id));
    header.append(label, locate);
    const filename = document.createElement("input");
    filename.type = "text";
    filename.className = "cbo-output-template";
    filename.dataset.outputId = target.id;
    filename.value = outputTemplateFor(target.id);
    filename.spellcheck = false;
    filename.setAttribute("aria-label", `${target.title} 文件名模板`);
    filename.addEventListener("input", () => {
      setOutputTemplate(target.id, filename.value, filename);
      updatePreview();
    });
    row.append(header, filename);
    outputContainer.append(row);
  });
  renderOutputTemplateSettings();

  const firstText = state.targets.text[0];
  if (firstText && !state.templateDirty) {
    byId("cbo-template").value = firstText.inputs.text || "";
  }
  updateSummary();
}

function outputConfigs() {
  return [...document.querySelectorAll("#cbo-output-nodes .cbo-output-row")]
    .filter((row) => row.querySelector("input[type=checkbox]")?.checked)
    .map((row) => ({
      id: row.dataset.id,
      template: row.querySelector(".cbo-output-template")?.value.trim() || state.settings.filenameTemplate,
    }));
}

function collectConfig() {
  const unetId = byId("cbo-unet-node").value;
  const loraId = byId("cbo-lora-node").value;
  const textId = byId("cbo-text-node").value;
  const values = byId("cbo-values").value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const maxJobs = state.settings.maxJobs;
  const models = selectedValues(byId("cbo-models"));
  const loras = state.targets.lora.length ? selectedValues(byId("cbo-loras"), "lora") : [""];
  const config = {
    unetId,
    loraId,
    textId,
    template: byId("cbo-template").value,
    outputs: outputConfigs(),
    models,
    loras,
    values,
    variable: byId("cbo-variable").value.trim(),
    maxJobs,
  };
  if (!config.unetId || !config.textId) throw new Error("请先刷新并选择目标节点");
  if (countJobs(models, loras, values) > maxJobs) {
    throw new Error(`任务数 ${countJobs(models, loras, values)} 超过上限 ${maxJobs}`);
  }
  return config;
}

function sampleJobs(config) {
  const samples = [];
  const iterator = expandJobs(state.prompt, {
    ...config,
  });
  while (samples.length < state.settings.previewLimit) {
    const next = iterator.next();
    if (next.done) break;
    samples.push(next.value);
  }
  return samples;
}

function updatePreview(announce = false) {
  if (!state.prompt) return;
  try {
    const config = collectConfig();
    const total = countJobs(config.models, config.loras, config.values);
    const samples = sampleJobs(config);
    const hasLora = Boolean(config.loraId);
    const lines = [
      `将提交 ${total} 个任务（${hasLora ? "模型 × LoRA × 文本值" : "模型 × 文本值"}）`,
      ...samples.map((job) => [
        `${String(job.index).padStart(3, "0")}  模型：${job.model}`,
        ...(hasLora ? [`    LoRA：${job.lora}`] : []),
        `    文本值：${job.value}`,
        `    文件名：${job.filenamePrefixes.map((output) => `#${output.id}: ${output.prefix}`).join(" | ")}`,
      ].join("\n")),
    ];
    if (total > samples.length) lines.push(`……还有 ${total - samples.length} 个任务`);
    setFieldMessage(lines.join("\n"), "ok");
    if (announce === true) setStatus(`预览已生成：共 ${total} 个任务，仅展示前 ${samples.length} 个`, "ok");
  } catch (error) {
    setFieldMessage(error.message, "error");
    if (announce === true) setStatus(`预览失败：${error.message}`, "error");
  }
}

async function refresh() {
  const refreshButton = byId("cbo-refresh");
  refreshButton.disabled = true;
  setStatus("正在读取当前画布……");
  try {
    state.prompt = await currentPrompt();
    state.targets = discoverTargets(state.prompt, graphNodes());
    state.templateDirty = false;
    setTargetControls();
    if (!state.targets.unet.length) throw new Error("当前可执行工作流没有 UNETLoader");
    if (!state.targets.text.length) throw new Error("当前可执行工作流没有 CLIPTextEncode");
    setStatus("当前画布已读取", "ok");
    updatePreview();
  } catch (error) {
    state.prompt = null;
    state.targets = { unet: [], lora: [], text: [], outputs: [] };
    byId("cbo-summary").textContent = "读取失败";
    setStatus(error.message, "error");
    setFieldMessage("请修正工作流后重新刷新。", "error");
  } finally {
    refreshButton.disabled = false;
  }
}

function taskStatus(status) {
  return {
    queued: "已入队",
    running: "执行中",
    done: "完成",
    failed: "失败",
  }[status] || status;
}

function renderTasks() {
  const list = byId("cbo-tasks");
  list.replaceChildren();
  const recent = state.tasks.slice(-50);
  if (state.taskOrder === "desc") recent.reverse();
  const orderButton = byId("cbo-task-order");
  if (orderButton) {
    const descending = state.taskOrder === "desc";
    orderButton.textContent = descending ? "新→旧" : "旧→新";
    orderButton.title = descending ? "当前最新任务在前，点击切换为最早任务在前" : "当前最早任务在前，点击切换为最新任务在前";
    orderButton.setAttribute("aria-label", orderButton.title);
  }
  for (const task of recent) {
    const row = document.createElement("div");
    const status = document.createElement("span");
    status.className = "cbo-task-status";
    status.textContent = task.error ? "失败" : taskStatus(task.status);
    if (task.error) status.title = task.error;
    const main = document.createElement("span");
    main.className = "cbo-task-main";
    const prefixes = task.filenamePrefixes?.map((output) => output.prefix).join(" | ") || task.filenamePrefix;
    main.textContent = prefixes || "未设置文件名";
    main.title = main.textContent;
    row.className = `cbo-task ${task.status}`;
    row.append(status, main);
    list.append(row);
  }
  const submitted = state.tasks.filter((task) => task.status !== "failed").length;
  const failed = state.tasks.filter((task) => task.status === "failed").length;
  byId("cbo-task-summary").textContent = state.tasks.length
    ? `已处理 ${state.tasks.length}；成功提交 ${submitted}；失败 ${failed}`
    : "尚未提交任务";
}

async function submitPrompt(prompt) {
  const body = { prompt };
  if (api.clientId) body.client_id = api.clientId;
  const response = await api.fetchApi("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error || !data.prompt_id) {
    const detail = data.error?.message || data.error || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return data.prompt_id;
}

async function pollHistory() {
  const pending = state.tasks.filter((task) => task.promptId && ["queued", "running"].includes(task.status));
  if (!pending.length) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    return;
  }
  await Promise.all(pending.map(async (task) => {
    try {
      const history = await getJson(`/history/${encodeURIComponent(task.promptId)}`);
      const entry = history?.[task.promptId];
      if (!entry?.status) return;
      if (entry.status.completed) {
        task.status = entry.status.status_str === "success" ? "done" : "failed";
        if (task.status === "failed") task.error = entry.status.status_str || "执行失败";
      }
    } catch {
      // A history entry can briefly lag behind queue submission.
    }
  }));
  renderTasks();
}

function startPolling() {
  if (!state.pollTimer) state.pollTimer = setInterval(pollHistory, 1500);
  pollHistory();
}

async function submit() {
  const button = byId("cbo-submit");
  button.disabled = true;
  try {
    const config = collectConfig();
    const total = countJobs(config.models, config.loras, config.values);
    if (!total) throw new Error("请至少选择一个模型、LoRA（如有）并提供一个文本值");
    const iterator = expandJobs(state.prompt, {
      ...config,
    });
    let processed = 0;
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      const job = next.value;
      const task = {
        index: job.index,
        model: job.model,
        lora: job.lora,
        value: job.value,
        filenamePrefix: job.filenamePrefix,
        filenamePrefixes: job.filenamePrefixes,
        status: "queued",
        promptId: "",
        error: "",
      };
      try {
        task.promptId = await submitPrompt(job.prompt);
      } catch (error) {
        task.status = "failed";
        task.error = error.message;
      }
      state.tasks.push(task);
      processed += 1;
      setStatus(`已处理 ${processed}/${total}`, task.status === "failed" ? "error" : "ok");
      renderTasks();
    }
    startPolling();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function installStyles() {
  const href = new URL("../css/orchestrator.css", import.meta.url).href;
  if ([...document.querySelectorAll("link[rel=stylesheet]")].some((link) => link.href === href)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

function buildPanel() {
  if (document.getElementById("cbo-panel")) return document.getElementById("cbo-panel");
  const element = document.createElement("section");
  element.id = "cbo-panel";
  element.innerHTML = `
    <header class="cbo-header">
      <div><strong>Batch Orchestrator</strong><span id="cbo-status" class="cbo-status">尚未读取画布</span></div>
      <div class="cbo-header-actions"><button id="cbo-refresh" type="button">刷新当前画布</button><button id="cbo-settings-button" type="button" aria-expanded="false" aria-controls="cbo-settings-panel" aria-label="打开设置" title="设置">⚙</button><button id="cbo-toggle" type="button" aria-expanded="true" aria-controls="cbo-body" aria-label="收起面板" title="收起面板">⌃</button></div>
    </header>
    <div class="cbo-body">
      <div id="cbo-settings-panel" class="cbo-settings-panel" hidden>
        <div class="cbo-settings-heading"><strong>设置</strong><span>只保存在当前浏览器</span></div>
        <label>面板模式<select id="cbo-setting-panel-mode"><option value="fixed">固定（右上角）</option><option value="floating">浮动（可拖动）</option></select></label>
        <label>最大任务数<input id="cbo-setting-max-jobs" type="number" min="1" step="1"></label>
        <label>预览任务数<input id="cbo-setting-preview-limit" type="number" min="1" max="50" step="1"></label>
        <label>默认保存图片模板<input id="cbo-setting-filename-template" type="text" spellcheck="false"></label>
        <div class="cbo-settings-subheading">当前输出节点模板</div>
        <div id="cbo-setting-output-templates" class="cbo-setting-output-templates"></div>
        <div class="cbo-settings-actions"><button id="cbo-reset-position" type="button">重置位置</button><button id="cbo-save-settings" class="primary" type="button">保存设置</button></div>
      </div>
      <div id="cbo-summary" class="cbo-summary">尚未读取画布</div>
      <label>UNET 加载器<div class="cbo-node-control"><select id="cbo-unet-node"></select><button id="cbo-unet-locate" class="cbo-locate" type="button" aria-label="定位 UNET 加载器">定位</button></div></label>
      <label>模型（可多选）<div id="cbo-models" class="cbo-model-tree" aria-label="模型列表"></div></label>
      <label>LoRA 加载器<div class="cbo-node-control"><select id="cbo-lora-node"></select><button id="cbo-lora-locate" class="cbo-locate" type="button" aria-label="定位 LoRA 加载器">定位</button></div></label>
      <label>LoRA（可多选）<div id="cbo-loras" class="cbo-lora-tree" aria-label="LoRA 列表"></div></label>
      <label>CLIP 文本节点<div class="cbo-node-control"><select id="cbo-text-node"></select><button id="cbo-text-locate" class="cbo-locate" type="button" aria-label="定位 CLIP 文本节点">定位</button></div></label>
      <label>文本模板<textarea id="cbo-template" rows="5" placeholder="使用 {{subject}} 作为变量"></textarea></label>
      <div class="cbo-variable-row"><label>变量名<input id="cbo-variable" value="subject" spellcheck="false"></label><button id="cbo-insert-variable" type="button">插入变量</button></div>
      <label>变量值（每行一个）<textarea id="cbo-values" rows="4" placeholder="cat&#10;dog"></textarea></label>
      <fieldset><legend>输出文件名（可逐个设置，支持 {{model}}、{{lora}}、{{value}}、{{index}}、{{seed}}）</legend><div id="cbo-output-nodes" class="cbo-output-nodes"></div></fieldset>
      <pre id="cbo-preview" class="cbo-preview">填好参数后点击“生成预览”；预览数量可在设置中调整，不会提交任务。</pre>
      <div class="cbo-actions"><button id="cbo-preview-button" type="button">生成预览</button><button id="cbo-submit" class="primary" type="button">提交任务</button></div>
      <div class="cbo-task-toolbar"><div id="cbo-task-summary" class="cbo-task-summary">尚未提交任务</div><button id="cbo-task-order" type="button" aria-label="当前最新任务在前，点击切换为最早任务在前">新→旧</button></div>
      <div id="cbo-tasks" class="cbo-tasks"></div>
    </div>`;
  document.body.append(element);

  updateSettingsForm();
  applyPanelPosition();
  installPanelDrag(element);

  byId("cbo-toggle").addEventListener("click", () => {
    const closed = element.classList.toggle("closed");
    const toggle = byId("cbo-toggle");
    toggle.textContent = closed ? "⌄" : "⌃";
    toggle.setAttribute("aria-expanded", String(!closed));
    toggle.setAttribute("aria-label", closed ? "展开面板" : "收起面板");
    toggle.title = closed ? "展开面板" : "收起面板";
  });
  byId("cbo-settings-button").addEventListener("click", () => {
    if (element.classList.contains("closed")) {
      element.classList.remove("closed");
      const toggle = byId("cbo-toggle");
      toggle.textContent = "⌃";
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "收起面板");
      toggle.title = "收起面板";
    }
    const settings = byId("cbo-settings-panel");
    const open = settings.hidden;
    settings.hidden = !open;
    const button = byId("cbo-settings-button");
    button.setAttribute("aria-expanded", String(open));
    if (open) updateSettingsForm();
  });
  byId("cbo-reset-position").addEventListener("click", resetPanelPosition);
  byId("cbo-save-settings").addEventListener("click", saveSettingsFromForm);
  byId("cbo-refresh").addEventListener("click", refresh);
  byId("cbo-submit").addEventListener("click", submit);
  byId("cbo-preview-button").addEventListener("click", () => updatePreview(true));
  byId("cbo-task-order").addEventListener("click", () => {
    state.taskOrder = state.taskOrder === "desc" ? "asc" : "desc";
    renderTasks();
  });
  byId("cbo-insert-variable").addEventListener("click", () => {
    const variable = byId("cbo-variable").value.trim();
    const template = byId("cbo-template");
    if (!variable) {
      setStatus("请先填写变量名", "error");
      return;
    }
    const start = Number.isInteger(template.selectionStart) ? template.selectionStart : template.value.length;
    const end = Number.isInteger(template.selectionEnd) ? template.selectionEnd : start;
    template.setRangeText(`{{${variable}}}`, start, end, "end");
    state.templateDirty = true;
    template.focus();
    setStatus(`已插入 {{${variable}}}`, "ok");
    updatePreview();
  });
  byId("cbo-text-node").addEventListener("change", () => {
    const target = state.targets.text.find((item) => item.id === byId("cbo-text-node").value);
    if (target && !state.templateDirty) byId("cbo-template").value = target.inputs.text || "";
    updatePreview();
  });
  byId("cbo-unet-node").addEventListener("change", () => {
    refreshModelSelect().then(updatePreview).catch((error) => setStatus(`读取模型列表失败：${error.message}`, "error"));
  });
  byId("cbo-lora-node").addEventListener("change", () => {
    refreshLoraSelect().then(updatePreview).catch((error) => setStatus(`读取 LoRA 列表失败：${error.message}`, "error"));
  });
  byId("cbo-unet-locate").addEventListener("click", () => locateNode(byId("cbo-unet-node").value));
  byId("cbo-lora-locate").addEventListener("click", () => locateNode(byId("cbo-lora-node").value));
  byId("cbo-text-locate").addEventListener("click", () => locateNode(byId("cbo-text-node").value));
  byId("cbo-template").addEventListener("input", () => {
    state.templateDirty = true;
    updatePreview();
  });
  ["cbo-models", "cbo-loras", "cbo-variable", "cbo-values"].forEach((id) => {
    byId(id).addEventListener("input", updatePreview);
    byId(id).addEventListener("change", updatePreview);
  });
  window.addEventListener("resize", () => {
    if (panel && state.settings.panelMode === "floating") {
      state.settings.position = setPanelPosition(state.settings.position || defaultFloatingPosition());
    }
  });
  return element;
}

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    installStyles();
    panel = buildPanel();
    applyPanelPosition();
    await refresh();
  },
});
