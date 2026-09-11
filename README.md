# ComfyUI Batch Orchestrator

ComfyUI 的本地批量任务编排扩展。它读取当前画布中的可执行工作流，让你选择多个 UNET 模型和 LoRA、批量替换一个或多个正面文本变量，并按“模型 × LoRA × 文本变量笛卡尔积”逐个提交任务。

[中文](#chinese) · [English](#english)

<a id="chinese"></a>

<details open>
<summary>中文</summary>

## 概览

这是一个运行在 ComfyUI 内部的前端扩展，不是独立的 Web 服务。插件会在 ComfyUI 顶部菜单栏插入一个 `Batch` 控件组，点击展开面板，提供：

- 从当前画布读取可执行的 API 工作流。
- 自动发现启用的 `UNETLoader`、`LoraLoaderModelOnly`、正面 `CLIPTextEncode` 和可命名的输出节点。
- 从 `UNETLoader` 的节点定义读取可用模型，并支持多选。
- 从 `LoraLoaderModelOnly` 的节点定义读取可用 LoRA，并支持按文件夹多选。
- 使用 `{{变量名}}` 替换文本模板中的变量。
- 对模型、LoRA 和文本值列表做笛卡尔积；没有 LoRA 节点时保持模型 × 文本值行为。
- 在主面板直接添加任意多个变量，例如 `top × bottom × shoes`，并为每个变量值保存短文件名 label、标签和备注。
- 把整组变量命名保存为“组合”，之后一键载入。
- 在当前浏览器的 IndexedDB 中持久化变量库、组合、命名模板和最多 100 条模板历史。
- 通过版本化 JSON 导入/导出变量库，支持在不同浏览器或不同 ComfyUI 安装之间迁移。
- 为每个输出节点单独设置文件名前缀模板。
- 在提交前生成本地预览，条数可在设置中调整。
- 为 UNET、CLIP 和输出节点提供手动“定位”按钮。
- 自动排除被识别为负面条件的 CLIP 文本节点。
- 按批次跟踪任务状态，支持取消未完成任务和重试失败任务。

例如，选择 3 个模型、2 个 LoRA、2 个上装值和 3 个下装值，会生成 36 个独立任务。

每个任务只会在浏览器内临时复制一份 API JSON；插件不会创建新的可视化工作流，也不会修改或保存当前画布。只有点击 `提交任务` 后，任务才会通过 ComfyUI 的 `/prompt` 接口入队。

## 安装

1. 下载或克隆本仓库。
2. 将整个目录复制到 ComfyUI 的 `custom_nodes` 目录，并保留目录名：

   ```text
   ComfyUI/custom_nodes/comfyui-orchestrator
   ```

3. 重启 ComfyUI。
4. 刷新浏览器页面，在顶部菜单栏找到 `Batch` 控件组。
5. 第一次打开工作流或切换工作流后，点击控件组上的刷新按钮 `⟳`。

插件没有额外的 Python 运行时依赖，也不需要构建步骤。开发测试所需的 Node.js 依赖只使用 Node.js 自带的测试模块。

## 使用流程

### 1. 读取当前画布

点击顶栏 `Batch` 控件组上的刷新按钮 `⟳`。面板只会处理当前画布中能够转换为 API 工作流、且未被禁用或旁路的节点。

### 2. 选择 UNET 和模型

在 `UNET 加载器` 下拉框中选择目标节点，点击右侧 `定位` 可以把画布定位到该节点并高亮它。

在 `模型` 树中展开目录并勾选模型。勾选文件夹会递归选中其中的全部模型，部分选中时文件夹会显示半选状态。模型选项来自当前 ComfyUI 的 `UNETLoader` 节点定义。

如果工作流包含 `LoraLoaderModelOnly`，在 `LoRA 加载器` 中选择目标节点，然后在 `LoRA` 树中按同样方式选择 LoRA。每个任务会把所选值写入该节点的 `lora_name`，不会改动 `strength_model`。没有 LoRA 节点时，LoRA 维度自动退化为一个空维度。

### 3. 选择正面 CLIP 文本节点

在 `CLIP 文本节点` 下拉框中选择要替换的文本节点。负面条件节点不会出现在这个列表中；如果需要确认节点位置，点击右侧的 `定位`。

在 `文本模板` 中使用精确格式的占位符，例如：

```text
studio portrait of {{subject}}, soft daylight, neutral background
```

文本模板框会随内容自动增高，超过上限后转为框内滚动。

`变量` 区默认有一个名为 `subject` 的变量。在变量名右侧点 `插入` 可把 `{{subject}}` 插入到文本光标处；点 `存入库` 可把该变量的全部值保存到变量库。

在变量的输入框中键入值后回车即可添加，多个值也可以用换行或逗号一次粘贴。已添加的值以标签形式列出，点标签上的 `×` 移除。输入时会联想该变量名在库中已有的值。

点 `+ 添加变量` 可以增加任意多个变量，模板随之可以写成：

```text
studio portrait, {{top}}, {{bottom}}, {{shoes}}
```

任务数是模型 × LoRA × 每个变量值数量的乘积，变量顺序就是展开顺序。变量名允许中文等 Unicode 字母，`{{上衣}}` 同样有效。

配好一组变量后点 `保存组合` 可以命名保存，之后在 `变量库` 弹窗中一键载入，载入会替换主面板上的全部变量。

### 4. 设置输出文件名

勾选需要命名的输出节点。每个输出节点都有自己的文件名模板和 `定位` 按钮，因此多个 `SaveImage` 节点可以分别命名。

默认模板：

```text
orchestrator/{{model}}_{{value}}_{{index}}
```

静态 `/` 可以在 ComfyUI 的输出目录下创建子目录。例如：

```text
orchestrator/{{model}}/{{value}}_{{index}}
```

点击顶栏的 `设置` 可以修改最大任务数、预览任务数、默认保存图片模板，以及是否启用 LoRA 维度、提交新批次前是否清空任务记录。设置只保存在当前浏览器的 `localStorage` 中，不会写入仓库；每个输出节点在主面板或设置面板中单独修改的模板也会被记住。

### 5. 预览和提交

点击 `生成预览` 后，预览区会展开，显示任务总数以及设置中指定数量的任务（默认前 5 个）的模型、LoRA、变量值和文件名。这个操作只在面板中生成预览，不会调用 `/prompt`，也不会入队。提交任务后预览区会自动收起，把空间让给任务记录。

确认数量和命名后，点击 `提交任务`。插件会按顺序为每个组合发送一个 `/prompt` 请求，并在面板中轮询任务历史，显示入队、执行、完成或失败状态。

`最大任务数` 默认是 500，用于避免误操作产生过大的批次；预览数量默认为 5，最多可设置为 50。两项都在顶栏的 `设置` 中调整。

## 任务监看

提交后，任务记录按批次分组，每批之前有一条分割线标明批次号、提交时间、任务数和已完成数。记录框内可独立横向滚动查看完整文件名，不会带动面板其它部分。

轮询时会同时读取 ComfyUI 队列，因此正在执行的那一个会显示为「执行中」并高亮，其余排队任务显示「已入队」。

工具栏上的 `取消` 会把本次记录中尚未完成的任务从 ComfyUI 队列移除；只有当正在执行的任务确实属于本插件时才额外调用中断，避免误停其它来源的任务。`重试` 会重新提交状态为失败的任务，沿用原批次的配置与文件名，重试结果仍归入原批次。`清空` 只清空面板上的记录，不影响已经在队列里的任务。

为支持重试，每个批次会保留一份提交时的配置与基础工作流；重试时按任务序号重新展开，而不是为每个任务各存一份工作流 JSON。

## 一个虚构示例

以下模型名、文本值和提示词仅用于说明界面，不代表仓库内置模型，也不对应任何真实机器或工作流。

| 配置项 | 示例 |
| --- | --- |
| UNET 模型 | `demo/aurora_v1.safetensors`、`demo/aurora_v2.safetensors` |
| 文本模板 | `editorial portrait of {{subject}}, soft studio light` |
| 文本值 | `red umbrella`、`yellow raincoat` |
| 输出模板 | `orchestrator/{{model}}/{{value}}_{{index}}` |

2 个模型 × 2 个文本值 = 4 个任务：

```text
001  aurora_v1 × red umbrella
002  aurora_v1 × yellow raincoat
003  aurora_v2 × red umbrella
004  aurora_v2 × yellow raincoat
```

## 文件名模板

支持的动态变量：

| 变量 | 含义 |
| --- | --- |
| `{{model}}` | 当前选中的模型名；会清理路径和文件名中的不安全字符 |
| `{{lora}}` | 当前选中的 LoRA 名；会清理路径和文件名中的不安全字符 |
| `{{value}}` | 第一个变量的值；会清理路径和文件名中的不安全字符 |
| `{{<key>}}` | 多变量槽位对应的完整文本，例如 `{{top}}` |
| `{{<key>_label}}` | 多变量槽位对应的短文件名 label，例如 `{{top_label}}` |
| `{{index}}` | 当前任务序号，从 `001` 开始 |
| `{{seed}}` | 基础工作流中找到的第一个 seed（如果存在） |

规则：

- 模板不能为空。
- 只能使用上表中的变量；变量名必须匹配 `\p{L}[\p{L}\p{N}_]*`，即以 Unicode 字母开头。
- 绝对路径、盘符路径和 `..` 路径段会被拒绝。
- 静态 `/` 只用于创建输出目录下的相对路径。
- 动态值中的 Windows 保留字符会被替换为下划线。
- ComfyUI 仍会按照输出节点自身的行为补充文件扩展名。

建议多变量输出使用 label，避免把完整提示词写进文件名，例如：

```text
orchestrator/{{top_label}}_{{bottom_label}}_{{index}}
```

tags 只用于变量库搜索和筛选，不会自动拼入文件名。

## 预览和提交的区别

| 操作 | 会复制 API JSON | 会调用 `/prompt` | 会修改当前画布 |
| --- | ---: | ---: | ---: |
| `生成预览` | 是，临时 | 否 | 否 |
| `提交任务` | 是，每个任务一份 | 是 | 否 |

## 变量库、模板和迁移

主面板上的 `变量库` 和 `模板库` 是两个独立弹窗。

`变量库` 管理已保存的组合与单个变量值：支持按变量名、文本、label、备注搜索，按 tag 精确筛选，编辑或删除记录。`模板库` 管理命名模板和最近使用历史，每条模板可以就地 `预览` 完整内容、`加载` 到主面板、`编辑` 或删除。最近使用的每条记录可以 `预览`、`加载`，或用 `存为模板` 直接命名存入已保存模板——历史是自动记录的日志，不支持就地编辑，提升为正式模板后再走常规编辑路径。模板历史最多保留 100 条，按模板正文去重。

变量库、组合、模板和历史保存在当前浏览器的 IndexedDB 数据库 `comfyui-batch-orchestrator-library`；面板设置和输出节点模板保存在当前浏览器的 `localStorage`。IndexedDB 不可用时仍可正常配置并提交批次，但变量库 CRUD、历史和迁移不可用。

设置弹窗里的 `导出变量库 JSON` 会导出 schema `comfyui-batch-orchestrator-library`、当前版本号、变量、组合、模板和历史。导入默认合并，不清空当前库：相同 id 保留更新时间较新的记录，不同 id 但变量的 `key + text + label` 相同的记录会去重。导入 JSON 会先校验结构；失败时不会替换现有数据。

## 故障排查

- **面板没有出现**：确认目录位于 `custom_nodes/comfyui-orchestrator`，重启 ComfyUI 并刷新浏览器。
- **面板显示读取失败**：先确保工作流已经打开，再点击顶栏的刷新按钮 `⟳`。
- **模型或 LoRA 列表为空**：确认当前选择的是启用的 `UNETLoader` 或 `LoraLoaderModelOnly`，并确认 ComfyUI 能返回对应的节点选项；刷新 ComfyUI 页面后再试。
- **没有可选的 CLIP 节点**：确认存在启用的 `CLIPTextEncode`；负面条件会被自动排除。
- **提示找不到占位符**：变量名为 `subject` 时，模板中必须出现精确的 `{{subject}}`，包括大括号和大小写。
- **变量库无法打开**：检查浏览器是否允许当前 ComfyUI 来源使用 IndexedDB；此时变量仍可正常输入和提交，只是无法保存到库。
- **导入失败**：只能导入本扩展导出的 schema `comfyui-batch-orchestrator-library` JSON，且版本不能高于当前版本；格式错误不会覆盖现有数据。
- **预览报错**：先检查模型、文本值、输出节点和最大任务数，再重新点击 `生成预览`。
- **定位没有效果**：先点顶栏的刷新按钮 `⟳` 重新读取画布；定位按钮只操作当前打开的画布，不会改变工作流内容。
- **设置没有保留**：设置保存在当前浏览器的 `localStorage`；如果浏览器禁用了站点存储，设置只能在当前页面暂时生效。

## 当前限制

- 只处理当前画布中能够转换为 API 工作流的启用节点。
- LoRA 选择器只处理 `LoraLoaderModelOnly`，不修改其他 LoRA 节点类型。
- 输出节点必须拥有 `filename_prefix` 输入；不具备该输入的自定义节点不会被列为可命名输出。
- 任务按顺序提交，当前没有并发提交、暂停、恢复或持久化批次功能。
- 面板任务记录保存在当前页面内；刷新页面后不会恢复插件自己的任务列表，队列中的任务本身不受影响。
- 变量库、命名模板和最多 100 条模板历史保存在当前浏览器的 IndexedDB，不会自动同步到其他浏览器或 ComfyUI 安装；需要用 JSON 导入/导出迁移。
- 负面 CLIP 的识别依赖连接输入名称或节点标题。使用完全自定义命名的复杂工作流时，建议检查自动发现结果。

## 开发与测试

仓库没有前端构建产物，浏览器直接加载 `web` 目录中的 ES module：

```text
__init__.py                  ComfyUI 扩展入口
web/js/orchestrator.js       面板、预览、提交和状态轮询
web/js/orchestrator-core.js  纯批处理逻辑
web/js/orchestrator-library.js IndexedDB、变量库 CRUD 和 JSON 迁移
web/css/orchestrator.css     面板样式
test/                        Node.js 原生测试（核心和变量库纯逻辑）
```

运行测试：

```bash
npm test
node --check web/js/orchestrator-core.js
node --check web/js/orchestrator-library.js
node --check web/js/orchestrator.js
```

## 实现说明

以下几点是代码里不易一眼看出、改动时容易踩坑的约束。

### 顶栏挂载

面板的控件组注入 ComfyUI 顶部菜单栏，挂载逻辑有三条硬性要求：

- **只插入一次，之后绝不移动。** 早期版本在插入后用 `getBoundingClientRect` 判断可见性，测得宽高为 0 就移除重试；页面初始布局尚未完成时必然测到 0，于是陷入插入→移除→再插入的循环，叠加 Crystools 监视器每秒更新 DOM 触发观察器，表现为菜单持续闪烁。
- **顶栏容器以官方设置按钮组的父元素为准**（`app.menu.settingsGroup.element.parentElement`），不猜类名。
- **排在 Crystools 左侧**：等它出现后插到它前面。Crystools 的容器 class 各版本不一，用 `[class*='crystools']` 前缀匹配，并限定在顶栏容器内查找——否则会命中它设置面板里的元素而插错位置。未安装 Crystools 时退回设置按钮组之前；顶栏是 Vue 异步渲染的，轮询有宽限期。

### 变量名规则

变量名允许中文等 Unicode 字母开头，`{{上衣}}`、`{{subject}}` 都合法，规则为 `/^\p{L}[\p{L}\p{N}_]*$/u`。`orchestrator-core.js` 与 `orchestrator-library.js` 两处必须保持一致，否则面板里能用的变量名存不进库。

### 变量库版本

导出文件带 `schema` 和 `version`。当前版本为 2，比 v1 多了 `variableSets`（组合变量）存储。导入时接受 v1 文件，缺失的存储按空数组处理；高于当前版本的文件会被拒绝，因为结构无法预知。IndexedDB 通过 `onupgradeneeded` 自动补建新存储。

记录级的类型强制与必填校验统一在 `normalizeLibraryData` 中完成，导入路径只额外校验外层信封（schema、version、各存储必须是数组）。

## 数据边界

插件不提供外部云服务，也不包含遥测逻辑。它只读取当前 ComfyUI 前端可访问的画布和节点定义；点击提交后，工作流副本和参数会发送回当前 ComfyUI 实例。变量库、模板和历史只写入当前浏览器 IndexedDB；JSON 导入/导出是用户主动进行的本地迁移，不是服务端同步。

相关 ComfyUI 文档：

- [服务器通信路由](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Workflow API 格式](https://docs.comfy.org/development/api-development/workflow-api-format)
- [LoRA 加载器（仅模型）](https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/LoraLoaderModelOnly/zh.md)

</details>

<a id="english"></a>

<details>
<summary>English</summary>

## Overview

ComfyUI Batch Orchestrator is a local batch-job extension for ComfyUI. It reads the executable workflow on the current canvas, lets you select multiple UNET models and LoRAs, replaces one or more text variables with reusable values, and expands the combinations as a model × LoRA × text-slot Cartesian product.

It runs inside ComfyUI as a frontend extension rather than as a separate web service. It inserts a `Batch` button group into the ComfyUI topbar that opens the panel, and can:

- Read the current canvas as an API workflow.
- Discover enabled `UNETLoader`, `LoraLoaderModelOnly`, positive `CLIPTextEncode`, and nameable output nodes.
- Load model choices from the `UNETLoader` node definition and allow multi-selection.
- Load LoRA choices from the `LoraLoaderModelOnly` node definition and allow folder-based multi-selection.
- Replace a `{{variable}}` placeholder in a text template.
- Generate one job for every model/LoRA/value combination; workflows without a LoRA node keep the model/value behavior.
- Add any number of variables directly in the panel, such as `top × bottom × shoes`, with short filename labels, tags, and notes for each value.
- Save a whole set of variables as a named combination and load it back in one click.
- Persist variables, combinations, named templates, and up to 100 recent template uses in browser-local IndexedDB.
- Export and import a versioned JSON library for migration between browsers or ComfyUI installations.
- Configure a separate filename-prefix template for each output node.
- Show a local preview before submission; the number of jobs shown is configurable.
- Provide manual `Locate` buttons for UNET, CLIP, and output nodes.
- Exclude CLIP text nodes identified as negative conditioning.
- Track task state per batch, with cancel for unfinished jobs and retry for failed ones.

For example, 3 selected models, 2 LoRAs, 2 top values, and 3 bottom values produce 36 independent jobs.

Each job is a temporary in-memory copy of the API JSON. The extension does not create a new visual workflow and does not modify or save the current canvas. Jobs are sent to ComfyUI through `/prompt` only after `Submit jobs` is clicked.

## Installation

1. Download or clone this repository.
2. Copy the whole directory into ComfyUI's `custom_nodes` directory, keeping the directory name:

   ```text
   ComfyUI/custom_nodes/comfyui-orchestrator
   ```

3. Restart ComfyUI.
4. Refresh the browser and look for the `Batch` button group in the topbar.
5. Click the refresh button `⟳` in that group after opening or switching workflows.

The extension has no additional Python runtime dependencies and does not require a build step. The optional development test command uses Node.js's built-in test module.

## Usage

### 1. Read the current canvas

Click the refresh button `⟳` in the topbar `Batch` group. The panel only handles nodes that can be converted to an API workflow and are not disabled or bypassed.

### 2. Select the UNET and models

Choose the target node from `UNET Loader`. Click its `Locate` button to center and highlight the node on the canvas.

Expand folders and check models in the `Models` tree. Checking a folder selects all models below it, and a partially selected folder shows an indeterminate checkbox. The entries come from ComfyUI's current `UNETLoader` node definition.

If the workflow contains `LoraLoaderModelOnly`, choose the target in `LoRA loader`, then select LoRAs in the `LoRAs` tree. Each job writes the selected value to `lora_name` and leaves `strength_model` unchanged. Without a LoRA node, the LoRA dimension is an implicit single empty value.

### 3. Select the positive CLIP text node

Choose the target from `CLIP text node`. Negative-conditioning nodes are omitted from this list. Click `Locate` when you need to inspect the node on the canvas.

Use an exact placeholder in `Text template`, for example:

```text
studio portrait of {{subject}}, soft daylight, neutral background
```

The text template box grows with its content and scrolls internally past a maximum height.

The `Variables` area starts with one variable named `subject`. `Insert` next to the name inserts `{{subject}}` at the textarea cursor; `Save to library` stores all of that variable's values.

Type a value in the variable's input and press Enter to add it; several values can be pasted at once separated by newlines or commas. Added values are listed as chips, and the `×` on a chip removes it. Typing suggests values already stored in the library under that name.

`+ Add variable` adds as many variables as you need, so the template can read:

```text
studio portrait, {{top}}, {{bottom}}, {{shoes}}
```

The job count is the product of the models, LoRAs, and each variable's values; variable order is expansion order. Variable names may start with any Unicode letter, so `{{上衣}}` is valid too.

Once a set of variables is configured, `Save combination` stores it under a name; loading it from the `Variable library` dialog replaces all variables in the panel.

### 4. Configure output filenames

Select the output nodes to name. Every output row has its own filename template and `Locate` button, so multiple `SaveImage` nodes can be configured independently.

Default template:

```text
orchestrator/{{model}}_{{value}}_{{index}}
```

Static `/` creates a relative subdirectory below ComfyUI's output directory:

```text
orchestrator/{{model}}/{{value}}_{{index}}
```

Open `Settings` from the topbar to change the maximum job count, preview count, default output filename template, whether the LoRA dimension is enabled, and whether the task log is cleared before each new batch. Settings are stored only in the current browser's `localStorage`, not in the repository; per-output template overrides made in either panel are remembered too.

### 5. Preview and submit

Click `Generate preview` to expand the preview area and show the total job count and the configured number of jobs (five by default), including their model, LoRA, variable values, and filename. Preview generation stays in the panel; it does not call `/prompt` and does not enqueue anything. The preview collapses automatically after submission to leave room for the task log.

After checking the count and names, click `Submit jobs`. The extension sends one `/prompt` request per combination in order, then polls task history and displays queued, running, completed, or failed states.

`Maximum jobs` defaults to 500 to reduce accidental oversized batches; the preview count defaults to five and can be set up to 50. Both values are changed from `Settings` in the topbar.

## Task monitoring

After submission the task log is grouped by batch, with a divider before each batch showing its number, submission time, task count, and completed count. The log scrolls horizontally on its own so long filenames can be read without moving the rest of the panel.

Polling also reads the ComfyUI queue, so the job currently executing is shown as running and highlighted while the rest stay queued.

`Cancel` in the toolbar removes this log's unfinished tasks from the ComfyUI queue. It only calls interrupt when the currently executing job actually belongs to this extension, so jobs from other sources are never stopped. `Retry` resubmits failed tasks using their original batch configuration and filenames, and the results stay under the original batch. `Clear` only empties the on-screen log and does not touch anything already queued.

To support retry, each batch keeps one snapshot of the config and base workflow it was submitted with; retry re-expands jobs by index instead of storing a workflow JSON per task.

## Fictional example

The model names, text values, and prompt below are fictional interface examples. They are not bundled models and do not refer to any real machine or workflow.

| Setting | Example |
| --- | --- |
| UNET models | `demo/aurora_v1.safetensors`, `demo/aurora_v2.safetensors` |
| Text template | `editorial portrait of {{subject}}, soft studio light` |
| Text values | `red umbrella`, `yellow raincoat` |
| Output template | `orchestrator/{{model}}/{{value}}_{{index}}` |

Two models × two text values = four jobs:

```text
001  aurora_v1 × red umbrella
002  aurora_v1 × yellow raincoat
003  aurora_v2 × red umbrella
004  aurora_v2 × yellow raincoat
```

## Filename templates

Supported dynamic variables:

| Variable | Meaning |
| --- | --- |
| `{{model}}` | Selected model name, sanitized for a safe filename |
| `{{lora}}` | Selected LoRA name, sanitized for a safe filename |
| `{{value}}` | Value of the first variable, sanitized for a safe filename |
| `{{<key>}}` | Full text for a multi-variable slot, such as `{{top}}` |
| `{{<key>_label}}` | Short filename label for a multi-variable slot, such as `{{top_label}}` |
| `{{index}}` | One-based job number, padded as `001`, `002`, and so on |
| `{{seed}}` | The first seed found in the base workflow, when available |

Rules:

- The template cannot be empty.
- Only the variables above are supported; variable names must match `\p{L}[\p{L}\p{N}_]*`, that is, start with a Unicode letter.
- Absolute paths, drive-letter paths, and `..` path segments are rejected.
- Static `/` is for relative subdirectories below the output directory.
- Windows-reserved characters in dynamic values are replaced with underscores.
- ComfyUI still adds the file extension according to the output node.

For multi-variable batches, prefer labels so full prompt text does not become a filename:

```text
orchestrator/{{top_label}}_{{bottom_label}}_{{index}}
```

Tags are used for library search and filtering; they are not automatically emitted into filenames.

## Preview versus submission

| Action | Copies API JSON | Calls `/prompt` | Changes the current canvas |
| --- | ---: | ---: | ---: |
| `Generate preview` | Yes, temporarily | No | No |
| `Submit jobs` | Yes, once per job | Yes | No |

## Variable library, templates, and migration

`Variable library` and `Template library` are two separate dialogs opened from the panel.

`Variable library` manages saved combinations and individual variable values: search across names, text, labels, and notes, exact tag filtering, and edit/delete. `Template library` manages named templates and recent history; each template can be previewed in place, loaded into the panel, edited, or deleted. Each history entry can be previewed, loaded, or promoted with `Save as template`, which names it and stores it among the saved templates — history is an automatic log and is not edited in place; promote it first and then edit it the usual way. History is capped at 100 entries and deduplicated by template body.

Variables, combinations, templates, and history are stored in the current browser's IndexedDB database, `comfyui-batch-orchestrator-library`. Panel settings and output-template overrides remain in the current browser's `localStorage`. If IndexedDB is unavailable you can still configure and submit batches; only library CRUD, history, and migration are unavailable.

`Export library JSON` in the settings dialog writes the `comfyui-batch-orchestrator-library` schema, the current version, variables, combinations, templates, and history. Imports merge by default rather than clearing the current library: equal ids keep the newer timestamp, and variable records with equal `key + text + label` are deduplicated. The JSON is validated before replacement; a failed import leaves existing data unchanged.

## Troubleshooting

- **The panel is missing**: confirm the directory is `custom_nodes/comfyui-orchestrator`, restart ComfyUI, and refresh the browser.
- **Canvas loading fails**: open the workflow first, then click the topbar refresh button `⟳`.
- **The model list is empty**: make sure the selected node is an enabled `UNETLoader` and that ComfyUI returns model choices for it.
- **No CLIP node is available**: make sure an enabled `CLIPTextEncode` exists; negative-conditioning nodes are filtered out.
- **The placeholder is reported as missing**: if the variable name is `subject`, the template must contain the exact `{{subject}}`, including braces and case.
- **The variable library cannot open**: check whether the current ComfyUI origin allows browser IndexedDB; variables can still be entered and submitted, they just cannot be saved to the library.
- **Import fails**: only `comfyui-batch-orchestrator-library` JSON no newer than the current version is accepted; malformed input does not overwrite existing data.
- **Preview reports an error**: check the model selection, text values, output selection, and maximum-job limit, then generate the preview again.
- **Locate does nothing**: refresh the current canvas first. Locate only acts on the currently open canvas and does not change workflow content.
- **Settings are not retained**: settings are stored in the current browser's `localStorage`; if site storage is disabled, they only apply to the current page.

## Current limitations

- Only enabled nodes that can be converted to an API workflow are supported.
- The LoRA selector only handles `LoraLoaderModelOnly`; other LoRA node types are not modified.
- An output node must expose a `filename_prefix` input to be listed as a nameable output.
- Jobs are submitted sequentially. There is currently no concurrent submission, pause/resume, or persistent batch feature.
- The panel's task list is kept in the current page and is not restored after a page refresh; queued jobs themselves are unaffected.
- The variable library, named templates, and up to 100 history entries live in the current browser's IndexedDB; they are not synced across browsers or ComfyUI installations without JSON export/import.
- Negative-CLIP detection uses connection input names or node titles. For complex custom workflows with fully custom naming, verify the discovered target list.

## Development and testing

There is no frontend build artifact; ComfyUI loads the ES modules directly from `web`:

```text
__init__.py                  ComfyUI extension entry point
web/js/orchestrator.js       Panel, preview, submission, and polling
web/js/orchestrator-core.js  Pure batch logic
web/js/orchestrator-library.js IndexedDB CRUD and JSON migration helpers
web/css/orchestrator.css     Panel styling
test/                        Native Node.js tests for core and library logic
```

Run the checks:

```bash
npm test
node --check web/js/orchestrator-core.js
node --check web/js/orchestrator-library.js
node --check web/js/orchestrator.js
```

## Implementation notes

These constraints are not obvious from the code and are easy to break.

### Topbar mounting

The control group is injected into the ComfyUI top menu bar. Three hard requirements:

- **Insert once, never move afterwards.** An earlier version checked `getBoundingClientRect` after insertion and removed the element when it measured zero. Initial layout has not settled at that point, so it always measured zero, producing an insert → remove → insert loop. Combined with the Crystools monitor mutating the DOM every second to refresh its readouts, this made the menu flicker continuously.
- **Locate the topbar container via the official settings button group's parent** (`app.menu.settingsGroup.element.parentElement`) rather than guessing class names.
- **Sit to the left of Crystools**: wait for it, then insert before it. Its container class differs across versions, so matching uses the `[class*='crystools']` prefix, scoped to the topbar container — an unscoped query also matches elements inside its settings panel and would insert in the wrong place. Without Crystools installed, fall back to inserting before the settings button group. The topbar is rendered asynchronously by Vue, so polling has a grace period.

### Variable name rules

Variable names may start with any Unicode letter, so both `{{subject}}` and `{{上衣}}` are valid; the rule is `/^\p{L}[\p{L}\p{N}_]*$/u`. It must stay identical in `orchestrator-core.js` and `orchestrator-library.js`, otherwise names accepted by the panel cannot be saved to the library.

### Library version

Exports carry `schema` and `version`. The current version is 2, adding the `variableSets` store on top of v1. Imports accept v1 files and treat missing stores as empty arrays; files newer than the current version are rejected because their structure cannot be anticipated. IndexedDB creates the new store automatically through `onupgradeneeded`.

Per-record type coercion and required-field validation all happen in `normalizeLibraryData`; the import path only additionally validates the outer envelope (schema, version, and that each store is an array).

## Data boundary

The extension does not provide a cloud service and contains no telemetry logic. It reads the canvas and node definitions exposed by the current ComfyUI frontend; after submission, the workflow copies and parameters are sent back to that ComfyUI instance. The variable library, templates, and history stay in browser-local IndexedDB; JSON migration is an explicit local export/import action, not server synchronization.

Relevant ComfyUI documentation:

- [Server communication routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Workflow API format](https://docs.comfy.org/development/api-development/workflow-api-format)
- [LoRA Loader (Model Only)](https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/LoraLoaderModelOnly/zh.md)

</details>
