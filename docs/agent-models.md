# 按 Agent 配置模型

项目的 `provider`、`model` 是显式默认模型；可用 `agentModels` 为每个实际调用的 Agent 指定完整模型组合。未单独配置的 Agent 使用项目默认模型，策略预览显示每个 Agent 的最终选择及来源。

模型配置只有三个 Agent。需求 Agent 对齐业务；开发 Agent 负责项目理解、方案讨论、实施与修复；审查 Agent 独立检查前后端、测试与恢复风险。普通方案不强制模型审查，数据与外部效果触发一次综合审查，`planReview: "full"` 对每份方案执行一次综合审查。每次实际调用及失败仍计入同一需求的用量。

| 配置键 | 职责 |
| --- | --- |
| requirement | 产品沟通、图片理解、业务范围与验收对齐 |
| development | 项目理解、只读方案及讨论、获批后的实施与修复 |
| review | 前后端契约、回归、数据和恢复的综合审查 |

示例中的 provider/model 为占位值，请换成使用方已在 Pi 注册并验证可用的名称。开发各阶段使用同一个模型选择；需求与独立审查可配置不同模型。效果需以真实回归结果验证。

```json
{
  "provider": "your-default-provider",
  "model": "your-default-model",
  "agentModels": {
    "requirement": { "provider": "your-product-provider", "model": "your-product-model" },
    "development": { "provider": "your-coding-provider", "model": "your-coding-model" },
    "review": { "provider": "your-review-provider", "model": "your-review-model" }
  }
}
```

这是完整项目配置中的一个片段。每个覆盖项必须同时提供 provider/model，未知 Agent、空值和未知字段报错。额度耗尽与其他调用失败均明确停止，由管理员修改配置后继续，不自动切换模型。

## 配置交互

管理员在页面“模型设置”配置当前项目的默认模型，常用项仅显示 API 地址、API Key、模型名称、思考强度和输出 Token 上限。三个 Agent 未单独配置时继承默认；取消继承后才展开独立配置，以当前页面的默认值作为起点。支持 OpenAI 兼容服务；高级兼容设置保留模型能力、上下文窗口及以秒填写的请求超时，需求费用上限也折叠显示。已有采样参数、阶段预算和工具限制继续保留，不在模型页面逐项列出。模型、密钥、思考和模型用量限制变化不使已有需求、方案或审批失效，后续调用使用新设置，历史用量和记录保留。

API Key 在服务端使用 AES-256-GCM 加密保存，密钥文件和密文文件为0600，网页只获得“已配置”状态。密码输入留空保留同一服务的现有密钥，更换服务 origin 时需重新提供凭据。服务加密密钥与密文均需备份，部署时由服务账号独占访问；不把这两者一起公开或提交 Git。测试连接只发送一次最多256输出 Token的请求，不保存配置或启动任务，错误不回显供应商可能包含的凭据。模型凭据只注入 Pi 子进程白名单，不注入检查和部署进程。

CLI 也可以生成阿里云模型目录预设，无需修改 Pi 全局文件；以下历史命令名仍保留，预设不再包含备用模型，Agent 默认继承：

```sh
node src/cli.js model-pool-draft --project /path/to/project --config /path/to/current.json --preset bailian --key-env DASHSCOPE_API_KEY --output /path/to/candidate.json
```

`compatibleProviders` 每项包含 `name/baseUrl/apiKeyEnv/thinkingToggle/models`，每个模型明确 `id/input/contextWindow/maxTokens/reasoning`。HTTPS 地址不允许嵌入凭据；密钥变量必须同时在 `environment.pi` 白名单中。预设只支持文本，窗口和输出大小是保守执行上限，价格未知。

历史 `modelFallbacks` 字段允许旧配置被读取，但运行时不用于自动切换；网页保存会移除它。管理员修改默认或 Agent 配置后，新运行使用所选模型，实际模型与用量照常留痕。

遥测的 `modelAttempts` 保存每次响应的实际模型、用量及结果；旧版本的切换记录继续可查。管理统计价格未知时显示总成本未知，不将 Pi 的零价格当作免费。完整配置哈希用于设置并发校验和审计，执行规则哈希用于方案与审批绑定。后者保留源码范围、非模型环境授权、检查命令、隔离方式、规范、Git 与部署规则，排除模型连接、凭据及模型参数。新基线只绑定源码和执行规则，因此换模型不重生成方案、不撤销审批，也不重新调用初始化。源码或执行规则变化仍需重新核对。

CLI 先生成独立候选配置，再预览差异；不会直接修改现行项目配置，也不会覆盖已有候选文件。

