# ComfyUI Batch Orchestrator

## 项目定位

这是一个运行在 ComfyUI 前端内部的本地批量任务扩展，不是独立 Web 服务，也不是自定义节点后端。它读取当前画布可转换的 API 工作流，生成“UNET 模型 × LoRA × 文本变量值”的任务笛卡尔积，并把每个任务逐个提交回当前 ComfyUI 实例；没有 LoRA 节点时退化为模型 × 文本值。

插件没有云服务、遥测或额外 Python 运行时依赖。按 README 的约定，将整个目录放入 `custom_nodes/comfyui-orchestrator` 后由 ComfyUI 加载；浏览器直接加载 `web` 下的 ES module，没有前端构建步骤。

## 目录与职责

- `__init__.py`：仅声明 `WEB_DIRECTORY = "./web"`；`NODE_CLASS_MAPPINGS` 和 `NODE_DISPLAY_NAME_MAPPINGS` 为空，不注册 Python 节点。
- `web/js/orchestrator-core.js`：与 DOM、ComfyUI 全局对象无关的核心逻辑。负责目标节点发现、负面 CLIP 排除、模型/LoRA 路径树构建、任务数量、单/多变量文本替换、变量笛卡尔积、文件名清理/渲染和任务展开；这是主要的单元测试边界。
- `web/js/orchestrator-library.js`：不依赖 DOM 的变量库模块。负责 IndexedDB 的 `variables`、`templates`、`templateHistory` 三个对象存储，变量/模板规范化、版本化 JSON 导入导出、按更新时间合并和最多 100 条模板历史；纯函数由 Node 测试覆盖。
- `web/js/orchestrator.js`：ComfyUI 前端适配和面板 UI。导入 `scripts/app.js`、`scripts/api.js`，读取画布、调用服务端 API、管理 UI 状态、渲染带文件夹复选框的模型/LoRA 树、组合变量/模板对话框、提交任务和轮询历史；还负责设置面板、浏览器 `localStorage` 持久化、浮动拖拽和输出模板记忆。
- `web/css/orchestrator.css`：以 `cbo-` 为前缀的固定侧边面板、原生 dialog、变量槽位、记录列表、输入控件、预览区、输出行和任务状态样式。样式在扩展初始化时动态插入。
- `test/orchestrator-core.test.mjs`：Node.js 内置 `node:test` 测试，覆盖核心模块，不启动 ComfyUI 或浏览器。
- `test/orchestrator-library.test.mjs`：变量库 schema 规范化、JSON 校验/序列化、合并去重和模板历史上限测试；不启动真实 IndexedDB。
- `README.md`：中英文安装、使用、文件名模板、限制和数据边界说明；行为变更时同步更新。
- `package.json`：仅声明 ESM 和 `npm test` 脚本；不要为已有 Node.js 能力引入依赖。

## 运行流程

扩展入口是 `app.registerExtension({ name: "comfyui-batch-orchestrator", async setup() {} })`：

1. `setup()` 插入 `orchestrator.css`，创建唯一的 `#cbo-panel`，先读取当前浏览器 IndexedDB 变量库，再刷新当前画布；IndexedDB 不可用时降级为内存快速输入并显示状态。
2. `currentPrompt()` 调用 `app.graphToPrompt()`；兼容直接返回 prompt 和 `{ output: prompt }` 两种结果。空工作流或不支持该方法时刷新失败。
3. `graphNodes()` 从 `app.graph._nodes` 取得可视化节点，仅用于标题、负面识别和“定位”按钮；插件不会保存或修改当前可视化画布。
4. `discoverTargets(prompt, graphNodes)` 根据 API prompt 和画布节点生成 UNET、`LoraLoaderModelOnly`、正面文本、输出四类目标，UI 再让用户选择其中的节点。
5. 面板收集模型/LoRA 多选、文本模板、快速单变量值、组合变量槽位和输出模板；标题栏的设置面板保存最大任务数、预览数量、固定/浮动模式、面板坐标和默认/单输出文件名模板。预览只在浏览器内展开配置数量的任务（默认 5，最多 50），不调用 `/prompt`。
6. 组合配置按模型外层、LoRA 次外层、变量槽位顺序和槽位值顺序展开；每个变量值会复制进任务，避免后续库编辑影响已准备批次。提交时逐个 POST `/prompt`，每个任务的失败只标记该任务，循环继续处理后续组合。
7. 有 prompt id 的任务通过每 1.5 秒一次的 `/history/<prompt_id>` 查询更新为完成或失败；没有持久化，刷新页面会丢失面板任务列表。

