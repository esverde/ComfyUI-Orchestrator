import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import {
  buildModelTree,
  countJobs,
  DEFAULT_FILENAME_TEMPLATE,
  discoverTargets,
  expandJobs,
} from "./orchestrator-core.js";
import {
  deleteLibraryRecord,
  listLibraryRecords,
  MAX_TEMPLATE_HISTORY,
  mergeLibraryData,
  normalizeLibraryData,
  parseLibraryExport,
  putLibraryRecord,
  replaceLibraryData,
  serializeLibrary,
} from "./orchestrator-library.js";

const EXTENSION_NAME = "comfyui-batch-orchestrator";
const DEFAULT_MAX_JOBS = 500;
const DEFAULT_PREVIEW_LIMIT = 5;
const MAX_PREVIEW_LIMIT = 50;
const SETTINGS_STORAGE_KEY = "comfyui-batch-orchestrator.settings";
const TASK_STATUS = { queued: "已入队", running: "执行中", done: "完成", failed: "失败", cancelled: "已取消" };

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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
    previewLimit: Math.min(positiveInteger(source.previewLimit, DEFAULT_PREVIEW_LIMIT), MAX_PREVIEW_LIMIT),
    loraEnabled: source.loraEnabled !== false,
    clearTasksOnSubmit: source.clearTasksOnSubmit === true,
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
  batches: new Map(),
  taskOrder: "desc",
  templateDirty: false,
  pollTimer: null,
  settings: loadSettings(),
  library: { ...normalizeLibraryData(), ready: false },
  variableSlots: [{ key: "subject", values: [] }],
  variableEditorId: "",
  templateEditorId: "",
};

let panel;
let topbar;

function byId(id) {
  // 顶栏挂载前不在文档里，须回退到元素自身查找，否则绑不上监听器。
  return document.getElementById(id) || topbar?.querySelector(`#${id}`) || null;
}

const SEVERITY = { error: "error", warn: "warn" };

function setStatus(message, kind = "ok") {
  const severity = SEVERITY[kind] || "success";
  app.extensionManager.toast.add({
    severity,
    summary: "Batch Orchestrator",
    detail: String(message),
    life: severity === "error" ? 6000 : 3000,
  });
}

function setFieldMessage(message, kind = "") {
  const element = byId("cbo-preview");
  if (!element) return;
  element.textContent = message;
  element.className = `cbo-preview ${kind}`;
}

function button(text, onClick, { className = "", title = "", ariaLabel = "" } = {}) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.className = ["cbo-btn", className].filter(Boolean).join(" ");
  if (title) element.title = title;
  if (ariaLabel) element.setAttribute("aria-label", ariaLabel);
  element.addEventListener("click", onClick);
  return element;
}

function textRow(container, text, className = "cbo-library-empty") {
  const row = document.createElement("div");
  row.className = className;
  row.textContent = text;
  container.append(row);
}

function libraryRow(title, meta, buttons) {
  const row = document.createElement("div");
  row.className = "cbo-library-record";
  const main = document.createElement("div");
  main.className = "cbo-library-record-main";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("span");
  detail.textContent = meta;
  main.append(heading, detail);
  const actions = document.createElement("div");
  actions.className = "cbo-library-record-actions";
  actions.append(...buttons);
  row.append(main, actions);
  return row;
}

function cloneVariableRecord(record) {
  return { ...record, tags: [...(record.tags || [])] };
}

function variableDimensions(config) {
  return (config.variables || []).map((slot) => slot.values || []);
}

function filteredVariableRecords() {
  const search = byId("cbo-variable-search")?.value.trim().toLocaleLowerCase() || "";
  const tag = byId("cbo-variable-tag-filter")?.value.trim().toLocaleLowerCase() || "";
  return state.library.variables.filter((record) => {
    const haystack = [record.key, record.text, record.label, record.note, ...record.tags]
      .join(" ")
      .toLocaleLowerCase();
    return (!search || haystack.includes(search))
      && (!tag || record.tags.some((value) => value.toLocaleLowerCase() === tag));
  });
}

function renderVariableRecords() {
  const container = byId("cbo-variable-records");
  if (!container) return;
  container.replaceChildren();
  if (!state.library.ready) {
    textRow(container, "IndexedDB 不可用，变量库管理暂不可用；快速输入仍可使用。");
    return;
  }
  const records = filteredVariableRecords();
  if (!records.length) {
    textRow(container, "没有匹配的变量值。");
    return;
  }
  for (const record of records) {
    const meta = [
      record.label && `文件名：${record.label}`,
      record.tags.length && `标签：${record.tags.join("、")}`,
      record.note,
    ].filter(Boolean).join("；");
    container.append(libraryRow(`${record.key} · ${record.text}`, meta, [
      button("编辑", () => openVariableEditor(record)),
      button("删除", () => removeVariableRecord(record.id), { className: "danger" }),
    ]));
  }
}

function openVariableEditor(record = null) {
  state.variableEditorId = record?.id || "";
  byId("cbo-library-key").value = record?.key || state.variableSlots[0]?.key || "subject";
  byId("cbo-library-text").value = record?.text || "";
  byId("cbo-library-label").value = record?.label || "";
  byId("cbo-library-tags").value = record?.tags?.join(", ") || "";
  byId("cbo-library-note").value = record?.note || "";
  byId("cbo-library-save").textContent = record ? "保存修改" : "添加变量值";
  byId("cbo-library-text")?.focus();
}

function clearVariableEditor() {
  state.variableEditorId = "";
  for (const field of ["key", "text", "label", "tags", "note"]) byId(`cbo-library-${field}`).value = "";
  byId("cbo-library-save").textContent = "添加变量值";
}

