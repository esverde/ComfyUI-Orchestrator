# ComfyUI Batch Orchestrator

ComfyUI 的本地批量任务编排侧边栏。它读取当前画布中的可执行工作流，让你选择多个 UNET 模型、批量替换正面文本变量，并按“模型 × 文本值”的笛卡尔积逐个提交任务。

[中文](#chinese) · [English](#english)

<a id="chinese"></a>

<details open>
<summary>中文</summary>

## 概览

这是一个运行在 ComfyUI 内部的前端扩展，不是独立的 Web 服务。插件会在画布右侧添加 `Batch Orchestrator` 面板，提供：

- 从当前画布读取可执行的 API 工作流。
- 自动发现启用的 `UNETLoader`、正面 `CLIPTextEncode` 和可命名的输出节点。
- 从 `UNETLoader` 的节点定义读取可用模型，并支持多选。
- 使用 `{{变量名}}` 替换文本模板中的变量。
- 对模型列表和文本值列表做笛卡尔积。
- 为每个输出节点单独设置文件名前缀模板。
- 在提交前生成前 5 个任务的本地预览。
- 为 UNET、CLIP 和输出节点提供手动“定位”按钮。
- 自动排除被识别为负面条件的 CLIP 文本节点。

例如，选择 3 个模型和 4 个文本值，会生成 12 个独立任务。

每个任务只会在浏览器内临时复制一份 API JSON；插件不会创建新的可视化工作流，也不会修改或保存当前画布。只有点击 `提交任务` 后，任务才会通过 ComfyUI 的 `/prompt` 接口入队。

## 安装

1. 下载或克隆本仓库。
2. 将整个目录复制到 ComfyUI 的 `custom_nodes` 目录，并保留目录名：

   ```text
   ComfyUI/custom_nodes/comfyui-orchestrator
   ```

3. 重启 ComfyUI。
4. 刷新浏览器页面，在右侧找到 `Batch Orchestrator` 面板。
5. 第一次打开工作流或切换工作流后，点击 `刷新当前画布`。

插件没有额外的 Python 运行时依赖，也不需要构建步骤。开发测试所需的 Node.js 依赖只使用 Node.js 自带的测试模块。

## 使用流程

### 1. 读取当前画布

点击 `刷新当前画布`。面板只会处理当前画布中能够转换为 API 工作流、且未被禁用或旁路的节点。

### 2. 选择 UNET 和模型

在 `UNET 加载器` 下拉框中选择目标节点，点击右侧 `定位` 可以把画布定位到该节点并高亮它。

在 `模型（可多选）` 列表中按住 Ctrl（Windows/Linux）或 Command（macOS）选择多个模型。模型选项来自当前 ComfyUI 的 `UNETLoader` 节点定义。

### 3. 选择正面 CLIP 文本节点

在 `CLIP 文本节点` 下拉框中选择要替换的文本节点。负面条件节点不会出现在这个列表中；如果需要确认节点位置，点击右侧的 `定位`。

在 `文本模板` 中使用精确格式的占位符，例如：

```text
studio portrait of {{subject}}, soft daylight, neutral background
```

变量名必须和占位符一致。也可以先填写变量名，再点击 `插入变量`，插件会把 `{{subject}}` 插入到文本光标所在位置。

在 `变量值` 中每行填写一个值，空行会被忽略：

```text
red umbrella
yellow raincoat
blue scarf
```

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

### 5. 预览和提交

点击 `生成预览` 后，面板会显示任务总数以及前 5 个任务的模型、文本值和文件名。这个操作只在面板中生成预览，不会调用 `/prompt`，也不会入队。

确认数量和命名后，点击 `提交任务`。插件会按顺序为每个组合发送一个 `/prompt` 请求，并在面板中轮询任务历史，显示入队、执行、完成或失败状态。

`最大任务数` 默认是 100，用于避免误操作产生过大的批次。需要更大的批次时，可以先确认模型数和文本值数，再调整这个上限。

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
| `{{value}}` | 当前文本变量值；会清理路径和文件名中的不安全字符 |
| `{{index}}` | 当前任务序号，从 `001` 开始 |
| `{{seed}}` | 基础工作流中找到的第一个 seed（如果存在） |

规则：

- 模板不能为空。
- 只能使用上表中的变量。
- 绝对路径、盘符路径和 `..` 路径段会被拒绝。
- 静态 `/` 只用于创建输出目录下的相对路径。
- 动态值中的 Windows 保留字符会被替换为下划线。
- ComfyUI 仍会按照输出节点自身的行为补充文件扩展名。

## 预览和提交的区别

| 操作 | 会复制 API JSON | 会调用 `/prompt` | 会修改当前画布 |
| --- | ---: | ---: | ---: |
| `生成预览` | 是，临时 | 否 | 否 |
| `提交任务` | 是，每个任务一份 | 是 | 否 |

## 故障排查

- **面板没有出现**：确认目录位于 `custom_nodes/comfyui-orchestrator`，重启 ComfyUI 并刷新浏览器。
- **面板显示读取失败**：先确保工作流已经打开，再点击 `刷新当前画布`。
- **模型列表为空**：确认当前选择的是启用的 `UNETLoader`，并确认 ComfyUI 能为该节点返回模型选项。
- **没有可选的 CLIP 节点**：确认存在启用的 `CLIPTextEncode`；负面条件会被自动排除。
- **提示找不到占位符**：变量名为 `subject` 时，模板中必须出现精确的 `{{subject}}`，包括大括号和大小写。
- **预览报错**：先检查模型、文本值、输出节点和最大任务数，再重新点击 `生成预览`。
- **定位没有效果**：先刷新当前画布；定位按钮只操作当前打开的画布，不会改变工作流内容。

## 当前限制

- 只处理当前画布中能够转换为 API 工作流的启用节点。
- 输出节点必须拥有 `filename_prefix` 输入；不具备该输入的自定义节点不会被列为可命名输出。
- 任务按顺序提交，当前没有并发提交、暂停、恢复或持久化批次功能。
- 面板任务记录保存在当前页面内；刷新页面后不会恢复插件自己的任务列表。
- 负面 CLIP 的识别依赖连接输入名称或节点标题。使用完全自定义命名的复杂工作流时，建议检查自动发现结果。

## 开发与测试

仓库没有前端构建产物，浏览器直接加载 `web` 目录中的 ES module：

```text
__init__.py                  ComfyUI 扩展入口
web/js/orchestrator.js       面板、预览、提交和状态轮询
web/js/orchestrator-core.js  纯批处理逻辑
web/css/orchestrator.css     面板样式
test/                        Node.js 原生测试
```

运行测试：

```bash
npm test
node --check web/js/orchestrator-core.js
node --check web/js/orchestrator.js
```

## 数据边界

插件不提供外部云服务，也不包含遥测逻辑。它只读取当前 ComfyUI 前端可访问的画布和节点定义；点击提交后，工作流副本和参数会发送回当前 ComfyUI 实例。

相关 ComfyUI 文档：

- [服务器通信路由](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Workflow API 格式](https://docs.comfy.org/development/api-development/workflow-api-format)

</details>

<a id="english"></a>

<details>
<summary>English</summary>

## Overview

ComfyUI Batch Orchestrator is a local batch-job sidebar extension for ComfyUI. It reads the executable workflow on the current canvas, lets you select multiple UNET models, replaces a text variable with multiple values, and expands the combinations as a Cartesian product.

It runs inside ComfyUI as a frontend extension rather than as a separate web service. The panel can:

- Read the current canvas as an API workflow.
- Discover enabled `UNETLoader`, positive `CLIPTextEncode`, and nameable output nodes.
- Load model choices from the `UNETLoader` node definition and allow multi-selection.
- Replace a `{{variable}}` placeholder in a text template.
- Generate one job for every model/value combination.
- Configure a separate filename-prefix template for each output node.
- Show a local preview of the first five jobs before submission.
- Provide manual `Locate` buttons for UNET, CLIP, and output nodes.
- Exclude CLIP text nodes identified as negative conditioning.

For example, 3 selected models and 4 text values produce 12 independent jobs.

Each job is a temporary in-memory copy of the API JSON. The extension does not create a new visual workflow and does not modify or save the current canvas. Jobs are sent to ComfyUI through `/prompt` only after `Submit jobs` is clicked.

## Installation

1. Download or clone this repository.
2. Copy the whole directory into ComfyUI's `custom_nodes` directory, keeping the directory name:

   ```text
   ComfyUI/custom_nodes/comfyui-orchestrator
   ```

3. Restart ComfyUI.
4. Refresh the browser and look for the `Batch Orchestrator` panel on the right.
5. Click `Refresh current canvas` after opening or switching workflows.

The extension has no additional Python runtime dependencies and does not require a build step. The optional development test command uses Node.js's built-in test module.

## Usage

### 1. Read the current canvas

Click `Refresh current canvas`. The panel only handles nodes that can be converted to an API workflow and are not disabled or bypassed.

### 2. Select the UNET and models

Choose the target node from `UNET Loader`. Click its `Locate` button to center and highlight the node on the canvas.

Use Ctrl (Windows/Linux) or Command (macOS) to select multiple entries in `Models`. The entries come from ComfyUI's current `UNETLoader` node definition.

### 3. Select the positive CLIP text node

Choose the target from `CLIP text node`. Negative-conditioning nodes are omitted from this list. Click `Locate` when you need to inspect the node on the canvas.

Use an exact placeholder in `Text template`, for example:

```text
studio portrait of {{subject}}, soft daylight, neutral background
```

The variable name must match the placeholder. You can also enter the variable name and click `Insert variable`; the panel inserts `{{subject}}` at the current textarea cursor.

Enter one value per line in `Variable values`; blank lines are ignored:

```text
red umbrella
yellow raincoat
blue scarf
```

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

### 5. Preview and submit

Click `Generate preview` to show the total job count and the first five jobs, including their model, text value, and filename. Preview generation stays in the panel; it does not call `/prompt` and does not enqueue anything.

After checking the count and names, click `Submit jobs`. The extension sends one `/prompt` request per combination in order, then polls task history and displays queued, running, completed, or failed states.

`Maximum jobs` defaults to 100 to reduce accidental oversized batches. Check the model/value counts before raising the limit.

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
| `{{value}}` | Current text value, sanitized for a safe filename |
| `{{index}}` | One-based job number, padded as `001`, `002`, and so on |
| `{{seed}}` | The first seed found in the base workflow, when available |

Rules:

- The template cannot be empty.
- Only the variables above are supported.
- Absolute paths, drive-letter paths, and `..` path segments are rejected.
- Static `/` is for relative subdirectories below the output directory.
- Windows-reserved characters in dynamic values are replaced with underscores.
- ComfyUI still adds the file extension according to the output node.

## Preview versus submission

| Action | Copies API JSON | Calls `/prompt` | Changes the current canvas |
| --- | ---: | ---: | ---: |
| `Generate preview` | Yes, temporarily | No | No |
| `Submit jobs` | Yes, once per job | Yes | No |

## Troubleshooting

- **The panel is missing**: confirm the directory is `custom_nodes/comfyui-orchestrator`, restart ComfyUI, and refresh the browser.
- **Canvas loading fails**: open the workflow first, then click `Refresh current canvas`.
- **The model list is empty**: make sure the selected node is an enabled `UNETLoader` and that ComfyUI returns model choices for it.
- **No CLIP node is available**: make sure an enabled `CLIPTextEncode` exists; negative-conditioning nodes are filtered out.
- **The placeholder is reported as missing**: if the variable name is `subject`, the template must contain the exact `{{subject}}`, including braces and case.
- **Preview reports an error**: check the model selection, text values, output selection, and maximum-job limit, then generate the preview again.
- **Locate does nothing**: refresh the current canvas first. Locate only acts on the currently open canvas and does not change workflow content.

## Current limitations

- Only enabled nodes that can be converted to an API workflow are supported.
- An output node must expose a `filename_prefix` input to be listed as a nameable output.
- Jobs are submitted sequentially. There is currently no concurrent submission, pause/resume, or persistent batch feature.
- The panel's task list is kept in the current page and is not restored after a page refresh.
- Negative-CLIP detection uses connection input names or node titles. For complex custom workflows with fully custom naming, verify the discovered target list.

## Development and testing

There is no frontend build artifact; ComfyUI loads the ES modules directly from `web`:

```text
__init__.py                  ComfyUI extension entry point
web/js/orchestrator.js       Panel, preview, submission, and polling
web/js/orchestrator-core.js  Pure batch logic
web/css/orchestrator.css     Panel styling
test/                        Native Node.js tests
```

Run the checks:

```bash
npm test
node --check web/js/orchestrator-core.js
node --check web/js/orchestrator.js
```

## Data boundary

The extension does not provide a cloud service and contains no telemetry logic. It reads the canvas and node definitions exposed by the current ComfyUI frontend; after submission, the workflow copies and parameters are sent back to that ComfyUI instance.

Relevant ComfyUI documentation:

- [Server communication routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Workflow API format](https://docs.comfy.org/development/api-development/workflow-api-format)

</details>
