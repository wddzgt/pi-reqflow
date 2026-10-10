# 按 Agent 配置模型

项目的 `provider`、`model` 是显式默认模型；可用 `agentModels` 为每个实际调用的 Agent 指定完整模型组合。未单独配置的 Agent 使用项目默认模型，策略预览显示每个 Agent 的最终选择及来源。

| 配置键 | 职责 |
| --- | --- |
| initialize | 项目初始化理解 |
| intake | 产品多轮沟通、图片理解与候选需求核对 |
| plan | 只读调研与方案设计 |
| implement | 按已审批方案实施代码 |
| frontendReview | 前端需求评审 |
| backendReview | 后端需求评审 |
| qaReview | 测试需求评审 |

示例中的 provider/model 为占位值，请换成使用方已在 Pi 注册并验证可用的名称。可为评审和设计使用较强模型，为限定范围的实现使用成本较低模型；效果需以真实回归结果验证，不能仅凭参数规模判断。

```json
{
  "provider": "your-default-provider",
  "model": "your-default-model",
  "agentModels": {
    "plan": { "provider": "your-design-provider", "model": "your-design-model" },
    "implement": { "provider": "your-coding-provider", "model": "your-coding-model" },
    "frontendReview": { "provider": "your-review-provider", "model": "your-frontend-review-model" },
    "backendReview": { "provider": "your-review-provider", "model": "your-backend-review-model" },
    "qaReview": { "provider": "your-test-provider", "model": "your-test-review-model" }
  }
}
```

这是完整项目配置中的一个片段。每个覆盖项必须同时提供 provider/model，未知 Agent、空值和未知字段报错。额度耗尽与其他调用失败均明确停止，由管理员修改配置后继续，不自动切换模型。

## 配置交互

