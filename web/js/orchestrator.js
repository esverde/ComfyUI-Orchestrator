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

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
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
    loraEnabled: source.loraEnabled !== false,
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
  library: { ...normalizeLibraryData(), ready: false },
  variableSlots: [{ key: "subject", values: [] }],
  variableEditorId: "",
};

let panel;
let topbar;

function byId(id) {
  // 顶栏可能还在等 ComfyUI 渲染完才挂载，这段时间它不在文档里，
  // getElementById 找不到其中的控件——回退到元素自身查找，否则绑不上监听器。
  return document.getElementById(id) || topbar?.querySelector(`#${id}`) || null;
}

// ComfyUI 原生 toast：面板收起时状态栏看不见，错误不能就这么咽掉。
function notify(detail, severity = "error") {
  const toast = app.extensionManager?.toast;
  if (!toast?.add) {
    // 旧前端没有 toast，退到控制台，总好过消息凭空消失。
    console[severity === "error" ? "error" : "log"](`[Batch Orchestrator] ${detail}`);
    return;
  }
  toast.add({
    severity,
    summary: "Batch Orchestrator",
    detail: String(detail),
    life: severity === "error" ? 6000 : 3000,
  });
}

const SEVERITY = { ok: "success", error: "error" };

function setStatus(message, kind = "") {
  notify(message, SEVERITY[kind] || "info");
}

function setFieldMessage(message, kind = "") {
  const element = byId("cbo-preview");
  if (!element) return;
  element.textContent = message;
  element.className = `cbo-preview ${kind}`;
}

function librarySnapshot() {
  return {
    variables: state.library.variables,
    variableSets: state.library.variableSets,
    templates: state.library.templates,
    templateHistory: state.library.templateHistory,
  };
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
    const empty = document.createElement("div");
    empty.className = "cbo-library-empty";
    empty.textContent = "IndexedDB 不可用，变量库管理暂不可用；快速输入仍可使用。";
    container.append(empty);
    return;
  }
  const records = filteredVariableRecords();
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "cbo-library-empty";
    empty.textContent = "没有匹配的变量值。";
    container.append(empty);
    return;
  }
  for (const record of records) {
    const row = document.createElement("div");
    row.className = "cbo-library-record";
    const main = document.createElement("div");
    main.className = "cbo-library-record-main";
    const title = document.createElement("strong");
    title.textContent = `${record.key} · ${record.text}`;
    const meta = document.createElement("span");
    meta.textContent = [record.label && `文件名：${record.label}`, record.tags.length && `标签：${record.tags.join("、")}`, record.note]
      .filter(Boolean)
      .join("；");
    main.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "cbo-library-record-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => openVariableEditor(record));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => removeVariableRecord(record.id));
    actions.append(edit, remove);
    row.append(main, actions);
    container.append(row);
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
  openVariableEditor();
  byId("cbo-library-key").value = "";
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
  // 同 key 同文本的库记录直接带上 label/tags，文件名模板的 {{key_label}} 才有内容。
  const known = state.library.variables.find((record) => record.key === slot.key && record.text === value);
  slot.values.push(known ? cloneVariableRecord(known) : { key: slot.key, text: value, label: "", tags: [] });
  return true;
}