## 核心规则

### 目标发现

- UNET 目标：`class_type` 匹配 `/unet/i`，且 `inputs.unet_name` 存在。
- LoRA 目标：`class_type` 匹配 `/loraloadermodelonly/i`，且 `inputs.lora_name` 存在。
- 文本目标：`class_type` 匹配 `/cliptextencode/i`，且 `inputs.text` 是字符串。
- 输出目标：只要存在 `inputs.filename_prefix` 就可被发现，不依赖具体输出节点类型。
- API 节点 id 在目标对象中统一转为字符串。画布标题优先使用 `getTitle()`，其次使用 `title`、`properties["Node name for S&R"]`、`type`，最后回退为 `节点 <id>`。
- 负面文本节点会被排除：任意 API 输入名含 `negative`、`负面` 或 `负向` 且其值引用该节点，或画布节点标题/自定义标题含这些关键词，都会被视为负面条件。完全自定义命名的复杂工作流可能需要人工检查发现结果。

### 任务展开

`expandJobs()` 会校验模型、LoRA（有 LoRA 维度时）、每个文本变量槽位的值非空、文本节点存在、UNET 节点存在，然后对原始 prompt 做每任务独立的深复制（优先 `structuredClone`，否则 JSON 序列化）。每个副本只修改：

- 选定 UNET 的 `inputs.unet_name`；
- 选定 `LoraLoaderModelOnly` 的 `inputs.lora_name`；保留 `strength_model` 等其他输入；
- 选定文本节点的 `inputs.text`，用精确的 `{{key}}` 替换全部多变量匹配项；旧 `variable + values` 配置仍转换为一个槽位，保留单变量语义；
- 选定输出节点已有的 `inputs.filename_prefix`。

任务序号从 1 开始，模型顺序在外层，LoRA 顺序居中，变量槽位按配置顺序展开。没有 `config.loras` 时使用一个空 LoRA 维度；`config.outputs` 是当前 UI 使用的多输出配置，核心仍兼容旧式 `outputIds` + `filenameTemplate` 配置。每个任务保留 `model`、`lora`、首个变量的 `value` 兼容字段，并新增完整的 `variables` 数组。

### 文件名

默认模板是 `orchestrator/{{model}}_{{value}}_{{index}}`。可用变量为 `model`、`lora`、`value`、`index`、`seed`，以及每个 ASCII 变量 key 的完整文本 `{{key}}` 和短 label `{{key_label}}`；`index` 从 `001` 开始，`seed` 默认取基础 prompt 中遇到的第一个 seed，也可由配置覆盖。

- 模板不能为空，未知的 `{{name}}` 变量会报错。
- 多变量 key 必须匹配 `[A-Za-z][A-Za-z0-9_]*`；label 为空时文件名回退到完整文本。
- 动态模型名、LoRA 名和值会先取最后一个路径段，清理 Windows 保留字符、控制字符和句点；非法字符变为 `_`。
- 文件名前缀拒绝绝对路径、盘符路径、根路径和独立的 `..` 路径段；静态 `/` 只允许创建输出目录下的相对目录。
- 每个路径段会去除末尾的点和空格，空段会被丢弃；扩展名仍由 ComfyUI 输出节点自身处理。

## 前端适配约定