```sh
node src/cli.js agent-model-draft --project /path/to/project --config /path/to/current.json --agent development --action set --provider your-provider --model your-model --output /path/to/candidate.json
node src/cli.js policy-preview --project /path/to/project --config /path/to/candidate.json
node src/cli.js agent-model-draft --project /path/to/project --config /path/to/candidate.json --agent development --action inherit --output /path/to/inherited.json
```

网页与 CLI 均支持三个 Agent 的“继承默认 / 独立指定”设置。网页可测试连接并保存当前项目模型，服务端验证 provider、model 与供应商能力；策略预览显示解析后的完整选择。

上传图片时，需求 Agent `requirement` 使用的实际模型必须在 Pi 中声明支持 image 输入。系统把原件作为多模态内容发送，不能解码或模型只支持文字时明确报错，不忽略图片继续宣布需求对齐。每轮有效图片输入及模型转换后的图片都有哈希证据。

## 审计、预算与门禁

项目 `thinking` 默认 `off`，各 `agentModels` 可独立指定 `thinking`；CLI 候选配置支持 `--thinking low` 等 Pi 等级。项目内 `compatibleProviders` 会注册 OpenAI 兼容服务，密钥仅从显式白名单环境变量读取。供应商支持 `enable_thinking` 时设 `thinkingToggle: true`；模型支持 `reasoning_effort` 时在该模型声明 `supportsReasoningEffort: true`，否则不会发送此参数。该能力必须与 `reasoning: true` 一起声明。项目配置不存凭据。

连接测试使用页面选择的思考开关与推理档位。阿里云 GLM 5.3 只接受思考模式，选择该模型时应开启思考（例如 `low`），不能配置 `off`。连接测试不会为了缩短输出而关闭必需的思考参数。

GLM 5.3 与 Qwen3.8 2.4T 在当前预设中开启思考，输出上限为 16384 token；Max 与 27B 关闭思考，输出上限为 8192。GLM 和 2.4T 均支持显式发送推理档位 `low`；2.4T 仅支持开启思考，不能发送 `enable_thinking=false`。必须声明 `supportsReasoningEffort=true`，否则界面的 low 不会传给供应商，2.4T 会使用默认的高思考预算。参数能力以[百炼官方 API 文档](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions/)为准。这些是本地执行限制，非供应商最大能力。只读阶段最终响应若因长度截断，会明确报告模型及实际输出用量，保留失败证据；不会补全残缺 JSON 或把它误报为业务预算耗尽。

`structuredOutput: true` 为初始化、需求分析、方案和评审开启结构化输出。`modelParameters.outputFormat=auto` 按已配置能力选择：支持时发送严格 JSON Schema，否则发送 JSON Object 并明确告知目标结构。`json_schema` 强制供应商约束，不支持即报错；`json_object` 显式选择 JSON 模式。任何提供业务 Schema 的结果都通过 Ajv 完整校验，语义、验收对应关系与源码证据继续由阶段校验检查；非法结果明确失败，不补全字段。JSON 模式不能宣称具备供应商约束解码。证据充分可直接返回，最后一次请求要求完整结果，工具能力保留。能力参见 [阿里云结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)。

`modelUsage` 支持以下显式预算，未知字段、非正整数均报错；策略预览显示生效值。

`maxEventBytes` 是审计片段的目标大小，遥测保存完整事件边界的字节偏移，原始日志持续流式落盘；单个完整事件可大于片段目标。设置 `maxAuditBytes` 才启用日志存储硬上限。检查与部署日志也使用明确的存储额度，超限保存现场并报错。源码快照、上传和沙箱仍保留独立资源保护。

| 字段 | 默认值 | 范围 |
| --- | ---: | --- |
| maxTokens | 60000 | 单次阶段运行的累计输入、输出及缓存 token |
| maxContextBytes | 64000 | 单次请求文本序列化字节，图片另由多模态门禁管理 |
| maxRequests | 8 | 单次阶段请求目标；strict 时为硬上限 |
| readOnlyMaxRequests | 6 | 产品分析、方案和评审的初始请求目标；strict 时为硬上限 |
| maxToolResultBytes | 8000 | 单次只读工具返回的文本字节 |
| initializationMaxTokens | 30000 | 初始化累计 token |
| initializationMaxRequests | 1 | 初始化模型请求次数 |
| initializationMaxToolCalls | 8 | 初始化工具上限，当前初始化不开放工具 |

