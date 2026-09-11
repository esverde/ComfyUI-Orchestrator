# ComfyUI Batch Orchestrator

ComfyUI 的本地批量任务编排扩展。它读取当前画布中的可执行工作流，让你选择多个 UNET 模型和 LoRA、批量替换一个或多个正面文本变量，并按“模型 × LoRA × 文本变量笛卡尔积”逐个提交任务。

[English](README.md) · **简体中文**

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

## 环境要求

- 较新的 ComfyUI 版本（使用 Vue 前端）。插件只针对最新版开发，不包含向后兼容代码。
- 支持 IndexedDB、`<dialog>` 和 `structuredClone` 的现代浏览器，变量库功能依赖这些特性。
- 无 Python 依赖、无构建步骤、无运行时 npm 依赖。Node.js 只在跑测试时需要。

## 安装

1. 下载或克隆本仓库。
2. 将整个目录复制到 ComfyUI 的 `custom_nodes` 目录，并保留目录名：

   ```text
   ComfyUI/custom_nodes/comfyui-orchestrator
   ```

3. 重启 ComfyUI。
4. 刷新浏览器页面，在顶部菜单栏找到 `Batch` 控件组。
5. 展开面板。面板会在首次展开时读取画布；切换工作流后点击刷新按钮 `⟳` 重新读取。

## 使用流程

### 1. 读取当前画布

面板在首次展开时会自动读取画布。切换或改动工作流后，点击顶栏 `Batch` 控件组上的刷新按钮 `⟳` 重新读取。面板只会处理当前画布中能够转换为 API 工作流、且未被禁用或旁路的节点。

之所以放在首次展开而不是扩展加载时读取：ComfyUI 是在扩展 `setup()` 执行完之后才把工作流恢复进画布的，加载时读取必然读到空画布。

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

变量是可选的。把变量全部留空，就是用同一条固定提示词横扫模型和 LoRA，任务数等于模型 × LoRA，文本节点保持原样不动。没填值的变量会被忽略，但模板里如果还留着 `{{占位符}}` 仍会报错——没有任何值能替换它。没有变量时 `{{value}}` 会渲染为空串，建议从文件名模板里去掉。

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

## 架构

### 模块划分

```text
__init__.py                    ComfyUI 扩展入口，只负责暴露 web 目录
web/js/orchestrator.js         面板、顶栏挂载、预览、提交、轮询、库 UI
web/js/orchestrator-core.js    纯批处理逻辑：节点发现、任务展开、文件名渲染
web/js/orchestrator-library.js IndexedDB 存储、记录归一化、JSON 导入导出
web/css/orchestrator.css       面板样式
test/                          两个纯逻辑模块的 Node.js 原生测试
```

划分规则只有一条：不依赖 DOM 就能测的全部放进 `orchestrator-core.js` 或 `orchestrator-library.js`，凡是碰 `document`、`app`、`api` 的全部留在 `orchestrator.js`。所以下面两个模块有完整测试而面板没有——值得测的逻辑都在那两个模块里。

### 数据流

```text
画布 ──app.graphToPrompt()──> API JSON
                                   │
                   discoverTargets(prompt, graphNodes)
                                   │
                   ┌───────────────┴────────────────┐
            UNET / LoRA / CLIP / 输出节点候选         │
                                   │                │
                        面板上的用户选择 ────────────┘
                                   │
                        expandJobs(prompt, config)   生成器
                                   │
              { index, model, lora, variables, filenamePrefixes, prompt }
                                   │
                 预览（只在面板内）  ──或──   逐个 POST /prompt
                                                        │
                                          轮询 /history/{id} 与 /queue
                                                        │
                                                    任务记录 UI
```

`expandJobs` 是生成器，且完全确定：同一组 `(prompt, config)` 必然按同样顺序产出同样的任务。预览、提交、重试走的都是它，这也是重试能够只按序号定位、而不必为每个任务单独存一份工作流 JSON 的原因。

