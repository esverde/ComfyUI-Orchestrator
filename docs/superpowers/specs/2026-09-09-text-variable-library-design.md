# 文本变量组合库与模板历史设计

## 目标

把当前单个 `variable + values` 文本输入扩展为可复用的多变量组合工作流，同时提供浏览器本地持久化、变量值管理、标签筛选、模板历史，以及跨浏览器和跨 ComfyUI 安装的 JSON 导入/导出。

现有模型、LoRA、文本值任务展开和输出节点模板继续工作；旧工作流不需要迁移配置即可运行。

## 当前边界

- `web/js/orchestrator-core.js` 当前只替换一个文本变量，并按模型 × LoRA × 文本值展开任务。
- `web/js/orchestrator.js` 负责面板 DOM、画布目标选择、预览、提交和 `localStorage` 设置。
- `localStorage` 只保存面板设置和输出模板，不适合长期积累大量文本记录。
- 仓库没有后端 API、数据库或构建步骤，新增能力必须继续运行在 ComfyUI 浏览器前端中。

## 设计决策

### 1. 多变量组合

新增“变量槽位”配置。每个槽位有一个稳定的 ASCII key 和一组本次选中的变量值：

```js
{
  key: "top",
  values: [
    { id: "...", text: "白色紧身吊带上衣", label: "white_tank", tags: ["white", "top"] },
  ],
}
```

文本模板可以引用多个槽位：

```text
portrait, {{top}}, {{bottom}}, {{shoes}}
```

每个槽位至少选择一个值。任务总数为：

```text
模型数量 × LoRA 数量 × top 值数量 × bottom 值数量 × shoes 值数量
```

展开顺序固定为模型外层、LoRA 次外层、变量槽位按界面顺序展开、槽位值按选择顺序展开。每个组合生成独立的 prompt 深复制。

变量 key 使用 `[A-Za-z][A-Za-z0-9_]*`，用于稳定生成文本占位符和文件名变量；展示名称、文本内容和标签可以使用中文。

### 2. 旧单变量兼容

现有 `variable`、`values` 配置继续接受。核心层在未提供新 `variables` 配置时，把它转换为一个变量槽位；现有模板中的 `{{subject}}` 和输出文件名中的 `{{value}}` 保持原语义。

面板保留快速输入路径：只配置一个变量时，用户仍可直接粘贴多行值。组合编辑器用于两个或更多变量，或需要从变量库复用值的场景。

### 3. 变量值与文件名标签

变量库记录包含以下字段：

```js
{
  id: "uuid",
  key: "top",
  text: "白色紧身吊带上衣",
  label: "white_tank",
  tags: ["white", "top"],
  note: "可选备注",
  createdAt: 0,
  updatedAt: 0,
}
```

- `text` 是写入 prompt 的完整文本。
- `label` 是短的、适合文件名的别名；它不是分类标签。
- `tags` 是零个或多个用于搜索、筛选和管理的分类标签。
- `label` 为空时，文件名渲染回退到对应完整文本，保证记录仍可使用。

新增文件名变量：

- `{{<key>}}`：当前变量的完整文本，保留动态值清理规则。
- `{{<key>_label}}`：当前变量的短文件名标签，推荐用于输出文件名。

现有 `{{model}}`、`{{lora}}`、`{{value}}`、`{{index}}`、`{{seed}}` 不变。首版不把多个 `tags` 自动拼进文件名，避免标签顺序和文件名长度不可控；标签只负责管理和筛选。

### 4. 持久化与跨安装迁移

运行时使用浏览器原生 IndexedDB，不新增依赖：

- 数据库：`comfyui-batch-orchestrator-library`。
- 数据版本：`1`。
- 对象存储：`variables`、`templates`、`templateHistory`。
- 现有面板设置仍保存在 `localStorage`，不迁移到变量库。

导出文件使用版本化 JSON 包络：

```js
{
  schema: "comfyui-batch-orchestrator-library",
  version: 1,
  exportedAt: "2026-09-09T00:00:00.000Z",
  variables: [],
  templates: [],
  templateHistory: [],
}
```

导入规则：

1. 先校验 `schema`、`version`、数组字段和记录字段类型；不执行任何导入 JSON 中的代码或 HTML。
2. 默认采用合并导入，不清空当前库。
3. 相同 `id` 的记录保留 `updatedAt` 较新的版本。
4. 不同 `id` 但 `key + text + label` 完全相同的变量值去重。
5. 导入后的记录重新经过同一套字段清理和默认值补全。
6. 导出和导入都包含已保存模板及有限的模板历史，确保不同安装之间可复用。