- 模型选项先请求 `/object_info/UNETLoader` 中 `input.required.unet_name` 的枚举；失败或无结果时回退 `/models/diffusion_models`，最后保留当前工作流中的模型值。
- LoRA 选项先请求 `/object_info/LoraLoaderModelOnly` 中 `input.required.lora_name` 的枚举；失败或无结果时回退 `/models/loras`，最后保留当前工作流中的 LoRA 值。只处理 `LoraLoaderModelOnly`，不修改其他 LoRA 节点。
- 模型值中的 `/` 或 `\\` 被拆成嵌套文件夹；文件夹复选框递归控制后代模型，子项只选中一部分时使用原生 checkbox 的 indeterminate 状态。提交仍使用完整原始模型路径。
- LoRA 值使用与模型相同的层级树和复选框逻辑；提交仍使用完整原始 LoRA 路径。
- 通用 GET 使用 `api.fetchApi(..., { cache: "no-store" })`，提交使用 `api.fetchApi("/prompt", { method: "POST" })`，并在可用时附带 `api.clientId`。
- 设置保存在当前浏览器的 `localStorage`，不会生成仓库配置文件。默认面板模式是右上角固定；浮动模式启用标题栏拖拽，坐标会被限制在窗口内并在拖拽结束时保存。
- `buildPanel()` 是内联 HTML 的唯一 DOM 创建点；事件监听在此绑定。面板、状态、预览、任务列表和控件 id 均使用 `cbo-` 前缀，新增控件要同步 JS 与 CSS。
- “定位”只操作当前 `app.canvas`：选择节点、居中或适配选区；找不到节点时显示错误，不改动工作流。
- 任务 UI 只渲染最近 50 条，默认最新在前，可切换为最早在前。状态映射包含 queued/running/done/failed；当前轮询逻辑在历史报告完成时直接变为 done/failed，未完成时保持 queued。
- 变量库使用原生 IndexedDB 数据库 `comfyui-batch-orchestrator-library`，固定版本 `1` 和 `variables`、`templates`、`templateHistory` 三个 store；不要把变量记录写入面板设置的 `localStorage`。
- 导出包必须保留 schema `comfyui-batch-orchestrator-library`、version `1` 和三个数组。导入默认合并：相同 id 比较 `updatedAt`（历史比较 `lastUsedAt`），变量的 `key + text + label` 相同则去重；JSON 校验或 IndexedDB 事务失败时不能替换现有库。
- 变量库对话框的用户文本使用 `textContent` 和 DOM API 渲染，不把变量值、label、tags、模板正文拼接进可执行 HTML。组合槽位保存值的副本，避免库记录编辑隐式改变当前批次。
- 修改 `orchestrator-core.js` 时优先保持其纯函数边界；需要 ComfyUI 或 DOM 的逻辑放在 `orchestrator.js`，不要把浏览器全局对象带进核心模块。

## 维护与验证

- 运行测试：`npm test`。当前测试覆盖目标发现（含 `LoraLoaderModelOnly`）、负面排除、模型/LoRA 笛卡尔积和 prompt 深复制、单/多文本变量、label 文件名、多输出文件名、文件名安全规则，以及变量库 schema、迁移合并、去重和历史上限；没有浏览器集成测试。
- 修改目标识别、模型树、任务展开或文件名规则时，先更新/补充 `test/orchestrator-core.test.mjs`，再同步 README 的用户可见规则。
- 修改 UI、ComfyUI API 或生命周期时，应在真实 ComfyUI 页面手动验证：面板加载、刷新画布、模型回退、节点定位、预览不入队、逐任务提交和历史轮询。
- 变量库改动还要手动验证：新增/编辑/删除记录、搜索与 tag 筛选、多个槽位勾选、模板保存/加载/历史、刷新后 IndexedDB 保留、JSON 导出到第二浏览器配置后导入，以及坏 JSON 不清空已有数据。Node 静态测试不证明 IndexedDB、原生 dialog、真实 ComfyUI `/prompt`、节点渲染或跨安装导入行为。
- 不要把 `.codegraph/` 生成目录纳入提交；它已在 `.gitignore` 中忽略。不要添加构建产物、持久化任务存储或并发提交，除非需求明确要求。
- 不要把面板设置改成仓库文件或服务端配置；当前持久化边界就是浏览器 `localStorage`。输出模板按 ComfyUI 节点 id 记忆，若未来需要跨工作流稳定复用，再引入工作流指纹。
- 保持当前数据边界：只读取当前 ComfyUI 前端暴露的数据，提交时只把任务 prompt 发回该 ComfyUI 实例，不新增外部服务或遥测。
- 变量库的持久化边界是当前浏览器 IndexedDB；跨浏览器/跨 ComfyUI 安装只通过用户主动的版本化 JSON 导入/导出，不添加后台同步、账户或服务端存储。