初始化先生成完整静态基线，再提供有限入口源码片段生成 `PROJECT_REFERENCE.md` 与 `agent.md`；后续按需求读取源码。旧生成文档校验后复用结构化理解迁移，原项目规范文件保留。产品沟通只加载项目概述与规范文件索引，不携带规范全文或完整研发指南；需要核实业务行为时按需读取原文与相关代码。初始化结果按快照与策略哈希缓存，失败调用也保留用量。strict 在调用前检查剩余次数与 Token；adaptive 有新证据时超过目标继续，连续三轮无新工具证据时暂停。只读工具结果按字节分页或缩小范围。需求阶段默认 adaptive 将 token 作为复杂度估算目标；请求所需额度增加时记录扩展，超过估算继续执行。strict 才按剩余 token 限制输入和输出，实际报告在响应完成后计量，不能当作供应商绝对账单上限。初始化仍执行独立硬限额。费用上限 maxCostUsd=null 表示不设置。兼容模型设置 USD 上限前必须配置 cost 的 input/output/cacheRead/cacheWrite 四项单价（USD/百万 Token）；未知价格明确标记，不能按免费执行费用门禁。

所有阶段将 `maxPiMs` 作为每次供应商请求的完整响应时限，流式响应不重置时钟；Pi 启动和一次原生摘要操作也按此时限限制等待。没有需求或阶段累计时间上限，前面几轮查阅及历史失败不会挤占下一次请求的时间。检查、启动、本地发布分别使用 executionTimeouts.checksMs/startupMs/deploymentMs，默认 300000/120000/600000 ms，与模型超时独立。遥测 `timeouts` 记录单次请求时限；每轮、每个工具及全部历史耗时继续归档，只用于观察。没有完整响应计量的已发出请求计入 `unmeasuredRequests`，不能按零成本处理。

同一需求的成功源码读取保存为带内容哈希的独立 `source-<hash>.json`，后续阶段可复用原始源码片段。复用前验证工件哈希、真实路径、排除规则、整文件哈希和行号内容；工件被篡改报错，源码发生变化或移除则明确记录失效原因。源码正文按阶段和复杂度采用6/12/24/32 KB额度，缓存与预装正文共同计量，未装入的片段记录在遥测中。只复用源码事实，不传递历史产品沟通或前一个 Agent 的结论；评审仍独立判断。缓存片段不代表调研完整，因此不会自动把只读阶段压缩到两次请求；仍使用配置的只读预算，默认最多六次。遥测的 `requestLimit` 记录实际请求上限，`sourceEvidence` 记录捕获、复用、失效和未装入工件，实际提示词哈希包含这些输入。

成功读取的源码还保存在项目 `source-evidence/` 中。当前需求已有事实按正文额度装入，跨需求默认仅给索引，明确相关文件范围后才复用正文，不共享讨论或 Agent 结论。专项交接的验收、共享接口、数据与风险保持完整；长伪代码、图表及其他职责正文按当前草稿哈希用 `read_plan` 取回。遥测 `handoff` 保存角色、绑定哈希、延后章节及完整/交接正文大小，方便评估是否减少重复上下文。项目导航提供真实回归测试文件索引，减少凭文件名猜测试入口。

需求分析和方案核对使用专用结构化提示。编码保留 Pi 原生系统提示、项目上下文、源码工具和 bash；只追加简短的需求范围、审批、编辑和交付约束。交接包含完整冻结契约、批准设计、当前工作区实际变更及必要源码，不重放方案工具历史。

实施工具禁止整文件覆盖已有超过 50 行的文件；`edit` 每次旧、新文本分别最多 50 行，须按逻辑单元修改并保留上下文。此门禁不代替审批文件范围、快照和实际差异审核。

只读阶段提供有界读取 schema 和资源门禁。编码使用原生 Pi 的读取、搜索及错误修正协议，不追加8KB结果拒绝、请求数上限或两次纠错终止。输入仍须合法，文件工具仍须在权限范围内；原始工具错误、调用参数和用量保留审计。

编码的工具参数、成功差异及失败正文交给 Pi 原生会话，不改写成提交提示或占位参数。产品分析若输出代码、技术设计问题或无效结构，仍执行结构化纠正和 intakeValidation 审计，不能代答业务问题或跳过定版。

adaptive 下的序列化字节是目标，输入预留与请求输出必须容纳在配置的模型上下文窗口内才可扩展。相同模型、逐字相同的请求前缀使用供应商已计量输入加新增字节预留；因逐轮结构化输出指令等造成前缀变化时，使用整份请求的保守字节估算。遥测 `contextExpansions` 保存估算方式及窗口证据。无法确认窗口或估算超出窗口时仍停止。strict 始终保留字节硬门禁。字节大小不等于模型 token 数，扩展不能伪造精确 tokenizer 计量。

编码由 Pi 自行调查、编辑、检查及修正；控制器不注入强制收尾检查或自动修复循环。源码产出后独立运行开发确认的检查，记录命令、退出码、日志和工作区哈希，再进入差异审批与业务验收。检查进程只使用 environment.checks 白名单；模型文本和临时命令通过均不能代替正式验证。