模板历史最多保存最近 100 条去重记录；重复模板更新 `lastUsedAt`，不会无限增长。

### 5. 面板交互

保留现有主面板的快速路径，增加一个原生 `<dialog>` 组合编辑器/变量库：

- “组合变量”区显示槽位 key、展示名、已选数量和本次组合值数量。
- 每个槽位可以从变量库按 key、搜索词和 tags 筛选并勾选值，也可以直接粘贴多行值并保存到库。
- 变量库提供变量值增删改查、搜索、按 key 分组、按 tag 筛选和文件名 label 编辑。
- 模板区提供当前模板“保存为模板”、加载、编辑、删除和最近历史。
- 库窗口提供“导入 JSON”和“导出 JSON”。导入失败只显示错误，不改变现有数据。
- 预览在生成前显示模型、LoRA、各变量 label/文本摘要、组合总数和输出文件名；超过最大任务数时阻止预览和提交。

模板 key、文件名 label 和 tags 使用纯文本 DOM API 渲染，不把用户内容拼入可执行 HTML。

### 6. 核心数据流

1. 刷新画布后仍由现有目标发现逻辑选择 UNET、LoRA、CLIP 文本和输出节点。
2. 组合编辑器读取变量库记录，生成当前批次的 `variables` 配置。
3. 核心校验所有槽位 key 都在文本模板中有对应占位符，且每个槽位至少有一个值。
4. 核心生成变量槽位的笛卡尔积，替换模板中的所有变量占位符。
5. 每个任务同时生成完整变量字段和 label 字段，交给文件名渲染器。
6. 输出节点的 `filename_prefix`、UNET 的 `unet_name`、LoRA 的 `lora_name` 写入该任务的独立 prompt 副本。
7. 预览复用同一展开器，提交仍逐个 POST `/prompt`；预览不入队。

## 错误处理与限制

- 没有变量槽位时，继续走旧单变量兼容路径。
- 有变量槽位但某槽位没有值时，预览和提交都显示明确错误，不发送 `/prompt`。
- 模板包含未定义的 `{{key}}` 或 `{{key_label}}` 时，在预览阶段报错。
- 变量 key、标签和模板名称为空或类型错误时，在保存/导入时拒绝。
- IndexedDB 不可用时，当前批次仍可使用内存中的快速输入；库管理和导入导出显示不可用原因。
- 不增加服务端同步、团队协作、权限管理、标签自动推断或外部数据库。

## 文件边界

- `web/js/orchestrator-core.js`：多变量规范化、变量积、模板替换和动态文件名字段；保持纯函数。
- `web/js/orchestrator-library.js`：IndexedDB CRUD、schema 校验、JSON 导入导出和模板历史；不依赖 DOM。
- `web/js/orchestrator.js`：组合编辑器、变量库/模板对话框、库数据加载和现有任务流程集成。
- `web/css/orchestrator.css`：对话框、变量槽位、记录列表、标签和导入导出控件样式。
- `test/orchestrator-core.test.mjs`：多变量笛卡尔积、替换、label 文件名变量、旧配置兼容测试。
- `test/orchestrator-library.test.mjs`：纯 schema 规范化、合并去重和模板历史上限测试；不启动真实浏览器 IndexedDB。
- `README.md`、`AGENTS.md`：同步使用方式、JSON 迁移边界和新的文件名变量。

## 验收标准

1. 单变量旧用法生成结果与当前行为一致。
2. 两个及以上变量可以从库中分别选值，并生成准确的组合数量。
3. 每个组合的 prompt 只替换对应变量，不污染基础 prompt 或其他任务。
4. `{{top_label}}` 等 label 变量可以生成短且安全的输出路径。
5. 变量值和模板的增删改查、搜索、tags 筛选在刷新浏览器后仍存在。
6. 导出的 JSON 可以在另一浏览器或另一 ComfyUI 安装中导入，并保留变量库、模板和历史。
7. 空值、未知占位符、非法导入 JSON、IndexedDB 不可用和超过任务上限都有可读错误。
8. `npm test`、Node.js 语法检查和 `git diff --check` 通过；实际 ComfyUI 页面再手动验证组合预览、导入导出和提交边界。