管理员在页面“模型设置”配置当前项目的默认模型，七个 Agent 可独立覆盖或恢复继承。常用连接信息直接展示，采样、思考、模型能力、上下文、输出、请求、工具、费用与运行时间限制按需展开。支持 OpenAI 兼容服务。模型、密钥、思考、采样和模型用量限制变化不使已有需求、方案或审批失效，后续调用使用新设置，历史用量和记录保留。

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
node src/cli.js agent-model-draft --project /path/to/project --config /path/to/current.json --agent plan --action set --provider your-provider --model your-model --output /path/to/candidate.json
node src/cli.js policy-preview --project /path/to/project --config /path/to/candidate.json
node src/cli.js agent-model-draft --project /path/to/project --config /path/to/candidate.json --agent plan --action inherit --output /path/to/inherited.json
```

页面适配器宜显示上述七行，每行提供“项目默认 / 独立指定”、provider 和 model；下方显示解析后的完整选择。模型目录可由使用方接入 Pi 或自己的模型管理服务，不能让前端生成未经验证的默认名称。当前实现提供 CLI 和核心配置能力，没有新增在线修改配置接口。

上传图片时，`intake` 的实际模型必须在 Pi 中声明支持 image 输入。系统把原件作为多模态内容发送，不能解码或模型只支持文字时明确报错，不忽略图片继续宣布需求对齐。每轮有效图片输入及模型转换后的图片都有哈希证据。

## 审计、预算与门禁

项目 `thinking` 默认 `off`，各 `agentModels` 可独立指定 `thinking`；CLI 候选配置支持 `--thinking low` 等 Pi 等级。项目内 `compatibleProviders` 会注册 OpenAI 兼容服务，密钥仅从显式白名单环境变量读取。供应商支持 `enable_thinking` 时设 `thinkingToggle: true`；模型支持 `reasoning_effort` 时在该模型声明 `supportsReasoningEffort: true`，否则不会发送此参数。该能力必须与 `reasoning: true` 一起声明。项目配置不存凭据。

连接测试使用页面选择的思考开关与推理档位。阿里云 GLM 5.3 只接受思考模式，选择该模型时应开启思考（例如 `low`），不能配置 `off`。连接测试不会为了缩短输出而关闭必需的思考参数。

GLM 5.3 与 Qwen3.8 2.4T 在当前预设中开启思考，输出上限为 16384 token；Max 与 27B 关闭思考，输出上限为 8192。GLM 显式使用最低推理档位 `low`，2.4T 通过 `enable_thinking` 开启思考。这些是本地执行限制，非供应商最大能力。只读阶段最终响应若因长度截断，会明确报告模型及实际输出用量，保留失败证据；不会补全残缺 JSON 或把它误报为业务预算耗尽。

`structuredOutput: true` 为初始化、需求分析、方案和评审开启结构化输出。`modelParameters.outputFormat=auto` 按已配置能力选择：支持时发送严格 JSON Schema，否则发送 JSON Object 并明确告知目标结构。`json_schema` 强制供应商约束，不支持即报错；`json_object` 显式选择 JSON 模式。任何提供业务 Schema 的结果都通过 Ajv 完整校验，语义、验收对应关系与源码证据继续由阶段校验检查；非法结果明确失败，不补全字段。JSON 模式不能宣称具备供应商约束解码。证据充分可直接返回，最后一次请求要求完整结果，工具能力保留。能力参见 [阿里云结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)。

`modelUsage` 支持以下显式预算，未知字段、非正整数均报错；策略预览显示生效值。

| 字段 | 默认值 | 范围 |
| --- | ---: | --- |
| maxTokens | 60000 | 单次阶段运行的累计输入、输出及缓存 token |
| maxContextBytes | 64000 | 单次请求文本序列化字节，图片另由多模态门禁管理 |
| maxRequests | 8 | 单次阶段运行的模型请求次数 |
| readOnlyMaxRequests | 2 | 产品分析、方案和评审的请求上限，且不超过 maxRequests |
| maxToolResultBytes | 8000 | 单次只读工具返回的文本字节 |
| initializationMaxTokens | 30000 | 初始化累计 token |
| initializationMaxRequests | 1 | 初始化模型请求次数 |
| initializationMaxToolCalls | 8 | 初始化工具上限，当前初始化不开放工具 |

初始化先生成完整静态基线，再提供有限入口源码片段生成导航指南；后续按需求读取源码。产品沟通只加载项目概述与规范文件索引，不携带 CLAUDE.md、AGENTS.md 等规范全文或完整研发指南；需要核实业务行为时按需读取原文与相关代码。初始化结果按快照与策略哈希缓存，失败调用也保留用量。请求次数、上下文和工具结果在下一次模型请求前拦截。需求阶段默认 adaptive 将 token 作为复杂度估算目标；请求所需额度增加时记录扩展，超过估算继续执行。strict 才按剩余 token 限制输入和输出，实际报告在响应完成后计量，不能当作供应商绝对账单上限。初始化仍执行独立硬限额。自定义模型价格未配置时 Pi 的 USD 记录不足以证明实际费用；应结合供应商账单核对。

同一需求的成功源码读取保存为带内容哈希的独立 `source-<hash>.json`，后续阶段可复用原始源码片段。复用前验证工件哈希、真实路径、排除规则、整文件哈希和行号内容；工件被篡改报错，源码发生变化或移除则明确记录失效原因。源码正文按阶段和复杂度采用6/12/24/32 KB额度，缓存与预装正文共同计量，未装入的片段记录在遥测中。只复用源码事实，不传递历史产品沟通或前一个 Agent 的结论；评审仍独立判断。缓存片段不代表调研完整，因此不会自动把只读阶段压缩到两次请求；仍使用配置的只读预算，默认最多六次。遥测的 `requestLimit` 记录实际请求上限，`sourceEvidence` 记录捕获、复用、失效和未装入工件，实际提示词哈希包含这些输入。

成功读取的源码还保存在项目 `source-evidence/` 中，供其他需求按同样的哈希与范围校验复用；不共享讨论或 Agent 结论。项目导航提供真实回归测试文件索引，减少凭文件名猜测试入口。

各阶段使用专用系统提示词，不再附带 Pi 通用文档导航和重复工具说明；工具 schema、项目规范及审批约束仍完整保留。实施上下文中的测试索引仅保留获批测试文件，源码缓存加载本次批准文件及明确引用的只读依赖；完整项目导航仍用于需求与方案分析。

实施工具禁止整文件覆盖已有超过 50 行的文件；`edit` 每次旧、新文本分别最多 50 行，须按逻辑单元修改并保留上下文。此门禁不代替审批文件范围、快照和实际差异审核。

读取工具的范围同时写入模型工具 schema：read 默认 80 行，搜索默认 30 个结果，可显式给出其他正整数；实际内容超过字节预算会报错，不静默截短。实施全程保留调查相关依赖、调用方和测试的能力，只有具名局部修复可显式关闭研究。所有阶段的读取结果超限允许模型缩小真实参数范围后重试；实施中的编辑原文匹配、单块行数、无实际变化及 grep 路径不存在错误也可纠正，同一调用合计最多两次。字节上限、权限和累计用量保持不变，原错误不删除。越权、明确关闭的工具和未知错误仍停止；已有字段、类型及测试数据必须依据源码或改动前输出。

成功编辑的会话历史完整保留 `oldText`、`newText`、文件名和调用 ID，不把必填工具参数替换成占位符。仅超过512字节的成功结果正文压缩为提交提示；短结果及失败调用保留原文。原始工具参数和差异始终保存在完整审计日志，压缩不修改归档工件。产品分析若输出代码、技术设计问题或无效结构，adaptive 在原会话最多纠正两次，受已有请求门禁限制，遥测 `intakeValidation` 保留每次拒绝与结果；不能自动填补业务答案或跳过产品定版。

adaptive 下的序列化字节是目标，输入预留与请求输出必须容纳在配置的模型上下文窗口内才可扩展。相同模型、逐字相同的请求前缀使用供应商已计量输入加新增字节预留；因逐轮结构化输出指令等造成前缀变化时，使用整份请求的保守字节估算。遥测 `contextExpansions` 保存估算方式及窗口证据。无法确认窗口或估算超出窗口时仍停止。strict 始终保留字节硬门禁。字节大小不等于模型 token 数，扩展不能伪造精确 tokenizer 计量。

编码收尾后，守卫自动执行已配置的项目检查并记录每次命令、退出码、日志哈希和工作区哈希。失败反馈留在同一 Pi 会话，adaptive 按复杂度允许两至四轮同范围局部修复，共用累计用量与时间。无源码进展、达到修复次数或检查改写项目文件即停止。检查进程仅使用 `environment.checks` 白名单，不继承模型密钥。内部通过不豁免独立正式验证、差异审批和验收，内部失败也不会被报表统计成首次通过。方案 schema 错误在同会话最多纠正两次，受物理请求及累计调用上限限制。

Pi 可在编码过程中主动调用 `run_checks`。若最后一次主动检查通过，且收尾时的工作区哈希完全相同，守卫复用其命令结果与日志，记录 `reusedDevelopmentCheck`，不重复执行同一轮检查。通过后又改源码则重新执行；正式交付验证仍单独运行。开发本系统时优先使用模拟服务和针对性测试，真实模型只用于必要的能力探针与交付抽样，不因文档或已覆盖的小改动重复跑全量真实项目回归。

严格 Schema 仍需结合供应商支持范围。当前百炼接口拒绝数组 `uniqueItems`；数组去重约束、验收 ID 一一对应、跨字段关系和事实证据继续由程序验证并反馈源模型纠正，不能自动去重或填充字段。多模态输入的 Schema 能力应独立核验，不能由文本能力推断。

本地隔离工作区中的实施失败或验证失败，可由原接单且批准方案的研发人员执行 `resume-implementation`，提交明确诊断及原获批范围内的文件清单。已验证但尚未测试部署的代码，也可通过明确的 `reviewedEdits` 提交审核修改；此时不启动模型。源码、策略、规范、工作区、方案、恢复快照与累计用量重新校验；旧差异及文件副本保留，旧变更审批失效，仍需完整验证和实际变更审批。后续验证使用独立日志文件，首轮失败日志不覆盖。strict token、调用或时间限额耗尽不能通过续执行恢复；adaptive 超出 token 估算不阻止继续交付。

adaptive 实施的调用次数也是目标值。达到目标时，仅已成功编辑文件且文件内容指纹相较上次扩展有变化，才允许增加一份原阶段调用额度，并记录 `reqflow_request_budget_expanded`。纯查阅、重复无变化及只读阶段不因此扩展；时间、工具次数和修复轮数仍有硬限制。提示模型集中查阅缺失证据，但不在第一轮查阅后强制关闭工具；包含部分源码摘录的续执行也允许补充核对。完整文件已经注入时可以关闭重复查阅。这样避免“已产生可验证代码，却只因固定调用次数无法收尾”。

责任人可在续执行时显式指定项目已配置的模型，CLI 参数 `--model-selection-file` 读取完整 `{provider,model,thinking}`。旧配置中的候选声明仍可用于显式选择。未经配置的模型、其他责任人、与确定性精确替换混用均拒绝。审批哈希及文件范围不变，审计保存选择，遥测 `selectionSource=owner` 显示实际执行模型；所有旧失败及累计用量保留。额度耗尽会停止，系统不自动选择其他模型。

如果责任人已经审核具体修改，可以提交 `reviewedEdits`（CLI 为 `--reviewed-edits-file`）。每个选择文件只能一条精确替换，原文必须在当前失败快照中唯一命中，新旧各不超过50行。全部先校验再在同一隔离工作区执行，记录原错误、责任人、替换及实际差异，进入 `implemented` 后重新验证。不消耗或恢复模型额度，也不算自动通过。仅限原负责人批准的本地代码修复；数据功能须已有独立恢复依据，未知或不可逆影响禁止续行。项目、策略、规范或快照变化仍拒绝。

实施预装源码按复杂度提供12/24/32 KB正文，独立请求上下文门禁仍有效。`sourceEvidence.completeFiles` 记录完整文件、哈希与字节数；大文件按真实符号和显式引用行号定位局部正文，测试包含追加位置。责任人显式引用的只读依赖可一并提供，写权限仍是原批准清单。已提供全文不重复装入缓存，计划新建的批准文件记入 `pendingCreation`。

实际 Pi 参数采用解析后的模型；成功和失败的遥测均保存 agent、provider、model、selectionSource、trace ID 和用量。各 Agent 共用单需求成本上限，切换模型不会重新获得预算。正式启用前，应在 Pi 配置中验证模型名、凭据及价格计量；项目 JSON 不存 API Key，环境白名单沿用项目的 `environment.pi`。

`admission.maxTotalTokens`、`maxModelCalls`、`maxModelMs` 的累计统计覆盖产品沟通、评审、方案和实施，失败调用同样计入。adaptive 将 token 和响应次数作为目标，strict 作为累计硬限额；累计时间和单次阶段请求门禁始终生效。未知用量阻止继续调用。重复请求已完成沟通版本复用已校验结果，项目初始化独立计量。

模型配置属于项目策略：方案审批后修改模型会使配置哈希不一致，门禁拒绝继续，需重新形成可审批的方案。按阶段选择模型不改变冻结契约、独立评审、人工方案审批、实际变更审核、测试验收或发布审批。

已初始化项目通过受控文件流程应用配置后，运行 `baseline-refresh` 更新项目基线，再对新需求执行评审；候选配置命令不会自动应用配置或刷新基线。

`plan` 是统一研发方案分析入口。简单需求一次分析；跨前后端追加前端与后端专项检查；已知历史行为、接口、数据或外部风险追加一次 QA，不再为单模块重复调用本领域研发 Agent。未知影响先补充证据并阻止批准。专项检查仍使用 `frontendReview`、`backendReview`、`qaReview` 的模型选择，检查同一版需求与方案中的具体问题，不重复生成方案或比较措辞。审核文档由系统根据结构化方案生成，不重复传给评审和实施模型。成本按实际调用记录，汇总方案不重复计费。

代码实施仍由一个 `implement` Agent 完成；本配置没有引入多个并发代码写入者，也没有为人工审核人配置 AI 模型。未来拆分实施 Agent 时须先实现工作区冲突管理和统一验证，再扩展配置键。