Pi 可主动调用 run_checks 执行开发确认的检查，失败结果如实返回供修正，不附加纠错次数限制；最终仍独立验证。开发本系统使用真实原生 Pi 配合本地模拟模型接口覆盖工具执行、审计和回滚，模拟通过不能宣称真实供应商已完成业务需求。

严格 Schema 仍需结合供应商支持范围。当前百炼接口拒绝数组 `uniqueItems`；数组去重约束、验收 ID 一一对应、跨字段关系和事实证据继续由程序验证并反馈源模型纠正，不能自动去重或填充字段。多模态输入的 Schema 能力应独立核验，不能由文本能力推断。

本地隔离工作区中的实施失败或验证失败，可由原接单且批准方案的研发人员执行 `resume-implementation`，提交明确诊断及原获批范围内的文件清单。已验证但尚未测试部署的代码，也可通过明确的 `reviewedEdits` 提交审核修改；此时不启动模型。源码、策略、规范、工作区、方案、恢复快照与累计用量重新校验；旧差异及文件副本保留，旧变更审批失效，仍需完整验证和实际变更审批。后续验证使用独立日志文件，首轮失败日志不覆盖。strict token、调用或时间限额耗尽不能通过续执行恢复；adaptive 超出 token 估算不阻止继续交付。

编码请求数和token目标仅作观察，不触发“先写代码才扩展”的阶段门禁。原生 Pi 自行调查与修正，普通请求、工具调用和摘要都计入审计；单次响应时限、需求剩余时间、权限及最终检查仍有效。

责任人可在续执行时显式指定项目已配置的模型，CLI 参数 `--model-selection-file` 读取完整 `{provider,model,thinking}`。旧配置中的候选声明仍可用于显式选择。未经配置的模型、其他责任人、与确定性精确替换混用均拒绝。审批哈希及文件范围不变，审计保存选择，遥测 `selectionSource=owner` 显示实际执行模型；所有旧失败及累计用量保留。额度耗尽会停止，系统不自动选择其他模型。

如果责任人已经审核具体修改，可以提交 `reviewedEdits`（CLI 为 `--reviewed-edits-file`）。每个选择文件只能一条精确替换，原文必须在当前失败快照中唯一命中，新旧各不超过50行。全部先校验再在同一隔离工作区执行，记录原错误、责任人、替换及实际差异，进入 `implemented` 后重新验证。不消耗或恢复模型额度，也不算自动通过。仅限原负责人批准的本地代码修复；数据功能须已有独立恢复依据，未知或不可逆影响禁止续行。项目、策略、规范或快照变化仍拒绝。

实施按复杂度预装12/24/32 KB当前源码；与需求定位相关且哈希一致的缓存片段交接正文，其他片段保留索引。预装额度不限制后续原生读取。源码篡改、权限和审批仍校验，计划新文件明确记录。

实际 Pi 参数采用解析后的模型；成功和失败的遥测均保存 agent、provider、model、selectionSource、trace ID 和用量。各 Agent 共用单需求成本上限，切换模型不会重新获得预算。正式启用前，应在 Pi 配置中验证模型名、凭据及价格计量；项目 JSON 不存 API Key，环境白名单沿用项目的 `environment.pi`。

`admission.maxTotalTokens`、`maxModelCalls` 覆盖全部阶段及失败重试。只读阶段保留结构化预算门禁；编码阶段不以请求/token目标打断 Pi，实际用量继续累计，进入阶段前的承接策略与费用限制保持有效。累计耗时不限制执行，回退后重新规划和失败重试都获得完整的单次请求时限。

模型配置属于项目策略：方案审批后修改模型会使配置哈希不一致，门禁拒绝继续，需重新形成可审批的方案。按阶段选择模型不改变冻结契约、独立评审、人工方案审批、实际变更审核、测试验收或发布审批。

已初始化项目通过受控文件流程应用配置后，运行 `baseline-refresh` 更新项目基线，再对新需求执行评审；候选配置命令不会自动应用配置或刷新基线。

development 负责方案、讨论和编码；方案会话绑定版本，编码使用新的原生会话和当前批准交接，不重放旧编辑记录。review 覆盖需求影响与验证风险；详细设计、具名审批和最终交付证据保持完整。

代码实施由开发 Agent 独占写入，真实检查和恢复校验由控制器执行。initialize、intake、plan、implement、review 表示执行阶段；frontend、backend、qa 表示检查范围或人工职责，不是额外模型配置键。旧 Agent 配置键直接报错，不提供兼容或别名。