async function saveVariableRecord() {
  try {
    if (!state.library.ready) throw new Error("变量库不可用，无法保存");
    const existing = state.library.variables.find((record) => record.id === state.variableEditorId);
    const now = Date.now();
    const normalized = normalizeLibraryData({ variables: [{
      id: existing?.id,
      key: byId("cbo-library-key").value.trim(),
      text: byId("cbo-library-text").value,
      label: byId("cbo-library-label").value,
      tags: byId("cbo-library-tags").value,
      note: byId("cbo-library-note").value,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }] }, now).variables[0];
    await putLibraryRecord("variables", normalized);
    const variables = existing
      ? state.library.variables.map((record) => record.id === normalized.id ? normalized : record)
      : [...state.library.variables, normalized];
    state.library = { ...state.library, variables };
    clearVariableEditor();
    renderVariableRecords();
    renderVariableSlots();
    setStatus("变量值已保存", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function removeVariableRecord(id) {
  if (!state.library.ready || !window.confirm("确定删除这个变量值吗？已加入当前组合的副本不会被自动移除。")) return;
  try {
    await deleteLibraryRecord("variables", id);
    state.library = {
      ...state.library,
      variables: state.library.variables.filter((record) => record.id !== id),
    };
    renderVariableRecords();
    renderVariableSlots();
    setStatus("变量值已删除", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function addSlotValue(slot, text) {
  const value = String(text).trim();
  if (!value) return false;
  if (slot.values.some((item) => item.text === value)) return false;
  // 复用库记录的 label/tags，{{变量名_label}} 才有内容。
  const known = state.library.variables.find((record) => record.key === slot.key && record.text === value);
  slot.values.push(known ? cloneVariableRecord(known) : { key: slot.key, text: value, label: "", tags: [] });
  return true;
}

function renderSlotValues(container, slot) {
  container.replaceChildren();
  if (!slot.values.length) {
    textRow(container, "还没有值。在上方输入后回车添加。", "cbo-variable-hint");
    return;
  }
  slot.values.forEach((value, valueIndex) => {
    const chip = document.createElement("span");
    chip.className = "cbo-variable-chip";
    const text = document.createElement("span");
    text.className = "cbo-variable-chip-text";
    text.textContent = value.label ? `${value.text} [${value.label}]` : value.text;
    text.title = value.text;
    chip.append(text, button("×", () => {
      slot.values.splice(valueIndex, 1);
      renderVariableSlots();
      updatePreview();
    }, { className: "cbo-variable-chip-remove", ariaLabel: `移除 ${value.text}` }));
    container.append(chip);
  });
}

function renderVariableSlots() {
  const container = byId("cbo-variable-slots");
  if (!container) return;
  container.replaceChildren();

  state.variableSlots.forEach((slot, slotIndex) => {
    const section = document.createElement("section");
    section.className = "cbo-variable-slot";

    const header = document.createElement("div");
    header.className = "cbo-variable-slot-header";
    const key = document.createElement("input");
    key.type = "text";
    key.className = "cbo-variable-key";
    key.value = slot.key;
    key.placeholder = "变量名，如 top";
    key.spellcheck = false;
    key.setAttribute("aria-label", `第 ${slotIndex + 1} 个变量名`);
    key.addEventListener("input", () => {
      slot.key = key.value.trim();
      slot.values.forEach((value) => { value.key = slot.key; });
      count.textContent = `${slot.values.length} 个值`;
    });
    key.addEventListener("change", () => {
      renderVariableSlots();
      updatePreview();
    });
    const count = document.createElement("span");
    count.className = "cbo-variable-slot-count";
    count.textContent = `${slot.values.length} 个值`;
    const insert = button("插入", () => insertPlaceholder(slot.key),
      { title: `把 {{${slot.key}}} 插入文本模板` });
    const save = button("存入库", () => saveSlotValuesToLibrary(slotIndex),
      { title: "把这个变量的所有值保存到变量库" });
    const remove = button("×", () => {
      state.variableSlots.splice(slotIndex, 1);
      if (!state.variableSlots.length) state.variableSlots.push({ key: "subject", values: [] });
      renderVariableSlots();
      updatePreview();
    }, { className: "danger", title: "删除这个变量", ariaLabel: `删除变量 ${slot.key || slotIndex + 1}` });
    header.append(key, count, insert, save, remove);

    const listId = `cbo-variable-options-${slotIndex}`;
    const datalist = document.createElement("datalist");
    datalist.id = listId;
    for (const record of state.library.variables.filter((item) => item.key === slot.key)) {
      const option = document.createElement("option");
      option.value = record.text;
      if (record.label) option.label = record.label;
      datalist.append(option);
    }

    const entry = document.createElement("input");
    entry.type = "text";
    entry.className = "cbo-variable-entry";
    entry.placeholder = "输入值后回车添加；多个值可用换行或逗号粘贴";
    entry.setAttribute("list", listId);
    entry.setAttribute("aria-label", `为 ${slot.key || "变量"} 添加值`);
    const commit = () => {
      const parts = entry.value.split(/[\r\n,，]/);
      const added = parts.filter((part) => addSlotValue(slot, part)).length;
      entry.value = "";
      if (!added) return;
      renderVariableSlots();
      updatePreview();
      // 重渲染销毁了输入框，还回焦点才能连续录入。
      byId("cbo-variable-slots")?.querySelectorAll(".cbo-variable-entry")[slotIndex]?.focus();
    };
    entry.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    });
    entry.addEventListener("change", commit);

    const values = document.createElement("div");
    values.className = "cbo-variable-values";
    renderSlotValues(values, slot);

    section.append(header, entry, datalist, values);
    container.append(section);
  });

  const summary = byId("cbo-variable-summary");
  if (summary) {
    const counts = state.variableSlots.map((slot) => `${slot.key || "未命名"}（${slot.values.length}）`);
    const total = state.variableSlots.every((slot) => slot.values.length)
      ? countJobs(...state.variableSlots.map((slot) => slot.values))
      : 0;
    summary.textContent = `${counts.join(" × ")} = ${total || "待补全"} 种组合`;
  }
}

function insertPlaceholder(name) {
  const variable = String(name || "").trim();
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
}

function addVariableSlot() {
  const used = new Set(state.variableSlots.map((slot) => slot.key));
  let index = state.variableSlots.length + 1;
  while (used.has(`variable${index}`)) index += 1;
  state.variableSlots.push({ key: `variable${index}`, values: [] });
  renderVariableSlots();
  updatePreview();
}

async function saveSlotValuesToLibrary(slotIndex) {
  try {
    if (!state.library.ready) throw new Error("变量库不可用，无法保存");
    const slot = state.variableSlots[slotIndex];
    if (!slot?.key) throw new Error("请先填写变量名");
    if (!slot.values.length) throw new Error("这个变量还没有值");
    const now = Date.now();
    const nextVariables = [...state.library.variables];
    const saved = [];
    for (const value of slot.values) {
      const existing = nextVariables.find((record) => record.key === slot.key
        && record.text === value.text
        && record.label === (value.label || ""));
      if (existing) {
        saved.push(cloneVariableRecord(existing));
        continue;
      }
      const record = normalizeLibraryData({
        variables: [{ key: slot.key, text: value.text, label: value.label, tags: value.tags }],
      }, now).variables[0];
      nextVariables.push(record);
      saved.push(cloneVariableRecord(record));
    }
    const next = normalizeLibraryData({ ...state.library, variables: nextVariables }, now);
    await replaceLibraryData(next);
    state.library = { ...next, ready: true };
    slot.values = saved;
    renderVariableSlots();
    renderVariableRecords();
    setStatus(`已保存 ${saved.length} 个变量值到库`, "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function saveVariableSet() {
  try {
    if (!state.library.ready) throw new Error("变量库不可用，无法保存组合");
    const slots = state.variableSlots.filter((slot) => slot.key && slot.values.length);
    if (!slots.length) throw new Error("请先填好至少一个变量和它的值");
    const existingNames = state.library.variableSets.map((record) => record.name).join("、");
    const name = window.prompt(
      existingNames ? `组合名称（同名会覆盖）。已有：${existingNames}` : "组合名称",
      "",
    );
    if (name === null) return;
    const now = Date.now();
    const existing = state.library.variableSets.find((record) => record.name === name.trim());
    const normalized = normalizeLibraryData({ variableSets: [{
      id: existing?.id,
      name,
      slots: slots.map((slot) => ({
        key: slot.key,
        values: slot.values.map(({ text, label, tags }) => ({ text, label, tags })),
      })),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }] }, now).variableSets[0];
    await putLibraryRecord("variableSets", normalized);
    const variableSets = existing
      ? state.library.variableSets.map((record) => record.id === normalized.id ? normalized : record)
      : [...state.library.variableSets, normalized];
    state.library = { ...state.library, variableSets };
    renderVariableSets();
    setStatus(`组合「${normalized.name}」已保存`, "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function loadVariableSet(record) {
  state.variableSlots = record.slots.map((slot) => ({
    key: slot.key,
    values: slot.values.map((value) => ({ key: slot.key, ...cloneVariableRecord(value) })),
  }));
  renderVariableSlots();
  updatePreview();
  setStatus(`已载入组合：${record.name}`, "ok");
}

async function removeVariableSet(id) {
  if (!state.library.ready || !window.confirm("确定删除这个组合吗？当前面板上的变量不会被清空。")) return;
  try {
    await deleteLibraryRecord("variableSets", id);
    state.library = {
      ...state.library,
      variableSets: state.library.variableSets.filter((record) => record.id !== id),
    };
    renderVariableSets();
    setStatus("组合已删除", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderVariableSets() {
  const container = byId("cbo-variable-sets");
  if (!container) return;
  container.replaceChildren();
  if (!state.library.ready) {
    textRow(container, "IndexedDB 不可用，组合保存暂不可用。");
    return;
  }
  if (!state.library.variableSets.length) {
    textRow(container, "还没有保存的组合。在主面板配好变量后点「保存组合」。");
    return;
  }
  for (const record of state.library.variableSets) {
    const counts = record.slots.map((slot) => `${slot.key}（${slot.values.length}）`);
    const total = countJobs(...record.slots.map((slot) => slot.values));
    container.append(libraryRow(record.name, `${counts.join(" × ")} = ${total} 种组合`, [
      button("载入", () => loadVariableSet(record)),
      button("删除", () => removeVariableSet(record.id), { className: "danger" }),
    ]));
  }
}

function renderTemplates() {
  const container = byId("cbo-template-records");
  if (!container) return;
  container.replaceChildren();
  if (!state.library.ready) {
    textRow(container, "IndexedDB 不可用，模板保存和历史暂不可用。");
    return;
  }
  if (!state.library.templates.length) {
    textRow(container, "还没有已保存模板。");
    return;
  }
  for (const record of state.library.templates) {
    container.append(libraryRow(record.name, record.body, [
      button("预览", (event) => event.currentTarget.closest(".cbo-library-record").classList.toggle("cbo-expanded")),
      button("加载", () => loadTemplate(record)),
      button("编辑", () => openTemplateEditor(record)),
      button("删除", () => removeTemplate(record.id), { className: "danger" }),
    ]));
  }
}

function renderTemplateHistory() {
  const container = byId("cbo-template-history");
  if (!container) return;
  container.replaceChildren();
  if (!state.library.templateHistory.length) {
    textRow(container, "还没有模板使用历史。");
    return;
  }
  for (const record of state.library.templateHistory) {
    const row = document.createElement("div");
    row.className = "cbo-library-history-row";
    const text = document.createElement("span");
    text.textContent = `${record.name}：${record.body}`;
    row.append(text, button("加载", () => loadTemplate(record)));
    container.append(row);
  }
}

function renderTemplateRecords() {
  renderTemplates();
  renderTemplateHistory();
}

function openTemplateEditor(record = null) {
  state.templateEditorId = record?.id || "";
  byId("cbo-template-name").value = record?.name || "";
  byId("cbo-template-tags").value = record?.tags?.join(", ") || "";
  if (record) {
    byId("cbo-template").value = record.body;
    state.templateDirty = true;
    updatePreview();
  }
  byId("cbo-template-name")?.focus();
}

function loadTemplate(record) {
  byId("cbo-template").value = record.body;
  state.templateDirty = true;
  updatePreview();
  setStatus(`已加载模板：${record.name}`, "ok");
}

function clearTemplateEditor() {
  state.templateEditorId = "";
  byId("cbo-template-name").value = "";
  byId("cbo-template-tags").value = "";
}

async function saveCurrentTemplate() {
  try {
    if (!state.library.ready) throw new Error("变量库不可用，无法保存模板");
    const name = byId("cbo-template-name").value.trim();
    const body = byId("cbo-template").value;
    if (!name) throw new Error("模板名称不能为空");
    if (!body.trim()) throw new Error("模板内容不能为空");
    const existing = state.library.templates.find((record) => record.id === state.templateEditorId)
      || state.library.templates.find((record) => record.name === name);
    const now = Date.now();
    const normalized = normalizeLibraryData({ templates: [{
      id: existing?.id,
      name,
      body,
      tags: byId("cbo-template-tags").value,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt || 0,
    }] }, now).templates[0];
    await putLibraryRecord("templates", normalized);
    const templates = existing
      ? state.library.templates.map((record) => record.id === normalized.id ? normalized : record)
      : [...state.library.templates, normalized];
    state.library = { ...state.library, templates };
    clearTemplateEditor();
    renderTemplateRecords();
    setStatus("模板已保存", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function removeTemplate(id) {
  if (!state.library.ready || !window.confirm("确定删除这个模板吗？")) return;
  try {
    await deleteLibraryRecord("templates", id);
    state.library = {
      ...state.library,
      templates: state.library.templates.filter((record) => record.id !== id),
    };
    renderTemplateRecords();
    setStatus("模板已删除", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function recordTemplateUse(body) {
  if (!state.library.ready || !String(body || "").trim()) return;
  try {
    const existing = state.library.templateHistory.find((record) => record.body === body);
    const now = Date.now();
    const history = normalizeLibraryData({ templateHistory: [
      ...state.library.templateHistory.filter((record) => record.id !== existing?.id),
      {
        id: existing?.id,
        name: byId("cbo-template-name")?.value.trim() || existing?.name || "最近使用",
        body,
        lastUsedAt: now,
      },
    ] }, now).templateHistory;
    const next = normalizeLibraryData({ ...state.library, templateHistory: history }, now);
    await replaceLibraryData(next);
    state.library = { ...next, ready: true };
    renderTemplateRecords();
  } catch (error) {
    setStatus(`模板历史未保存：${error.message}`, "error");
  }
}

function exportLibrary() {
  if (!state.library.ready) {
    setStatus("变量库不可用，无法导出", "error");
    return;
  }
  const blob = new Blob([serializeLibrary(state.library)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "comfyui-batch-orchestrator-library.json";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("变量库已导出", "ok");
}

async function importLibrary(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (!state.library.ready) throw new Error("变量库不可用，无法导入");
    const incoming = parseLibraryExport(await file.text());
    const merged = mergeLibraryData(state.library, incoming);
    await replaceLibraryData(merged);
    state.library = { ...merged, ready: true };
    renderLibrary();
    setStatus("变量库已导入并合并", "ok");
  } catch (error) {
    setStatus(`导入失败：${error.message}`, "error");
  }
}

function renderLibrary() {
  renderVariableRecords();
  renderVariableSets();
  renderTemplateRecords();
  renderVariableSlots();
}

async function loadLibraryState() {
  try {
    const [variables, variableSets, templates, templateHistory] = await Promise.all(
      ["variables", "variableSets", "templates", "templateHistory"].map(listLibraryRecords),
    );
    const data = normalizeLibraryData({ variables, variableSets, templates, templateHistory });
    state.library = { ...data, ready: true };
  } catch (error) {
    state.library = { ...normalizeLibraryData(), ready: false };
    setStatus(`变量库不可用：${error.message}`, "error");
  }
  renderLibrary();
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
  canvas.deselectAll();
  canvas.select(node);
  canvas.fitViewToSelectionAnimated();
  canvas.setDirty(true, true);
  setStatus(`已定位并高亮：${node.title || node.type || `节点 #${id}`}`, "ok");
}

async function currentPrompt() {
  const result = await app.graphToPrompt();
  const prompt = result?.output || result;
  if (!prompt || typeof prompt !== "object" || !Object.keys(prompt).length) {
    throw new Error("当前画布没有可执行的 API 工作流");
  }
  return prompt;
}

function postJson(path, body) {
  return api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

async function listOptions(nodeType, inputName, currentValue) {
  try {
    const values = optionValuesFromObjectInfo(await getJson(`/object_info/${nodeType}`), nodeType, inputName);
    if (values.length) return values;
  } catch {
    // 读不到列表时退回当前工作流的取值。
  }
  return currentValue ? [currentValue] : [];
}

function fillSelect(select, targets) {
  select.replaceChildren();
  targets.forEach((target, index) => {
    const option = document.createElement("option");
    option.value = String(target.id);
    option.textContent = `${target.title} (#${target.id})`;
    option.selected = index === 0;
    select.append(option);
  });
}

function selectedValues(container) {
  return [...(container?.querySelectorAll("input[data-tree-value]:checked") || [])]
    .map((input) => input.dataset.treeValue);
}

function treeLeavesIn(row) {
  return [...(row?.nextElementSibling?.querySelectorAll("input[data-tree-value]") || [])];
}

function updateTreeStates(container) {
  [...container.querySelectorAll("input[data-tree-folder]")].forEach((folder) => {
    const row = folder.closest(".cbo-tree-row");
    const leaves = treeLeavesIn(row);
    const selected = leaves.filter((leaf) => leaf.checked).length;
    folder.checked = leaves.length > 0 && selected === leaves.length;
    folder.indeterminate = selected > 0 && selected < leaves.length;
    row?.setAttribute("aria-checked", folder.indeterminate ? "mixed" : String(folder.checked));
  });
}

function appendTreeNode(container, node, selected, level) {
  const row = document.createElement("div");
  row.className = `cbo-tree-row cbo-tree-${node.type}`;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(level));

  if (node.type === "folder") {
    row.setAttribute("aria-expanded", "false");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cbo-tree-toggle";
    toggle.innerHTML = CHEVRON;
    toggle.setAttribute("aria-label", `展开${node.name}`);
    const label = document.createElement("label");
    label.className = "cbo-tree-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.treeFolder = node.path;
    const text = document.createElement("span");
    text.textContent = node.name;
    label.append(checkbox, text);
    row.append(toggle, label);

    const children = document.createElement("div");
    children.className = "cbo-tree-children";
    children.setAttribute("role", "group");
    children.hidden = true;
    node.children.forEach((child) => appendTreeNode(children, child, selected, level + 1));
    container.append(row, children);

    toggle.addEventListener("click", () => {
      const expanded = !children.hidden;
      children.hidden = expanded;
      row.setAttribute("aria-expanded", String(!expanded));
      toggle.classList.toggle("cbo-open", !expanded);
      toggle.setAttribute("aria-label", `${expanded ? "展开" : "折叠"}${node.name}`);
    });
    checkbox.addEventListener("change", () => {
      treeLeavesIn(row).forEach((leaf) => { leaf.checked = checkbox.checked; });
      updateTreeStates(container);
    });
    return;
  }

  const spacer = document.createElement("span");
  spacer.className = "cbo-tree-spacer";
  const label = document.createElement("label");
  label.className = "cbo-tree-label";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.treeValue = node.value;
  checkbox.checked = selected.has(node.value);
  const text = document.createElement("span");
  text.textContent = node.name;
  text.title = node.value;
  label.append(checkbox, text);
  row.append(spacer, label);
  container.append(row);
  checkbox.addEventListener("change", () => updateTreeStates(container));
}

function renderValueTree(container, values, selectedValuesList, emptyLabel, rootName) {
  container.replaceChildren();
  container.setAttribute("role", "tree");
  const tree = buildModelTree(values);
  if (!tree.length) {
    textRow(container, emptyLabel, "cbo-tree-empty");
    return;
  }
  appendTreeNode(
    container,
    { type: "folder", name: rootName, path: "", children: tree },
    new Set(selectedValuesList),
    1,
  );
  updateTreeStates(container);
  revealCheckedLeaves(container);
}

// 树默认全折叠，已勾选项必须展开祖先，否则预选中的模型不可见。
function revealCheckedLeaves(container) {
  for (const leaf of container.querySelectorAll("input[data-tree-value]:checked")) {
    for (let group = leaf.closest(".cbo-tree-children"); group; group = group.parentElement?.closest(".cbo-tree-children")) {
      group.hidden = false;
      const row = group.previousElementSibling;
      if (!row?.classList.contains("cbo-tree-row")) continue;
      row.setAttribute("aria-expanded", "true");
      const toggle = row.querySelector(".cbo-tree-toggle");
      if (!toggle) continue;
      toggle.classList.add("cbo-open");
      toggle.setAttribute("aria-label", `折叠${row.querySelector(".cbo-tree-label span")?.textContent || ""}`);
    }
  }
}

async function refreshModelSelect() {
  const container = byId("cbo-models");
  const selectedUnet = state.targets.unet.find((target) => target.id === byId("cbo-unet-node").value);
  const currentModel = selectedUnet?.inputs?.unet_name || "";
  const values = await listOptions("UNETLoader", "unet_name", currentModel);
  const selected = currentModel ? [currentModel] : selectedValues(container);
  renderValueTree(container, values, selected, "没有可用模型", "全部模型");
}

async function refreshLoraSelect() {
  const container = byId("cbo-loras");
  if (!state.settings.loraEnabled) {
    container.replaceChildren();
    return;
  }
  const selectedLora = state.targets.lora.find((target) => target.id === byId("cbo-lora-node").value);
  const currentLora = selectedLora?.inputs?.lora_name || "";
  const values = selectedLora
    ? await listOptions("LoraLoaderModelOnly", "lora_name", currentLora)
    : [];
  const selected = currentLora ? [currentLora] : selectedValues(container);
  renderValueTree(container, values, selected, "没有可用 LoRA", "全部 LoRA");
}

function outputTemplateFor(id) {
  // ponytail: node-id keys are enough for the current workflow; use a workflow fingerprint if cross-workflow collisions matter.
  const key = String(id);
  return Object.hasOwn(state.settings.outputTemplates, key)
    ? state.settings.outputTemplates[key]
    : state.settings.filenameTemplate;
}

function writeTemplateInputs(key, value, skip = null) {
  document.querySelectorAll(".cbo-output-template, .cbo-setting-output-template").forEach((input) => {
    if (input.dataset.outputId === key && input !== skip) input.value = value;
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
  writeTemplateInputs(key, outputTemplateFor(key), sourceInput);
  saveSettings();
}

function renderOutputTemplateSettings() {
  const container = byId("cbo-setting-output-templates");
  if (!container) return;
  container.replaceChildren();
  if (!state.targets.outputs.length) {
    textRow(container, "刷新画布后可为每个输出节点设置单独模板。", "cbo-settings-hint");
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

function positionPanel() {
  if (!panel || panel.hidden || !topbar) return;
  const anchor = topbar.getBoundingClientRect();
  const width = panel.offsetWidth || 370;
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - width - 8));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(anchor.bottom + 6)}px`;
  const body = panel.querySelector(".cbo-body");
  if (body) body.style.maxHeight = `${Math.max(160, Math.round(window.innerHeight - anchor.bottom - 24))}px`;
}

function setPanelOpen(open) {
  panel.hidden = !open;
  const toggle = byId("cbo-toggle");
  toggle.classList.toggle("cbo-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "收起面板" : "展开面板");
  toggle.title = open ? "收起面板" : "展开面板";
  if (open) positionPanel();
}

function applyLoraVisibility() {
  const section = byId("cbo-lora-section");
  if (section) section.hidden = !state.settings.loraEnabled;
}

function updateSettingsForm() {
  const maxJobs = byId("cbo-setting-max-jobs");
  const previewLimit = byId("cbo-setting-preview-limit");
  const filenameTemplate = byId("cbo-setting-filename-template");
  const loraEnabled = byId("cbo-setting-lora-enabled");
  const clearTasks = byId("cbo-setting-clear-tasks");
  if (!maxJobs || !previewLimit || !filenameTemplate || !loraEnabled || !clearTasks) return;
  maxJobs.value = String(state.settings.maxJobs);
  previewLimit.value = String(state.settings.previewLimit);
  filenameTemplate.value = state.settings.filenameTemplate;
  loraEnabled.checked = state.settings.loraEnabled;
  clearTasks.checked = state.settings.clearTasksOnSubmit;
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
    const oldLoraEnabled = state.settings.loraEnabled;
    state.settings = normalizeSettings({
      ...state.settings,
      maxJobs,
      previewLimit,
      loraEnabled: byId("cbo-setting-lora-enabled").checked,
      clearTasksOnSubmit: byId("cbo-setting-clear-tasks").checked,
      filenameTemplate,
    });
    if (oldTemplate !== state.settings.filenameTemplate) {
      state.targets.outputs.forEach((target) => {
        if (!Object.hasOwn(state.settings.outputTemplates, target.id)) {
          writeTemplateInputs(String(target.id), state.settings.filenameTemplate);
        }
      });
    }
    applyLoraVisibility();
    if (!oldLoraEnabled && state.settings.loraEnabled) {
      refreshLoraSelect().then(() => updatePreview()).catch((error) => setStatus(`读取 LoRA 列表失败：${error.message}`, "error"));
    }
    updateSettingsForm();
    updateSummary();
    updatePreview();
    const persisted = saveSettings();
    setStatus(persisted ? "设置已保存" : "设置已应用，但浏览器未允许保存", persisted ? "ok" : "error");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function updateSummary() {
  const summary = byId("cbo-summary");
  if (!summary) return;
  summary.textContent = `可执行节点：${Object.keys(state.prompt || {}).length}；UNET ${state.targets.unet.length}；LoRA ${state.targets.lora.length}；文本 ${state.targets.text.length}；输出 ${state.targets.outputs.length}；上限 ${state.settings.maxJobs}；预览 ${state.settings.previewLimit} 项`;
}

function setTargetControls() {
  const outputContainer = byId("cbo-output-nodes");
  fillSelect(byId("cbo-unet-node"), state.targets.unet);
  fillSelect(byId("cbo-lora-node"), state.targets.lora);
  fillSelect(byId("cbo-text-node"), state.targets.text);

  Promise.all([refreshModelSelect(), refreshLoraSelect()])
    .then(() => updatePreview())
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
    checkbox.addEventListener("change", () => updatePreview());
    const text = document.createElement("span");
    text.textContent = `${target.title} (#${target.id})`;
    label.append(checkbox, text);
    header.append(label, button("定位", () => locateNode(target.id), { className: "cbo-locate" }));
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

function loraActive() {
  return state.settings.loraEnabled && state.targets.lora.length > 0;
}

function collectConfig() {
  const maxJobs = state.settings.maxJobs;
  const models = selectedValues(byId("cbo-models"));
  const loras = loraActive() ? selectedValues(byId("cbo-loras")) : [""];
  const variables = state.variableSlots.map((slot) => ({
    key: slot.key,
    values: slot.values.map(cloneVariableRecord),
  }));
  const dimensions = variableDimensions({ variables });
  const config = {
    unetId: byId("cbo-unet-node").value,
    loraId: loraActive() ? byId("cbo-lora-node").value : "",
    textId: byId("cbo-text-node").value,
    template: byId("cbo-template").value,
    outputs: outputConfigs(),
    models,
    loras,
    variables,
    maxJobs,
  };
  if (!config.unetId || !config.textId) throw new Error("请先刷新并选择目标节点");
  if (!models.length) throw new Error("请至少选择一个 UNET 模型");
  if (!loras.length) throw new Error("请至少选择一个 LoRA");
  if (variables.some((slot) => !slot.key)) throw new Error("每个变量都需要填写变量名");
  if (dimensions.some((valuesForSlot) => !valuesForSlot.length)) {
    throw new Error("每个变量至少需要一个值");
  }
  const total = countJobs(models, loras, ...dimensions);
  if (total > maxJobs) {
    throw new Error(`任务数 ${total} 超过上限 ${maxJobs}`);
  }
  return config;
}

function sampleJobs(config) {
  const samples = [];
  const iterator = expandJobs(state.prompt, config);
  while (samples.length < state.settings.previewLimit) {
    const next = iterator.next();
    if (next.done) break;
    samples.push(next.value);
  }
  return samples;
}

function updatePreview(announce = false) {
  if (!state.prompt) return false;
  try {
    const config = collectConfig();
    const total = countJobs(config.models, config.loras, ...variableDimensions(config));
    const samples = sampleJobs(config);
    const hasLora = Boolean(config.loraId);
    const hasMultipleVariables = config.variables.length > 1;
    const lines = [
      `将提交 ${total} 个任务（${hasLora ? "模型 × LoRA × " : "模型 × "}${hasMultipleVariables ? "变量组合" : "文本值"}）`,
      ...samples.map((job) => [
        `${String(job.index).padStart(3, "0")}  模型：${job.model}`,
        ...(hasLora ? [`    LoRA：${job.lora}`] : []),
        ...(job.variables || []).map((variable) => `    ${variable.key}：${variable.label || variable.text}`),
        `    文件名：${job.filenamePrefixes.map((output) => `#${output.id}: ${output.prefix}`).join(" | ")}`,
      ].join("\n")),
    ];
    if (total > samples.length) lines.push(`……还有 ${total - samples.length} 个任务`);
    setFieldMessage(lines.join("\n"), "ok");
    if (announce) setStatus(`预览已生成：共 ${total} 个任务，仅展示前 ${samples.length} 个`, "ok");
    return config;
  } catch (error) {
    setFieldMessage(error.message, "error");
    if (announce) setStatus(`预览失败：${error.message}`, "error");
    return false;
  }
}

async function refresh() {
  const refreshButton = byId("cbo-refresh");
  refreshButton.disabled = true;
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

function batchLabel(batch) {
  const tasks = state.tasks.filter((task) => task.batch === batch);
  const time = new Date(tasks[0]?.submittedAt || Date.now()).toLocaleTimeString("zh-CN", { hour12: false });
  const done = tasks.filter((task) => task.status === "done").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const suffix = failed ? ` · 失败 ${failed}` : "";
  return `第 ${batch} 批 · ${time} · ${tasks.length} 个 · 完成 ${done}${suffix}`;
}

function pendingTasks() {
  return state.tasks.filter((task) => task.promptId && ["queued", "running"].includes(task.status));
}

function clearTasks() {
  state.tasks = [];
  state.batches.clear();
  renderTasks();
}

function failedTasks() {
  return state.tasks.filter((task) => task.status === "failed");
}

async function currentRunningId() {
  try {
    return (await getJson("/queue"))?.queue_running?.[0]?.[1] || "";
  } catch {
    return "";
  }
}

// expandJobs 对同一输入必然产出同样顺序，按 index 即可精确定位要重发的任务。
async function retryFailedTasks() {
  const failed = failedTasks();
  if (!failed.length) return;
  if (!window.confirm(`确定重新提交 ${failed.length} 个失败任务吗？`)) return;
  let resubmitted = 0;
  for (const [batch, source] of state.batches) {
    const wanted = new Map(failed.filter((task) => task.batch === batch).map((task) => [task.index, task]));
    if (!wanted.size) continue;
    for (const job of expandJobs(source.prompt, source.config)) {
      const task = wanted.get(job.index);
      if (!task) continue;
      try {
        task.promptId = await submitPrompt(job.prompt);
        task.status = "queued";
        task.error = "";
        resubmitted += 1;
      } catch (error) {
        task.error = error.message;
      }
      renderTasks();
    }
  }
  if (resubmitted) startPolling();
  setStatus(
    `已重新提交 ${resubmitted}/${failed.length} 个任务`,
    resubmitted === failed.length ? "ok" : "warn",
  );
}

async function cancelPendingTasks() {
  const pending = pendingTasks();
  if (!pending.length) return;
  if (!window.confirm(`确定取消 ${pending.length} 个未完成任务吗？`)) return;
  try {
    await postJson("/queue", { delete: pending.map((task) => task.promptId) });
    // /interrupt 会中断当前执行的任何任务，先确认正在跑的确实是我们的，避免误杀。
    const running = await currentRunningId();
    if (pending.some((task) => task.promptId === running)) {
      await api.fetchApi("/interrupt", { method: "POST" });
    }
    for (const task of pending) {
      task.status = "cancelled";
      task.error = "已取消";
    }
    renderTasks();
    setStatus(`已取消 ${pending.length} 个任务`, "ok");
  } catch (error) {
    setStatus(`取消失败：${error.message}`, "error");
  }
}

function renderTasks() {
  const list = byId("cbo-tasks");
  list.replaceChildren();
  const recent = state.tasks.slice(-50);
  if (state.taskOrder === "desc") recent.reverse();
  const orderButton = byId("cbo-task-order");
  const descending = state.taskOrder === "desc";
  orderButton.textContent = descending ? "新→旧" : "旧→新";
  orderButton.title = descending ? "当前最新任务在前，点击切换为最早任务在前" : "当前最早任务在前，点击切换为最新任务在前";
  orderButton.setAttribute("aria-label", orderButton.title);
  let lastBatch = null;
  for (const task of recent) {
    if (task.batch !== lastBatch) {
      lastBatch = task.batch;
      textRow(list, batchLabel(task.batch), "cbo-task-batch");
    }
    const row = document.createElement("div");
    const status = document.createElement("span");
    status.className = "cbo-task-status";
    status.textContent = TASK_STATUS[task.status] || task.status;
    if (task.error) status.title = task.error;
    const main = document.createElement("span");
    main.className = "cbo-task-main";
    main.textContent = task.filenamePrefixes.map((output) => output.prefix).join(" | ") || "未设置文件名";
    main.title = task.error || main.textContent;
    row.className = `cbo-task ${task.status}`;
    row.append(status, main);
    list.append(row);
  }
  const failed = failedTasks().length;
  const submitted = state.tasks.length - failed;
  byId("cbo-task-summary").textContent = state.tasks.length
    ? `已处理 ${state.tasks.length}；成功提交 ${submitted}；失败 ${failed}`
    : "尚未提交任务";
  byId("cbo-task-clear").disabled = !state.tasks.length;
  byId("cbo-task-cancel").disabled = !pendingTasks().length;
  byId("cbo-task-retry").disabled = !failedTasks().length;
}

async function submitPrompt(prompt) {
  const body = { prompt };
  if (api.clientId) body.client_id = api.clientId;
  const response = await postJson("/prompt", body);
  const data = await response.json();
  if (!response.ok || data.error || !data.prompt_id) {
    const detail = data.error?.message || data.error || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return data.prompt_id;
}

async function pollHistory() {
  const pending = pendingTasks();
  if (!pending.length) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    return;
  }
  const running = await currentRunningId();
  await Promise.all(pending.map(async (task) => {
    task.status = task.promptId === running ? "running" : "queued";
    try {
      const history = await getJson(`/history/${encodeURIComponent(task.promptId)}`);
      const entry = history?.[task.promptId];
      if (!entry?.status) return;
      if (entry.status.completed) {
        task.status = entry.status.status_str === "success" ? "done" : "failed";
        if (task.status === "failed") task.error = entry.status.status_str || "执行失败";
      }
    } catch {
      // 历史记录可能短暂滞后于入队。
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
    const total = countJobs(config.models, config.loras, ...variableDimensions(config));
    if (!total) throw new Error("请至少选择一个模型、LoRA（如有）并提供一个文本值");
    const iterator = expandJobs(state.prompt, config);
    const first = iterator.next();
    await recordTemplateUse(config.template);
    if (state.settings.clearTasksOnSubmit) clearTasks();
    byId("cbo-preview-box").open = false;
    const batch = state.batches.size + 1;
    const submittedAt = Date.now();
    state.batches.set(batch, { config, prompt: state.prompt });
    let processed = 0;
    let failed = 0;
    for (let next = first; !next.done; next = iterator.next()) {
      const job = next.value;
      const task = {
        batch,
        submittedAt,
        index: job.index,
        model: job.model,
        lora: job.lora,
        value: job.value,
        variables: job.variables,
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
      if (task.status === "failed") failed += 1;
      // 不逐条弹提示，renderTasks() 已实时刷新汇总行。
      renderTasks();
    }
    setStatus(
      failed ? `已提交 ${processed - failed}/${processed} 个任务，${failed} 个失败` : `已提交 ${processed} 个任务`,
      failed ? "warn" : "ok",
    );
    startPolling();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function installStyles() {
  const href = new URL("../css/orchestrator.css", import.meta.url).href;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

const CRYSTOOLS_SELECTOR = "[class*='crystools']";

const CHEVRON = `<svg class="cbo-chevron" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
  <path d="M3.5 6 L8 10.5 L12.5 6" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function mountTopbar(waitForCrystools) {
  const settings = app.menu?.settingsGroup?.element;
  const menu = settings?.parentElement;
  if (!menu) return false;
  // 上溯到顶栏的直接子元素，插入点才在整个监视器组之前而非组内部。
  let crystools = menu.querySelector(CRYSTOOLS_SELECTOR);
  while (crystools && crystools.parentElement !== menu) crystools = crystools.parentElement;
  if (!crystools && waitForCrystools) return false;
  (crystools || settings).before(topbar);
  positionPanel();
  return true;
}

function buildTopbar() {
  topbar = document.createElement("div");
  topbar.id = "cbo-topbar";
  topbar.className = "comfyui-button-group";
  topbar.innerHTML = `
    <span class="cbo-topbar-title" title="Batch Orchestrator">Batch</span>
    <button id="cbo-refresh" type="button" aria-label="刷新当前画布" title="刷新当前画布">⟳</button>
    <button id="cbo-settings-button" type="button" aria-label="打开设置" title="设置">⚙</button>
    <button id="cbo-toggle" type="button" aria-expanded="false" aria-controls="cbo-panel" aria-label="展开面板" title="展开面板">${CHEVRON}</button>`;

  const deadline = Date.now() + 3000;
  const timer = setInterval(() => {
    if (mountTopbar(Date.now() < deadline) || Date.now() >= deadline + 7000) clearInterval(timer);
  }, 150);
}

function buildPanel() {
  const element = document.createElement("section");
  element.id = "cbo-panel";
  element.hidden = true;
  element.innerHTML = `
    <div class="cbo-body">
      <div id="cbo-summary" class="cbo-summary">尚未读取画布</div>
      <label>UNET 加载器<div class="cbo-node-control"><select id="cbo-unet-node"></select><button id="cbo-unet-locate" class="cbo-btn cbo-locate" type="button" aria-label="定位 UNET 加载器">定位</button></div></label>
      <label>模型<div id="cbo-models" class="cbo-tree" aria-label="模型列表"></div></label>
      <div id="cbo-lora-section">
        <label>LoRA 加载器<div class="cbo-node-control"><select id="cbo-lora-node"></select><button id="cbo-lora-locate" class="cbo-btn cbo-locate" type="button" aria-label="定位 LoRA 加载器">定位</button></div></label>
        <label>LoRA<div id="cbo-loras" class="cbo-tree" aria-label="LoRA 列表"></div></label>
      </div>
      <label>CLIP 文本节点<div class="cbo-node-control"><select id="cbo-text-node"></select><button id="cbo-text-locate" class="cbo-btn cbo-locate" type="button" aria-label="定位 CLIP 文本节点">定位</button></div></label>
      <div class="cbo-section-heading"><span>文本模板</span><button id="cbo-template-manager-open" class="cbo-btn" type="button">模板库</button></div>
      <textarea id="cbo-template" rows="5" placeholder="使用 {{subject}} 作为变量" aria-label="文本模板"></textarea>
      <div class="cbo-section-heading"><span>变量</span><button id="cbo-variable-slot-add" class="cbo-btn" type="button">+ 添加变量</button><button id="cbo-variable-set-save" class="cbo-btn" type="button">保存组合</button><button id="cbo-variable-manager-open" class="cbo-btn" type="button">变量库</button></div>
      <div id="cbo-variable-slots" class="cbo-variable-slots"></div>
      <div id="cbo-variable-summary" class="cbo-variable-summary"></div>
      <fieldset><legend>输出文件名<button id="cbo-filename-help" type="button" class="cbo-help" aria-label="文件名可用变量说明" title="可用变量说明">?</button></legend><div id="cbo-output-nodes" class="cbo-output-nodes"></div></fieldset>
      <details id="cbo-preview-box" class="cbo-preview-box" open><summary>预览</summary><pre id="cbo-preview" class="cbo-preview">填好参数后点击“生成预览”；预览数量可在设置中调整，不会提交任务。</pre></details>
      <div class="cbo-actions"><button id="cbo-preview-button" class="cbo-btn" type="button">生成预览</button><button id="cbo-submit" class="cbo-btn primary" type="button">提交任务</button></div>
      <div class="cbo-task-toolbar"><div id="cbo-task-summary" class="cbo-task-summary">尚未提交任务</div><button id="cbo-task-retry" class="cbo-btn" type="button" title="重新提交失败的任务" disabled>重试</button><button id="cbo-task-cancel" class="cbo-btn" type="button" title="取消队列中尚未完成的任务" disabled>取消</button><button id="cbo-task-clear" class="cbo-btn" type="button" title="清空下方任务记录" disabled>清空</button><button id="cbo-task-order" class="cbo-btn" type="button" aria-label="当前最新任务在前，点击切换为最早任务在前">新→旧</button></div>
      <div id="cbo-tasks" class="cbo-tasks"></div>
    </div>
    <dialog id="cbo-settings-dialog" class="cbo-dialog" aria-labelledby="cbo-settings-title">
      <div class="cbo-dialog-header"><strong id="cbo-settings-title">设置</strong><span class="cbo-settings-hint">只保存在当前浏览器</span><form method="dialog"><button class="cbo-btn" aria-label="关闭设置">关闭</button></form></div>
      <section class="cbo-manager-section">
        <label class="cbo-check-row"><input id="cbo-setting-lora-enabled" type="checkbox"><span>启用 LoRA 维度（关闭后隐藏 LoRA 选择，不参与组合）</span></label>
        <label class="cbo-check-row"><input id="cbo-setting-clear-tasks" type="checkbox"><span>提交新批次前清空任务记录</span></label>
        <label>最大任务数<input id="cbo-setting-max-jobs" type="number" min="1" step="1"></label>
        <label>预览任务数<input id="cbo-setting-preview-limit" type="number" min="1" max="50" step="1"></label>
        <label>默认保存图片模板<input id="cbo-setting-filename-template" type="text" spellcheck="false"></label>
        <div class="cbo-settings-subheading">当前输出节点模板</div>
        <div id="cbo-setting-output-templates" class="cbo-setting-output-templates"></div>
      </section>
      <section class="cbo-manager-section cbo-library-transfer">
        <div class="cbo-manager-heading"><strong>迁移</strong><span>导出 JSON 后可在其他浏览器或 ComfyUI 安装导入</span></div>
        <input id="cbo-library-import" type="file" accept="application/json,.json">
        <button id="cbo-library-export" class="cbo-btn" type="button">导出变量库 JSON</button>
      </section>
      <div class="cbo-settings-actions"><button id="cbo-save-settings" class="cbo-btn primary" type="button">保存设置</button></div>
    </dialog>
    <dialog id="cbo-variable-manager" class="cbo-dialog" aria-labelledby="cbo-variable-manager-title">
      <div class="cbo-dialog-header"><strong id="cbo-variable-manager-title">变量库</strong><form method="dialog"><button class="cbo-btn" aria-label="关闭变量库">关闭</button></form></div>
      <section class="cbo-manager-section">
        <div class="cbo-manager-heading"><strong>已保存的组合</strong><span>载入后会替换主面板上的全部变量</span></div>
        <div id="cbo-variable-sets" class="cbo-library-records"></div>
      </section>
      <section class="cbo-manager-section">
        <div class="cbo-manager-heading"><strong>变量值</strong><span>变量名、文本、label、标签和备注均可搜索</span></div>
        <div class="cbo-manager-filter"><label>搜索<input id="cbo-variable-search" type="search" placeholder="搜索文本或变量名"></label><label>标签<input id="cbo-variable-tag-filter" type="text" placeholder="精确匹配标签"></label></div>
        <div id="cbo-variable-records" class="cbo-library-records"></div>
        <div class="cbo-library-editor">
          <input id="cbo-library-key" type="text" placeholder="变量名，如 top" spellcheck="false">
          <input id="cbo-library-text" type="text" placeholder="完整文本">
          <input id="cbo-library-label" type="text" placeholder="文件名 label（可选）" spellcheck="false">
          <input id="cbo-library-tags" type="text" placeholder="标签，用逗号分隔">
          <input id="cbo-library-note" type="text" placeholder="备注（可选）">
          <div class="cbo-manager-actions"><button id="cbo-library-save" class="cbo-btn primary" type="button">添加变量值</button><button id="cbo-library-cancel" class="cbo-btn" type="button">清空编辑</button></div>
        </div>
      </section>
    </dialog>
    <dialog id="cbo-help-dialog" class="cbo-dialog" aria-labelledby="cbo-help-title">
      <div class="cbo-dialog-header"><strong id="cbo-help-title">文件名可用变量</strong><form method="dialog"><button class="cbo-btn" aria-label="关闭说明">关闭</button></form></div>
      <section class="cbo-manager-section">
        <dl class="cbo-help-list">
          <dt>{{model}}</dt><dd>UNET 模型名，自动去掉目录和扩展名</dd>
          <dt>{{lora}}</dt><dd>LoRA 名，同样去掉目录和扩展名；未启用 LoRA 时为空</dd>
          <dt>{{value}}</dt><dd>第一个变量的值</dd>
          <dt>{{index}}</dt><dd>任务序号，补零到三位（001、002……）</dd>
          <dt>{{seed}}</dt><dd>工作流中找到的第一个 seed</dd>
          <dt>{{变量名}}</dt><dd>任意变量的值，例如变量叫 subject 就写 {{subject}}</dd>
          <dt>{{变量名_label}}</dt><dd>该变量的文件名 label；没填 label 时回退为值本身</dd>
        </dl>
        <div class="cbo-settings-hint">
          用 / 分隔子目录，例如 batch/{{model}}/{{index}}。不能使用绝对路径或 .. ；
          文件名中的非法字符会被替换为下划线。
        </div>
      </section>
    </dialog>
    <dialog id="cbo-template-manager" class="cbo-dialog" aria-labelledby="cbo-template-manager-title">
      <div class="cbo-dialog-header"><strong id="cbo-template-manager-title">模板库</strong><form method="dialog"><button class="cbo-btn" aria-label="关闭模板库">关闭</button></form></div>
      <section class="cbo-manager-section">
        <div class="cbo-manager-heading"><strong>保存当前模板</strong><span>保存的是主面板文本框里的内容</span></div>
        <div class="cbo-manager-filter"><label>模板名称<input id="cbo-template-name" type="text" placeholder="如：服装组合"></label><label>标签<input id="cbo-template-tags" type="text" placeholder="标签，用逗号分隔"></label></div>
        <div class="cbo-manager-actions"><button id="cbo-template-save" class="cbo-btn primary" type="button">保存当前模板</button><button id="cbo-template-clear" class="cbo-btn" type="button">清空模板编辑</button></div>
      </section>
      <section class="cbo-manager-section">
        <div class="cbo-manager-heading"><strong>已保存模板</strong></div>
        <div id="cbo-template-records" class="cbo-library-records"></div>
      </section>
      <section class="cbo-manager-section">
        <div class="cbo-manager-heading"><strong>最近使用</strong><span>最多 ${MAX_TEMPLATE_HISTORY} 条</span></div>
        <div id="cbo-template-history" class="cbo-library-records"></div>
      </section>
    </dialog>`;
  document.body.append(element);
  // 必须挂到 body：面板 hidden 时 showModal() 在 display:none 祖先内不显示。
  element.querySelectorAll("dialog").forEach((dialog) => document.body.append(dialog));
  buildTopbar();

  updateSettingsForm();
  applyLoraVisibility();
  renderLibrary();

  byId("cbo-toggle").addEventListener("click", () => setPanelOpen(panel.hidden));
  // 关闭按钮由 <form method="dialog"> 原生处理，这里只管打开。
  for (const [opener, dialog, beforeOpen] of [
    ["cbo-settings-button", "cbo-settings-dialog", updateSettingsForm],
    ["cbo-template-manager-open", "cbo-template-manager", renderTemplateRecords],
    ["cbo-filename-help", "cbo-help-dialog", null],
    ["cbo-variable-manager-open", "cbo-variable-manager", () => {
      renderVariableRecords();
      renderVariableSets();
    }],
  ]) {
    byId(opener).addEventListener("click", () => {
      beforeOpen?.();
      const element = byId(dialog);
      if (!element.open) element.showModal();
    });
  }
  byId("cbo-variable-set-save").addEventListener("click", saveVariableSet);
  byId("cbo-save-settings").addEventListener("click", saveSettingsFromForm);
  byId("cbo-refresh").addEventListener("click", refresh);
  byId("cbo-submit").addEventListener("click", submit);
  byId("cbo-preview-button").addEventListener("click", () => {
    byId("cbo-preview-box").open = true;
    const config = updatePreview(true);
    if (config) void recordTemplateUse(config.template);
  });
  byId("cbo-variable-slot-add").addEventListener("click", addVariableSlot);
  byId("cbo-variable-search").addEventListener("input", renderVariableRecords);
  byId("cbo-variable-tag-filter").addEventListener("input", renderVariableRecords);
  byId("cbo-library-save").addEventListener("click", saveVariableRecord);
  byId("cbo-library-cancel").addEventListener("click", clearVariableEditor);
  byId("cbo-template-save").addEventListener("click", saveCurrentTemplate);
  byId("cbo-template-clear").addEventListener("click", clearTemplateEditor);
  byId("cbo-library-export").addEventListener("click", exportLibrary);
  byId("cbo-library-import").addEventListener("change", importLibrary);
  byId("cbo-task-clear").addEventListener("click", clearTasks);
  byId("cbo-task-cancel").addEventListener("click", cancelPendingTasks);
  byId("cbo-task-retry").addEventListener("click", retryFailedTasks);
  byId("cbo-task-order").addEventListener("click", () => {
    state.taskOrder = state.taskOrder === "desc" ? "asc" : "desc";
    renderTasks();
  });
  byId("cbo-text-node").addEventListener("change", () => {
    const target = state.targets.text.find((item) => item.id === byId("cbo-text-node").value);
    if (target && !state.templateDirty) byId("cbo-template").value = target.inputs.text || "";
    updatePreview();
  });
  for (const [kind, refreshTree, label] of [
    ["unet", refreshModelSelect, "模型"],
    ["lora", refreshLoraSelect, "LoRA"],
  ]) {
    byId(`cbo-${kind}-node`).addEventListener("change", () => {
      refreshTree().then(() => updatePreview())
        .catch((error) => setStatus(`读取${label}列表失败：${error.message}`, "error"));
    });
  }
  for (const kind of ["unet", "lora", "text"]) {
    byId(`cbo-${kind}-locate`).addEventListener("click", () => locateNode(byId(`cbo-${kind}-node`).value));
  }
  byId("cbo-template").addEventListener("input", () => {
    state.templateDirty = true;
    updatePreview();
  });
  ["cbo-models", "cbo-loras"].forEach((id) => {
    byId(id).addEventListener("change", () => updatePreview());
  });
  window.addEventListener("resize", positionPanel);
  document.addEventListener("pointerdown", (event) => {
    if (panel.hidden) return;
    if (panel.contains(event.target) || topbar?.contains(event.target)) return;
    if (event.target.closest?.("dialog")) return;
    setPanelOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden && !document.querySelector("dialog[open]")) setPanelOpen(false);
  });
  return element;
}

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    installStyles();
    panel = buildPanel();
    await loadLibraryState();
    await refresh();
  },
});
