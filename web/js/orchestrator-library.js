export const LIBRARY_SCHEMA = "comfyui-batch-orchestrator-library";
export const LIBRARY_VERSION = 1;
export const MAX_TEMPLATE_HISTORY = 100;

const DB_NAME = "comfyui-batch-orchestrator-library";
const STORE_NAMES = ["variables", "templates", "templateHistory"];
const VARIABLE_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

function nowValue(value) {
  return Number.isFinite(value) ? value : Date.now();
}

function makeId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function recordObject(record, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label}记录格式无效`);
  }
  return record;
}

function stringField(record, name, fallback = "") {
  return record[name] === undefined || record[name] === null ? fallback : String(record[name]);
}

function timestampField(record, name, fallback) {
  return Number.isFinite(record[name]) ? record[name] : fallback;
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/[\n,，]/) : [];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const tag = String(value).trim();
    const folded = tag.toLocaleLowerCase();
    if (tag && !seen.has(folded)) {
      seen.add(folded);
      result.push(tag);
    }
  }
  return result;
}

function normalizeVariableRecord(value, now) {
  const record = recordObject(value, "变量");
  const key = stringField(record, "key").trim();
  if (!VARIABLE_KEY.test(key)) throw new Error(`变量 key 无效：${key || "不能为空"}`);
  const text = stringField(record, "text").trim();
  if (!text) throw new Error("变量文本不能为空");
  const createdAt = timestampField(record, "createdAt", now);
  return {
    id: stringField(record, "id") || makeId("variable"),
    key,
    text,
    label: stringField(record, "label").trim(),
    tags: normalizeTags(record.tags),
    note: stringField(record, "note").trim(),
    createdAt,
    updatedAt: timestampField(record, "updatedAt", createdAt),
  };
}

function normalizeTemplateRecord(value, now) {
  const record = recordObject(value, "模板");
  const name = stringField(record, "name").trim();
  if (!name) throw new Error("模板名称不能为空");
  const body = stringField(record, "body");
  if (!body.trim()) throw new Error("模板内容不能为空");
  const createdAt = timestampField(record, "createdAt", now);
  return {
    id: stringField(record, "id") || makeId("template"),
    name,
    body,
    tags: normalizeTags(record.tags),
    createdAt,
    updatedAt: timestampField(record, "updatedAt", createdAt),
    lastUsedAt: timestampField(record, "lastUsedAt", 0),
  };
}

function normalizeHistoryRecord(value, now) {
  const record = recordObject(value, "模板历史");
  const name = stringField(record, "name").trim();
  const body = stringField(record, "body");
  if (!name || !body.trim()) throw new Error("模板历史记录不能为空");
  return {
    id: stringField(record, "id") || makeId("history"),
    name,
    body,
    lastUsedAt: timestampField(record, "lastUsedAt", now),
  };
}

function deduplicateById(records, timestampName) {
  const byId = new Map();
  for (const record of records) {
    const current = byId.get(record.id);
    if (!current || record[timestampName] >= current[timestampName]) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function normalizeHistory(records, now) {
  const byBody = new Map();
  for (const record of deduplicateById(records.map((item) => normalizeHistoryRecord(item, now)), "lastUsedAt")) {
    const current = byBody.get(record.body);
    if (!current || record.lastUsedAt >= current.lastUsedAt) byBody.set(record.body, record);
  }
  return [...byBody.values()]
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, MAX_TEMPLATE_HISTORY);
}

export function normalizeLibraryData(value = {}, now = Date.now()) {
  const source = recordObject(value, "变量库");
  const timestamp = nowValue(now);
  const variables = Array.isArray(source.variables)
    ? deduplicateById(source.variables.map((item) => normalizeVariableRecord(item, timestamp)), "updatedAt")
    : [];
  const templates = Array.isArray(source.templates)
    ? deduplicateById(source.templates.map((item) => normalizeTemplateRecord(item, timestamp)), "updatedAt")
    : [];
  const templateHistory = Array.isArray(source.templateHistory)
    ? normalizeHistory(source.templateHistory, timestamp)
    : [];
  return {
    schema: LIBRARY_SCHEMA,
    version: LIBRARY_VERSION,
    variables,
    templates,
    templateHistory,
  };
}

function mergeById(current, incoming, timestampName) {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) {
    const existing = records.get(record.id);
    if (!existing || record[timestampName] >= existing[timestampName]) records.set(record.id, record);
  }
  return [...records.values()];
}

function deduplicateVariableContent(records) {
  const byContent = new Map();
  for (const record of records) {
    const contentKey = `${record.key}\u0000${record.text}\u0000${record.label}`;
    const current = byContent.get(contentKey);
    if (!current || record.updatedAt >= current.updatedAt) byContent.set(contentKey, record);
  }
  return [...byContent.values()];
}

export function mergeLibraryData(current = {}, incoming = {}, now = Date.now()) {
  const left = normalizeLibraryData(current, now);
  const right = normalizeLibraryData(incoming, now);
  return {
    schema: LIBRARY_SCHEMA,
    version: LIBRARY_VERSION,
    variables: deduplicateVariableContent(mergeById(left.variables, right.variables, "updatedAt")),
    templates: mergeById(left.templates, right.templates, "updatedAt"),
    templateHistory: normalizeHistory(
      mergeById(left.templateHistory, right.templateHistory, "lastUsedAt"),
      nowValue(now),
    ),
  };
}

function assertArrayEnvelope(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("变量库导入格式无效");
  if (source.schema !== LIBRARY_SCHEMA) throw new Error("变量库 schema 不匹配");
  if (source.version !== LIBRARY_VERSION) throw new Error("变量库版本不支持");
  if (source.exportedAt !== undefined && typeof source.exportedAt !== "string") {
    throw new Error("变量库 exportedAt 类型无效");
  }
  for (const name of STORE_NAMES) {
    if (!Array.isArray(source[name])) throw new Error(`变量库 ${name} 必须是数组`);
  }
}

function assertOptionalType(record, name, type, label) {
  if (record[name] !== undefined && typeof record[name] !== type) {
    throw new Error(`${label}字段 ${name} 类型无效`);
  }
}

function validateExportRecords(source) {
  for (const record of source.variables) {
    recordObject(record, "变量");
    for (const name of ["id", "key", "text", "label", "note"]) assertOptionalType(record, name, "string", "变量");
    if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string"))) {
      throw new Error("变量字段 tags 类型无效");
    }
    for (const name of ["createdAt", "updatedAt"]) assertOptionalType(record, name, "number", "变量");
  }
  for (const record of source.templates) {
    recordObject(record, "模板");
    for (const name of ["id", "name", "body"]) assertOptionalType(record, name, "string", "模板");
    if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string"))) {
      throw new Error("模板字段 tags 类型无效");
    }
    for (const name of ["createdAt", "updatedAt", "lastUsedAt"]) assertOptionalType(record, name, "number", "模板");
  }
  for (const record of source.templateHistory) {
    recordObject(record, "模板历史");
    for (const name of ["id", "name", "body"]) assertOptionalType(record, name, "string", "模板历史");
    assertOptionalType(record, "lastUsedAt", "number", "模板历史");
  }
}

export function parseLibraryExport(text) {
  let source;
  try {
    source = JSON.parse(String(text));
  } catch {
    throw new Error("变量库 JSON 格式无效");
  }
  try {
    assertArrayEnvelope(source);
    validateExportRecords(source);
    return normalizeLibraryData(source);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("变量库导入格式无效");
  }
}

export function serializeLibrary(value, now = Date.now()) {
  const data = normalizeLibraryData(value, now);
  return JSON.stringify({
    ...data,
    exportedAt: new Date(nowValue(now)).toISOString(),
  }, null, 2);
}

function assertStoreName(storeName) {
  if (!STORE_NAMES.includes(storeName)) throw new Error(`未知变量库存储：${storeName}`);
}

function getIndexedDb() {
  if (!globalThis.indexedDB) throw new Error("浏览器不支持本地变量库");
  return globalThis.indexedDB;
}

function openDatabase() {
  const indexedDb = getIndexedDb();
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DB_NAME, LIBRARY_VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORE_NAMES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("变量库打开失败"));
    request.onblocked = () => reject(new Error("变量库被其他页面占用"));
  });
}

function runTransaction(storeNames, mode, action) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    let result;
    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("变量库操作失败"));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error || new Error("变量库操作已取消"));
    };
    try {
      result = action(transaction);
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  }));
}

export function listLibraryRecords(storeName) {
  assertStoreName(storeName);
  return runTransaction([storeName], "readonly", (transaction) => new Promise((resolve, reject) => {
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("变量库读取失败"));
  }));
}

export function putLibraryRecord(storeName, record) {
  assertStoreName(storeName);
  const data = normalizeLibraryData({ [storeName]: [record] });
  return runTransaction([storeName], "readwrite", (transaction) => {
    transaction.objectStore(storeName).put(data[storeName][0]);
  });
}

export function deleteLibraryRecord(storeName, id) {
  assertStoreName(storeName);
  return runTransaction([storeName], "readwrite", (transaction) => {
    transaction.objectStore(storeName).delete(String(id));
  });
}

export function replaceLibraryData(value) {
  const data = normalizeLibraryData(value);
  return runTransaction(STORE_NAMES, "readwrite", (transaction) => {
    for (const name of STORE_NAMES) {
      const store = transaction.objectStore(name);
      store.clear();
      for (const record of data[name]) store.put(record);
    }
  });
}