### 状态存放位置

| 位置 | 内容 | 生命周期 |
| --- | --- | --- |
| 内存中的 `state` | 发现的节点、选择、任务、批次快照 | 当前页面 |
| `localStorage` | 面板设置、各输出节点的文件名模板 | 当前浏览器 |
| IndexedDB | 变量、组合、模板、模板历史 | 当前浏览器 |
| ComfyUI 服务端 | 已入队和正在执行的任务 | 服务端 |

任何内容都不会写进仓库，当前画布也从不被修改或保存。

### 通知

所有面向用户的消息都只经过一个 `setStatus`，它转发到 `app.extensionManager.toast.add`。任何消息都不会写进顶栏或状态元素——面板里根本没有状态栏。

## 实现说明

以下几点是代码里不易一眼看出、改动时容易踩坑的约束。

### 顶栏挂载

面板的控件组注入 ComfyUI 顶部菜单栏，挂载逻辑有三条硬性要求：

- **只插入一次，之后绝不移动。** 早期版本在插入后用 `getBoundingClientRect` 判断可见性，测得宽高为 0 就移除重试；页面初始布局尚未完成时必然测到 0，于是陷入插入→移除→再插入的循环，叠加 Crystools 监视器每秒更新 DOM 触发观察器，表现为菜单持续闪烁。
- **顶栏容器以官方设置按钮组的父元素为准**（`app.menu.settingsGroup.element.parentElement`），不猜类名。
- **排在 Crystools 左侧**：等它出现后插到它前面。Crystools 的容器 class 各版本不一，用 `[class*='crystools']` 前缀匹配，并限定在顶栏容器内查找——否则会命中它设置面板里的元素而插错位置。未安装 Crystools 时退回设置按钮组之前；顶栏是 Vue 异步渲染的，轮询有宽限期。

面板元素在顶栏挂进文档之前就已构建，因此内部的 `byId` 需要回退到在游离的顶栏子树中查找。缺了这个回退，所有监听器绑定都会静默地落到 `null` 上，表现为 UI 正常显示但完全点不动。

### 变量名规则

变量名允许中文等 Unicode 字母开头，`{{上衣}}`、`{{subject}}` 都合法，规则为 `/^\p{L}[\p{L}\p{N}_]*$/u`。`orchestrator-core.js` 与 `orchestrator-library.js` 两处必须保持一致，否则面板里能用的变量名存不进库。

### 变量库版本

导出文件带 `schema` 和 `version`。当前版本为 2，比 v1 多了 `variableSets`（组合变量）存储。导入时接受 v1 文件，缺失的存储按空数组处理；高于当前版本的文件会被拒绝，因为结构无法预知。IndexedDB 通过 `onupgradeneeded` 自动补建新存储。

记录级的类型强制与必填校验统一在 `normalizeLibraryData` 中完成，导入路径只额外校验外层信封（schema、version、各存储必须是数组）。

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

仓库没有前端构建产物，浏览器直接加载 `web` 目录中的 ES module。运行测试：

```bash
npm test
node --check web/js/orchestrator-core.js
node --check web/js/orchestrator-library.js
node --check web/js/orchestrator.js
```

`npm test` 使用 Node.js 自带的测试模块，没有需要安装的 npm 依赖。

## 数据边界

插件不提供外部云服务，也不包含遥测逻辑。它只读取当前 ComfyUI 前端可访问的画布和节点定义；点击提交后，工作流副本和参数会发送回当前 ComfyUI 实例。变量库、模板和历史只写入当前浏览器 IndexedDB；JSON 导入/导出是用户主动进行的本地迁移，不是服务端同步。

相关 ComfyUI 文档：

- [服务器通信路由](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Workflow API 格式](https://docs.comfy.org/development/api-development/workflow-api-format)
- [LoRA 加载器（仅模型）](https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/LoraLoaderModelOnly/zh.md)

## 许可证

[MIT](LICENSE)
