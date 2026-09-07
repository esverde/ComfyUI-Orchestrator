import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import {
  countJobs,
  DEFAULT_FILENAME_TEMPLATE,
  discoverTargets,
  expandJobs,
} from "./orchestrator-core.js";

const EXTENSION_NAME = "comfyui-batch-orchestrator";
const DEFAULT_MAX_JOBS = 100;
const PREVIEW_LIMIT = 5;

const state = {
  prompt: null,
  targets: { unet: [], text: [], outputs: [] },
  tasks: [],
  templateDirty: false,
  pollTimer: null,
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

function optionValuesFromObjectInfo(data) {
  const definitions = data?.UNETLoader ? [data.UNETLoader] : Object.values(data || {});
  for (const definition of definitions) {
    const raw = definition?.input?.required?.unet_name;
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
    const values = optionValuesFromObjectInfo(await getJson("/object_info/UNETLoader"));
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

function selectedValues(select) {
  return [...select.selectedOptions].map((option) => option.value);
}

async function refreshModelSelect() {
  const selectedUnet = state.targets.unet.find((target) => target.id === byId("cbo-unet-node").value);
  const currentModel = selectedUnet?.inputs?.unet_name || "";
  const values = await modelOptions(currentModel);
  fillSelect(byId("cbo-models"), values, currentModel ? [currentModel] : []);
}

function setTargetControls() {
  const unetSelect = byId("cbo-unet-node");
  const textSelect = byId("cbo-text-node");
  const outputContainer = byId("cbo-output-nodes");

  fillSelect(
    unetSelect,
    state.targets.unet.map((target) => ({ id: target.id, label: `${target.title} (#${target.id})` })),
    state.targets.unet[0] ? [state.targets.unet[0].id] : [],
  );
  fillSelect(
    textSelect,
    state.targets.text.map((target) => ({ id: target.id, label: `${target.title} (#${target.id})` })),
    state.targets.text[0] ? [state.targets.text[0].id] : [],
  );

  refreshModelSelect().then(updatePreview).catch((error) => setStatus(`读取模型列表失败：${error.message}`, "error"));

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
    filename.value = DEFAULT_FILENAME_TEMPLATE;
    filename.spellcheck = false;
    filename.setAttribute("aria-label", `${target.title} 文件名模板`);
    filename.addEventListener("input", updatePreview);
    row.append(header, filename);
    outputContainer.append(row);
  });

  const firstText = state.targets.text[0];
  if (firstText && !state.templateDirty) {
    byId("cbo-template").value = firstText.inputs.text || "";
  }
  byId("cbo-summary").textContent = `可执行节点：${Object.keys(state.prompt || {}).length}；UNET ${state.targets.unet.length}；文本 ${state.targets.text.length}；输出 ${state.targets.outputs.length}`;
}

function outputConfigs() {
  return [...document.querySelectorAll("#cbo-output-nodes .cbo-output-row")]
    .filter((row) => row.querySelector("input[type=checkbox]")?.checked)
    .map((row) => ({
      id: row.dataset.id,
      template: row.querySelector(".cbo-output-template")?.value.trim() || DEFAULT_FILENAME_TEMPLATE,
    }));
}

function collectConfig() {
  const unetId = byId("cbo-unet-node").value;
  const textId = byId("cbo-text-node").value;
  const values = byId("cbo-values").value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const maxJobs = Number(byId("cbo-max-jobs").value) || DEFAULT_MAX_JOBS;
  const models = selectedValues(byId("cbo-models"));
  const config = {
    unetId,
    textId,
    template: byId("cbo-template").value,
    outputs: outputConfigs(),
    models,
    values,
    variable: byId("cbo-variable").value.trim(),
    maxJobs,
  };
  if (!config.unetId || !config.textId) throw new Error("请先刷新并选择目标节点");
  if (countJobs(models, values) > maxJobs) {
    throw new Error(`任务数 ${countJobs(models, values)} 超过上限 ${maxJobs}`);
  }
  return config;
}

function sampleJobs(config) {
  const samples = [];
  const iterator = expandJobs(state.prompt, {
    ...config,
  });
  while (samples.length < PREVIEW_LIMIT) {
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
    const total = countJobs(config.models, config.values);
    const samples = sampleJobs(config);
    const lines = [
      `将提交 ${total} 个任务（模型 × 文本值）`,
      ...samples.map((job) => [
        `${String(job.index).padStart(3, "0")}  模型：${job.model}`,
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
    state.targets = { unet: [], text: [], outputs: [] };
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
  const recent = state.tasks.slice(-50).reverse();
  for (const task of recent) {
    const row = document.createElement("div");
    row.className = `cbo-task ${task.status}`;
    const main = document.createElement("span");
    const prefixes = task.filenamePrefixes?.map((output) => `#${output.id}: ${output.prefix}`).join(" | ") || task.filenamePrefix;
    main.textContent = `#${String(task.index).padStart(3, "0")} ${prefixes}`;
    const status = document.createElement("span");
    status.textContent = task.error ? `失败：${task.error}` : `${taskStatus(task.status)}${task.promptId ? ` · ${task.promptId.slice(0, 8)}` : ""}`;
    row.append(main, status);
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
    const total = countJobs(config.models, config.values);
    if (!total) throw new Error("请至少选择一个模型并提供一个文本值");
    const iterator = expandJobs(state.prompt, {
      ...config,
    });
    let processed = 0;
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      const job = next.value;
      const task = {
        index: job.index,
        model: job.model,
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
      <div class="cbo-header-actions"><button id="cbo-refresh" type="button">刷新当前画布</button><button id="cbo-toggle" type="button" aria-expanded="true" aria-controls="cbo-body" aria-label="收起面板" title="收起面板">⌃</button></div>
    </header>
    <div class="cbo-body">
      <div id="cbo-summary" class="cbo-summary">尚未读取画布</div>
      <label>UNET 加载器<div class="cbo-node-control"><select id="cbo-unet-node"></select><button id="cbo-unet-locate" class="cbo-locate" type="button" aria-label="定位 UNET 加载器">定位</button></div></label>
      <label>模型（可多选）<select id="cbo-models" multiple size="6"></select></label>
      <label>CLIP 文本节点<div class="cbo-node-control"><select id="cbo-text-node"></select><button id="cbo-text-locate" class="cbo-locate" type="button" aria-label="定位 CLIP 文本节点">定位</button></div></label>
      <label>文本模板<textarea id="cbo-template" rows="5" placeholder="使用 {{subject}} 作为变量"></textarea></label>
      <div class="cbo-variable-row"><label>变量名<input id="cbo-variable" value="subject" spellcheck="false"></label><button id="cbo-insert-variable" type="button">插入变量</button></div>
      <label>变量值（每行一个）<textarea id="cbo-values" rows="4" placeholder="cat&#10;dog"></textarea></label>
      <fieldset><legend>输出文件名（可逐个设置）</legend><div id="cbo-output-nodes" class="cbo-output-nodes"></div></fieldset>
      <label>最大任务数<input id="cbo-max-jobs" type="number" min="1" value="100"></label>
      <pre id="cbo-preview" class="cbo-preview">填好参数后点击“生成预览”；只展示前 5 项，不会提交任务。</pre>
      <div class="cbo-actions"><button id="cbo-preview-button" type="button">生成预览</button><button id="cbo-submit" class="primary" type="button">提交任务</button></div>
      <div id="cbo-task-summary" class="cbo-task-summary">尚未提交任务</div>
      <div id="cbo-tasks" class="cbo-tasks"></div>
    </div>`;
  document.body.append(element);

  byId("cbo-toggle").addEventListener("click", () => {
    const closed = element.classList.toggle("closed");
    const toggle = byId("cbo-toggle");
    toggle.textContent = closed ? "⌄" : "⌃";
    toggle.setAttribute("aria-expanded", String(!closed));
    toggle.setAttribute("aria-label", closed ? "展开面板" : "收起面板");
    toggle.title = closed ? "展开面板" : "收起面板";
  });
  byId("cbo-refresh").addEventListener("click", refresh);
  byId("cbo-submit").addEventListener("click", submit);
  byId("cbo-preview-button").addEventListener("click", () => updatePreview(true));
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
  byId("cbo-unet-locate").addEventListener("click", () => locateNode(byId("cbo-unet-node").value));
  byId("cbo-text-locate").addEventListener("click", () => locateNode(byId("cbo-text-node").value));
  byId("cbo-template").addEventListener("input", () => {
    state.templateDirty = true;
    updatePreview();
  });
  ["cbo-models", "cbo-variable", "cbo-values", "cbo-max-jobs"].forEach((id) => {
    byId(id).addEventListener("input", updatePreview);
    byId(id).addEventListener("change", updatePreview);
  });
  return element;
}

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    installStyles();
    panel = buildPanel();
    await refresh();
  },
});