function renderSlotValues(container, slot) {
  container.replaceChildren();
  if (!slot.values.length) {
    const hint = document.createElement("span");
    hint.className = "cbo-variable-hint";
    hint.textContent = "还没有值。在上方输入后回车添加。";
    container.append(hint);
    return;
  }
  slot.values.forEach((value, valueIndex) => {
    const chip = document.createElement("span");
    chip.className = "cbo-variable-chip";
    const text = document.createElement("span");
    text.className = "cbo-variable-chip-text";
    text.textContent = value.label ? `${value.text} [${value.label}]` : value.text;
    text.title = value.text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cbo-variable-chip-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `移除 ${value.text}`);
    remove.addEventListener("click", () => {
      slot.values.splice(valueIndex, 1);
      renderVariableSlots();
      updatePreview();
    });
    chip.append(text, remove);
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
    const insert = document.createElement("button");
    insert.type = "button";
    insert.textContent = "插入";
    insert.title = `把 {{${slot.key}}} 插入文本模板`;
    insert.addEventListener("click", () => insertPlaceholder(slot.key));
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "存入库";
    save.title = "把这个变量的所有值保存到变量库";
    save.addEventListener("click", () => saveSlotValuesToLibrary(slotIndex));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "×";
    remove.title = "删除这个变量";
    remove.setAttribute("aria-label", `删除变量 ${slot.key || slotIndex + 1}`);
    remove.addEventListener("click", () => {
      state.variableSlots.splice(slotIndex, 1);
      if (!state.variableSlots.length) state.variableSlots.push({ key: "subject", values: [] });
      renderVariableSlots();
      updatePreview();
    });
    header.append(key, count, insert, save, remove);

    // 原生 datalist：输入时直接联想该变量名在库里已有的值，省掉一个自建选择器。
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
      // 重渲染会销毁这个输入框，把焦点还回去才能连着录入下一个值。
      byId("cbo-variable-slots")?.querySelectorAll(".cbo-variable-entry")[slotIndex]?.focus();
    };
    entry.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    });
    // 从 datalist 选中或粘贴多行时，change 也要收口。
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
    const next = normalizeLibraryData({ ...librarySnapshot(), variables: nextVariables }, now);
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

function openDialog(id) {
  const dialog = byId(id);
  if (!dialog || dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.open = true;
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
    const empty = document.createElement("div");
    empty.className = "cbo-library-empty";
    empty.textContent = "IndexedDB 不可用，组合保存暂不可用。";
    container.append(empty);
    return;
  }
  if (!state.library.variableSets.length) {
    const empty = document.createElement("div");
    empty.className = "cbo-library-empty";
    empty.textContent = "还没有保存的组合。在主面板配好变量后点「保存组合」。";
    container.append(empty);
    return;
  }
  for (const record of state.library.variableSets) {
    const row = document.createElement("div");
    row.className = "cbo-library-record";
    const main = document.createElement("div");
    main.className = "cbo-library-record-main";
    const title = document.createElement("strong");
    title.textContent = record.name;
    const meta = document.createElement("span");
    const counts = record.slots.map((slot) => `${slot.key}（${slot.values.length}）`);
    meta.textContent = `${counts.join(" × ")} = ${countJobs(...record.slots.map((slot) => slot.values))} 种组合`;
    main.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "cbo-library-record-actions";
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "载入";
    load.addEventListener("click", () => loadVariableSet(record));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => removeVariableSet(record.id));
    actions.append(load, remove);
    row.append(main, actions);
    container.append(row);
  }
}

function renderTemplateRecords() {
  const recordsContainer = byId("cbo-template-records");
  const historyContainer = byId("cbo-template-history");
  if (recordsContainer) {
    recordsContainer.replaceChildren();
    if (!state.library.ready) {
      const empty = document.createElement("div");
      empty.className = "cbo-library-empty";
      empty.textContent = "IndexedDB 不可用，模板保存和历史暂不可用。";
      recordsContainer.append(empty);
    } else if (!state.library.templates.length) {
      const empty = document.createElement("div");
      empty.className = "cbo-library-empty";
      empty.textContent = "还没有已保存模板。";
      recordsContainer.append(empty);
    } else {
      for (const record of state.library.templates) {
        const row = document.createElement("div");
        row.className = "cbo-library-record";
        const main = document.createElement("div");
        main.className = "cbo-library-record-main";
        const title = document.createElement("strong");
        title.textContent = record.name;
        const body = document.createElement("span");
        body.textContent = record.body;
        main.append(title, body);
        const actions = document.createElement("div");
        actions.className = "cbo-library-record-actions";
        const load = document.createElement("button");
        load.type = "button";
        load.textContent = "加载";
        load.addEventListener("click", () => loadTemplate(record));
        const edit = document.createElement("button");
        edit.type = "button";
        edit.textContent = "编辑";
        edit.addEventListener("click", () => openTemplateEditor(record));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger";
        remove.textContent = "删除";
        remove.addEventListener("click", () => removeTemplate(record.id));
        actions.append(load, edit, remove);
        row.append(main, actions);
        recordsContainer.append(row);
      }
    }
  }
  if (historyContainer) {
    historyContainer.replaceChildren();
    if (!state.library.templateHistory.length) {
      const empty = document.createElement("div");
      empty.className = "cbo-library-empty";
      empty.textContent = "还没有模板使用历史。";
      historyContainer.append(empty);
    } else {
      for (const record of state.library.templateHistory) {
        const row = document.createElement("div");
        row.className = "cbo-library-history-row";
        const text = document.createElement("span");
        text.textContent = `${record.name}：${record.body}`;
        const load = document.createElement("button");
        load.type = "button";
        load.textContent = "加载";
        load.addEventListener("click", () => loadTemplate(record));
        row.append(text, load);
        historyContainer.append(row);
      }
    }
  }
}

function openTemplateEditor(record = null) {
  byId("cbo-template-record-id").value = record?.id || "";
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
  byId("cbo-template-record-id").value = "";
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
    const existing = state.library.templates.find((record) => record.id === byId("cbo-template-record-id").value)
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
    const next = normalizeLibraryData({ ...librarySnapshot(), templateHistory: history }, now);
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

async function listOptions(nodeType, inputName, modelsPath, currentValue) {
  try {
    const values = optionValuesFromObjectInfo(await getJson(`/object_info/${nodeType}`), nodeType, inputName);
    if (values.length) return values;
  } catch {
    // The models route below handles older or restricted ComfyUI builds.
  }
  try {
    const values = optionValuesFromModels(await getJson(modelsPath));
    if (values.length) return values;
  } catch {
    // A current workflow value is still useful for a one-combination smoke test.
  }
  return currentValue ? [currentValue] : [];
}

function fillSelect(select, items, selected = []) {
  select.replaceChildren();
  for (const { id, label } of items) {
    const option = document.createElement("option");
    option.value = String(id);
    option.textContent = label;
    option.selected = selected.includes(option.value);
    select.append(option);
  }
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
    const empty = document.createElement("div");
    empty.className = "cbo-tree-empty";
    empty.textContent = emptyLabel;
    container.append(empty);
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

// 全部默认折叠，但已勾选的项必须可见，否则预选中的当前模型等于凭空消失。
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
  const values = await listOptions("UNETLoader", "unet_name", "/models/diffusion_models", currentModel);
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
    ? await listOptions("LoraLoaderModelOnly", "lora_name", "/models/loras", currentLora)
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

// 面板锚在顶栏按钮下方展开，样式参考官方任务队列浮层。
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
  if (!maxJobs || !previewLimit || !filenameTemplate || !loraEnabled) return;
  maxJobs.value = String(state.settings.maxJobs);
  previewLimit.value = String(state.settings.previewLimit);
  filenameTemplate.value = state.settings.filenameTemplate;
  loraEnabled.checked = state.settings.loraEnabled;
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
    // 重新打开 LoRA 时要把树重新拉一次，否则停在关闭前的空列表。
    if (!oldLoraEnabled && state.settings.loraEnabled) {
      refreshLoraSelect().then(updatePreview).catch((error) => setStatus(`读取 LoRA 列表失败：${error.message}`, "error"));
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
  if (!state.prompt) return false;
  try {
    const config = collectConfig();
    const total = countJobs(config.models, config.loras, ...variableDimensions(config));
    const samples = sampleJobs(config);
    const hasLora = Boolean(config.loraId);
    const hasMultipleVariables = Boolean(config.variables?.length && config.variables.length > 1);
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
    if (announce === true) setStatus(`预览已生成：共 ${total} 个任务，仅展示前 ${samples.length} 个`, "ok");
    return config;
  } catch (error) {
    setFieldMessage(error.message, "error");
    if (announce === true) setStatus(`预览失败：${error.message}`, "error");
    return false;
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
    main.textContent = task.filenamePrefixes.map((output) => output.prefix).join(" | ") || "未设置文件名";
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
    const total = countJobs(config.models, config.loras, ...variableDimensions(config));
    if (!total) throw new Error("请至少选择一个模型、LoRA（如有）并提供一个文本值");
    const iterator = expandJobs(state.prompt, {
      ...config,
    });
    const first = iterator.next();
    await recordTemplateUse(config.template);
    let processed = 0;
    let failed = 0;
    for (let next = first; !next.done; next = iterator.next()) {
      const job = next.value;
      const task = {
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
      // 进度不逐条弹提示，renderTasks() 已实时刷新任务汇总行。
      renderTasks();
    }
    notify(
      failed ? `已提交 ${processed - failed}/${processed} 个任务，${failed} 个失败` : `已提交 ${processed} 个任务`,
      failed ? "warn" : "success",
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
  if ([...document.querySelectorAll("link[rel=stylesheet]")].some((link) => link.href === href)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

// 各版本 Crystools 的容器 class 不尽相同，按前缀匹配比枚举可靠。
const CRYSTOOLS_SELECTOR = "[class*='crystools']";

// 字体里的 ⌄ 字形本身不垂直居中，旋转后仍会偏移；SVG 才能真正居中。
const CHEVRON = `<svg class="cbo-chevron" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
  <path d="M3.5 6 L8 10.5 L12.5 6" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// 新版前端会保留一个 display:none 的旧版 .comfyui-menu，光看 isConnected
// 会把「插进了隐藏容器」误判成挂载成功，所以一律以实际可见为准。
function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function crystoolsAnchor() {
  const crystools = document.querySelector(CRYSTOOLS_SELECTOR);
  if (!crystools || crystools.contains(topbar)) return null;
  return crystools.closest(".comfyui-button-group") || crystools;
}

// Crystools 可能比我们晚挂载，那时我们已经落在它右边了，需要复位。
function pinLeftOfCrystools() {
  const anchor = crystoolsAnchor();
  if (!anchor?.isConnected || anchor.previousElementSibling === topbar) return false;
  anchor.before(topbar);
  return true;
}

function topbarAnchors() {
  return [
    crystoolsAnchor(),
    app.menu?.settingsGroup?.element,
    document.querySelector(".comfyui-menu-right"),
  ].filter((element) => element?.isConnected);
}

function mountTopbar(group) {
  for (const anchor of topbarAnchors()) {
    anchor.before(group);
    if (isVisible(group)) return true;
    group.remove();
  }
  for (const menu of document.querySelectorAll(".comfyui-menu-right, .comfyui-menu")) {
    menu.append(group);
    if (isVisible(group)) return true;
    group.remove();
  }
  return false;
}

function detachTopbar(group) {
  group.classList.add("cbo-topbar-detached");
  document.body.append(group);
  console.warn("[Batch Orchestrator] 未能挂载到 ComfyUI 顶栏，已退回右上角悬浮显示。");
}

function buildTopbar() {
  topbar = document.createElement("div");
  topbar.id = "cbo-topbar";
  topbar.className = "comfyui-button-group";
  // 状态文字改在面板内显示，顶栏只留标题和三个图标按钮。
  topbar.innerHTML = `
    <span class="cbo-topbar-title" title="Batch Orchestrator">Batch</span>
    <button id="cbo-refresh" type="button" aria-label="刷新当前画布" title="刷新当前画布">⟳</button>
    <button id="cbo-settings-button" type="button" aria-label="打开设置" title="设置">⚙</button>
    <button id="cbo-toggle" type="button" aria-expanded="false" aria-controls="cbo-panel" aria-label="展开面板" title="展开面板">${CHEVRON}</button>`;

  const mounted = mountTopbar(topbar);
  // 顶栏是 Vue 异步挂载的，Crystools 也可能比我们晚到；持续观察直到两者都就位。
  const watch = () => observer.observe(document.body, { childList: true, subtree: true });
  const observer = new MutationObserver(() => {
    // 试挂载本身会改 DOM，不先断开会把自己的插入/移除又喂回来，空转到超时。
    observer.disconnect();
    if (topbar.isConnected && isVisible(topbar)) {
      if (pinLeftOfCrystools()) positionPanel();
    } else if (mountTopbar(topbar)) {
      positionPanel();
    }
    watch();
  });
  watch();
  // 给 Crystools 留出加载时间后停止观察，避免长期占用 DOM 变更回调。
  setTimeout(() => observer.disconnect(), 15000);
  if (mounted) return;
  setTimeout(() => {
    if (!topbar.isConnected || !isVisible(topbar)) detachTopbar(topbar);
  }, 5000);
}

function buildPanel() {
  if (document.getElementById("cbo-panel")) return document.getElementById("cbo-panel");
  const element = document.createElement("section");
  element.id = "cbo-panel";
  element.hidden = true;
  element.innerHTML = `
    <div class="cbo-body">
      <div id="cbo-summary" class="cbo-summary">尚未读取画布</div>
      <label>UNET 加载器<div class="cbo-node-control"><select id="cbo-unet-node"></select><button id="cbo-unet-locate" class="cbo-locate" type="button" aria-label="定位 UNET 加载器">定位</button></div></label>
      <label>模型（可多选）<div id="cbo-models" class="cbo-tree" aria-label="模型列表"></div></label>
      <div id="cbo-lora-section">
        <label>LoRA 加载器<div class="cbo-node-control"><select id="cbo-lora-node"></select><button id="cbo-lora-locate" class="cbo-locate" type="button" aria-label="定位 LoRA 加载器">定位</button></div></label>
        <label>LoRA（可多选）<div id="cbo-loras" class="cbo-tree" aria-label="LoRA 列表"></div></label>
      </div>
      <label>CLIP 文本节点<div class="cbo-node-control"><select id="cbo-text-node"></select><button id="cbo-text-locate" class="cbo-locate" type="button" aria-label="定位 CLIP 文本节点">定位</button></div></label>
      <div class="cbo-section-heading"><span>文本模板</span><button id="cbo-template-manager-open" type="button">模板库</button></div>
      <textarea id="cbo-template" rows="5" placeholder="使用 {{subject}} 作为变量" aria-label="文本模板"></textarea>
      <div class="cbo-section-heading"><span>变量</span><button id="cbo-variable-slot-add" type="button">+ 添加变量</button><button id="cbo-variable-set-save" type="button">保存组合</button><button id="cbo-variable-manager-open" type="button">变量库</button></div>
      <div id="cbo-variable-slots" class="cbo-variable-slots"></div>
      <div id="cbo-variable-summary" class="cbo-variable-summary"></div>
      <fieldset><legend>输出文件名（可逐个设置，支持 {{model}}、{{lora}}、{{value}}、{{index}}、{{seed}}、{{变量名}}、{{变量名_label}}）</legend><div id="cbo-output-nodes" class="cbo-output-nodes"></div></fieldset>
      <pre id="cbo-preview" class="cbo-preview">填好参数后点击“生成预览”；预览数量可在设置中调整，不会提交任务。</pre>
      <div class="cbo-actions"><button id="cbo-preview-button" type="button">生成预览</button><button id="cbo-submit" class="primary" type="button">提交任务</button></div>
      <div class="cbo-task-toolbar"><div id="cbo-task-summary" class="cbo-task-summary">尚未提交任务</div><button id="cbo-task-order" type="button" aria-label="当前最新任务在前，点击切换为最早任务在前">新→旧</button></div>
      <div id="cbo-tasks" class="cbo-tasks"></div>
    </div>
    <dialog id="cbo-settings-dialog" class="cbo-dialog" aria-labelledby="cbo-settings-title">
      <div class="cbo-dialog-header"><strong id="cbo-settings-title">设置</strong><span class="cbo-settings-hint">只保存在当前浏览器</span><button id="cbo-settings-close" type="button" aria-label="关闭设置">关闭</button></div>
      <section class="cbo-manager-section">
        <label class="cbo-check-row"><input id="cbo-setting-lora-enabled" type="checkbox"><span>启用 LoRA 维度（关闭后隐藏 LoRA 选择，不参与组合）</span></label>
        <label>最大任务数<input id="cbo-setting-max-jobs" type="number" min="1" step="1"></label>
        <label>预览任务数<input id="cbo-setting-preview-limit" type="number" min="1" max="50" step="1"></label>
        <label>默认保存图片模板<input id="cbo-setting-filename-template" type="text" spellcheck="false"></label>
        <div class="cbo-settings-subheading">当前输出节点模板</div>
        <div id="cbo-setting-output-templates" class="cbo-setting-output-templates"></div>
      </section>
      <section class="cbo-manager-section cbo-library-transfer">
        <div class="cbo-manager-heading"><strong>迁移</strong><span>导出 JSON 后可在其他浏览器或 ComfyUI 安装导入</span></div>
        <input id="cbo-library-import" type="file" accept="application/json,.json">
        <button id="cbo-library-export" type="button">导出变量库 JSON</button>
      </section>
      <div class="cbo-settings-actions"><button id="cbo-save-settings" class="primary" type="button">保存设置</button></div>
    </dialog>
    <dialog id="cbo-variable-manager" class="cbo-dialog" aria-labelledby="cbo-variable-manager-title">
      <div class="cbo-dialog-header"><strong id="cbo-variable-manager-title">变量库</strong><button id="cbo-library-close" type="button" aria-label="关闭变量库">关闭</button></div>
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
          <div class="cbo-manager-actions"><button id="cbo-library-save" class="primary" type="button">添加变量值</button><button id="cbo-library-cancel" type="button">清空编辑</button></div>
        </div>
      </section>
    </dialog>
    <dialog id="cbo-template-manager" class="cbo-dialog" aria-labelledby="cbo-template-manager-title">
      <div class="cbo-dialog-header"><strong id="cbo-template-manager-title">模板库</strong><button id="cbo-template-close" type="button" aria-label="关闭模板库">关闭</button></div>
      <section class="cbo-manager-section">
        <div class="cbo-manager-heading"><strong>保存当前模板</strong><span>保存的是主面板文本框里的内容</span></div>
        <input id="cbo-template-record-id" type="hidden">
        <div class="cbo-manager-filter"><label>模板名称<input id="cbo-template-name" type="text" placeholder="如：服装组合"></label><label>标签<input id="cbo-template-tags" type="text" placeholder="标签，用逗号分隔"></label></div>
        <div class="cbo-manager-actions"><button id="cbo-template-save" class="primary" type="button">保存当前模板</button><button id="cbo-template-clear" type="button">清空模板编辑</button></div>
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
  // 弹窗必须挂在 body 上：面板收起时是 hidden，showModal() 在 display:none 的祖先里不会显示。
  element.querySelectorAll("dialog").forEach((dialog) => document.body.append(dialog));
  buildTopbar();

  updateSettingsForm();
  applyLoraVisibility();
  renderLibrary();

  byId("cbo-toggle").addEventListener("click", () => setPanelOpen(panel.hidden));
  byId("cbo-settings-button").addEventListener("click", () => {
    updateSettingsForm();
    openDialog("cbo-settings-dialog");
  });
  byId("cbo-settings-close").addEventListener("click", () => byId("cbo-settings-dialog").close());
  byId("cbo-template-manager-open").addEventListener("click", () => {
    renderTemplateRecords();
    openDialog("cbo-template-manager");
  });
  byId("cbo-template-close").addEventListener("click", () => byId("cbo-template-manager").close());
  byId("cbo-variable-set-save").addEventListener("click", saveVariableSet);
  byId("cbo-save-settings").addEventListener("click", saveSettingsFromForm);
  byId("cbo-refresh").addEventListener("click", refresh);
  byId("cbo-submit").addEventListener("click", submit);
  byId("cbo-preview-button").addEventListener("click", () => {
    const config = updatePreview(true);
    if (config) void recordTemplateUse(config.template);
  });
  byId("cbo-variable-manager-open").addEventListener("click", () => {
    renderVariableRecords();
    renderVariableSets();
    openDialog("cbo-variable-manager");
  });
  byId("cbo-library-close").addEventListener("click", () => byId("cbo-variable-manager").close());
  byId("cbo-variable-slot-add").addEventListener("click", addVariableSlot);
  byId("cbo-variable-search").addEventListener("input", renderVariableRecords);
  byId("cbo-variable-tag-filter").addEventListener("input", renderVariableRecords);
  byId("cbo-library-save").addEventListener("click", saveVariableRecord);
  byId("cbo-library-cancel").addEventListener("click", clearVariableEditor);
  byId("cbo-template-save").addEventListener("click", saveCurrentTemplate);
  byId("cbo-template-clear").addEventListener("click", clearTemplateEditor);
  byId("cbo-library-export").addEventListener("click", exportLibrary);
  byId("cbo-library-import").addEventListener("change", importLibrary);
  byId("cbo-task-order").addEventListener("click", () => {
    state.taskOrder = state.taskOrder === "desc" ? "asc" : "desc";
    renderTasks();
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
  ["cbo-models", "cbo-loras"].forEach((id) => {
    byId(id).addEventListener("change", updatePreview);
  });
  window.addEventListener("resize", positionPanel);
  // 点面板或顶栏以外的地方就收起，和官方任务队列浮层一致。
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
