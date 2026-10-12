# 自有系统接入

本项目的核心是需求状态、成员接单与权限、Pi 执行门禁、隔离工作区、验证、发布适配和可审计归档。`src/core.js` 是面向 Node.js 集成的授权入口；`src/cli.js` 是命令行适配器；`src/web-server.js` 与 `web/` 是可选示例。CLI 只在运行 `web` 命令时加载网页服务模块。替换页面不影响核心流程。

| 层 | 目录或入口 | 使用方可以替换的部分 |
| --- | --- | --- |
| 需求核心 | `src/core.js`、`src/actions.js`、`src/assignment.js`、`src/intake.js`、`src/workflow.js` | 通过授权入口调用状态动作，保留门禁与审计 |
| 项目适配 | `.reqflow/config.json`、`src/deploy.js` | 仓库模式、检查命令、Jenkins、GitLab、GitHub Actions、本地发布或公司扩展 |
| 代码规范 | `src/standards.js`、`codingStandards.globalRules` | 内置通用与语言预设、项目全局规则、按需求文件选择和版本哈希 |
| 全局项目基线 | `src/baseline.js`、`.reqflow/baseline.json` | 只读静态扫描、证据报告、显式刷新与源码漂移门禁 |
| 记忆检索 | `src/history.js`、`src/pi-guard.js` 的记忆工具 | 保留检索理由、项目边界、验收原文与哈希引用，可替换 MiniSearch 后端，不改变业务流程 |
| 用户交互 | `src/cli.js`、`src/web-server.js`、`web/` | 接入现有产品系统、工单系统或组织门户 |

发布扩展通过 `registerDeploymentAdapter` 注册 submit / 可选 poll 实现，无需修改需求状态机。项目选择适配器、参数和凭据环境变量名称，继续保留版本校验、超时、部署证据与人工验证。接口、启动方式和可运行示例见 [发布适配器接入](deployment-adapters.md)。

产品沟通通过 `analyze-intake`、`intake-message` 与 `confirm-contract` 接入。创建需求或补充消息可传 `images: [{ name, mimeType, data }]`，其中 `data` 是标准 Base64，支持静态 PNG/JPEG。补充消息为 `{ text, images?, candidate?, withdrawnImageIds? }`；图片撤回不删除原件。AI 返回需补充或待产品定版，调用方应展示 `getRequirementEvidence(...).discussion` 的最新分析与历史，再由产品确认同一份契约。确认请求须携带 `expectedAnalysisHash`，旧分析或已改动的候选会被拒绝。

网页图片接口为 `GET /api/tasks/:id/images/:imageId`，必须携带当前项目认证。其他适配器用 `getRequirementImage` 获取授权且校验过哈希的原件，不能把归档目录当成公开静态文件服务。定版后指定研发成员，接单后直接调用 `plan` 完成统一方案分析及按影响范围触发的专项检查；更换上游页面不改变服务端门禁。

产品交互仅讨论业务目标、当前和期望行为、业务规则、功能范围及验收结果。AI 内部读取项目，向产品翻译为业务影响，不要求产品决定文件、接口或数据结构。最终契约的 `inScope` 是业务功能，关键决定合并进最终字段，`answers` 为空；讨论与原文留在 `discussion` 供回看，不自动传给研发 Agent。技术定位由方案分析返回 `affectedFiles`，任何实施均受此获批清单限制。`getRequirementEvidence().planAnalysis` 提供影响、待执行场景、专项发现与阻断项，页面无需单独创建角色评审步骤。

需求分析在声明待定版前，使用最终输出的完整 JSON Schema 和当前准入策略校验；`admissionDefaults.maxAcceptance`（默认 8）仅为规划参考，不限制验收项数量。完整场景、边界和断言必须保留，不能为满足参考值合并或截断验收项。结构错误在模型结束前反馈修正，修正失败明确报错并保留原分析和候选。校验策略更新后须重新分析候选，再确认新的分析哈希；结构校验不代替产品对业务完整性的确认。

方案沟通通过授权动作 `discuss-plan` 接入，消息为 `{ text, expectedPlanHash }`，返回只读建议并在 `getRequirementEvidence().planDiscussion` 中留痕。直接编辑通过 `edit-plan`，传 `{ candidate, feedback, expectedPlanHash }`；candidate 为完整的结构化方案草稿，必须覆盖冻结验收，不能作为审批传入。新版本由 AI 核对并附 `candidateReview` 理由，仍等待研发确认。`approve-plan` 携带显示时的 `expectedPlanHash`，确认后自动实施、验证，停在人工确认交付的步骤；本地验证和测试发布可选，过期审批拒绝执行。分工指派和审核接口见 [研发设计与分工审核](development-design.md)。

管理员及已接受当前项目分工的研发通过 `GET/POST /api/project-execution` 配置测试发布；POST 要求当前会话、同源及 CSRF token，写入参数数组并留审计。输入包含 kind，选择 unconfigured / local / jenkins / gitlab / github；unconfigured 的 url 必须为空，可独立保存 checksText，固定测试环境不影响方案设计。远程平台使用 fields 与 timeoutMs，令牌由服务端私有文件保存，GET 不返回值。同权限的 `POST /api/deployment-connection` 只验证平台连接，不触发发布。字段与接入协议见 [内置发布工具](ci-platforms.md)。研发方案选择相关检查并说明跳过依据；无合适自动检查时明确等待人工验证。开发检查完成后返回 next=choose-validation，目录项目与 Git 项目均可人工确认归档，也可按需选择本地验证或显式发布；环境未配置不阻挡归档。

Git 信息通过 `GET /api/project-git` 读取。`approve-plan` 可传 developmentBranch={kind:new/existing,branch}；`local-validation`、`recheck-local` 和 `publish-test` 通过需求动作入口执行并限制为负责研发。提交确认必须携带 expectedPlanHash、expectedAfterHash、authorizeGit=true 和页面展示的 testMode；merge 模式还要传配置的 testBranch。保留的冲突候选通过任务 git-candidate GET 展示，再使用 expectedCandidateHash 确认。`redeploy-test` 另需 authorizeDeployment=true。项目设置可传 gitDelivery，详见 [Git 与研发交付](git-delivery.md)。

`local-validation` 要求 expectedPlanHash、expectedAfterHash，负责研发按已批准方案及选定启动目标启动服务，返回工作目录、Git 补丁、检查、validation、environment 和运行状态。operation 可为 start 或 stop；不接受手填 environment。启动前扫描并检查私有环境配置，缺条件返回 blocked 并保留代码；发现数据库初始化或启动回调时，须传 confirmStartupEffects=true 和当前 expectedEnvironmentRevision。服务可访问不代表业务验收通过。

本地配置通过 `GET /api/local-environment-scan` 扫描，`GET/POST /api/local-environment` 读取及保存，`POST /api/local-environment-check` 检查；管理员与已接受当前项目分工的研发可操作。普通查看者通过 `GET /api/environment-status` 查看状态和允许范围内的配置历史。扫描不执行项目，检查仅验证必需变量及受支持依赖的 TCP 端口，密码不返回页面；POST 沿用同源和 CSRF 校验。配置保存绑定扫描哈希及已有配置版本。

方案 `validation.startup` 的服务为 `{name, command, healthUrl, applicationUrl}`，两个地址均需回环 HTTP/HTTPS；无页面时 `applicationUrl=null`，不可省略。`local-validation` 的 `services` 保留这两个字段，`environment.applications` 返回选中服务的 `{name,url}` 页面入口列表，不能用健康地址或首个服务推导页面。旧单地址方案需重新生成审核，系统不改写旧审计证据。

`read_plan` 每次可请求 1–3000 字符，实际页面同时受模型工具结果字节预算限制；调用方按返回的 `text.length` 前进，直到 `totalChars`，不得假设每页等长。版本哈希和来源校验继续适用。

`accept-test` 必须传 evidence 和 acceptanceMode=manual/local/deployed。manual 在 verified 状态人工确认研发交付，不要求环境；local 要求当前代码及环境版本的实际本地验证；deployed 要求 test_deployed 状态和有效测试环境版本。manual/local 还须传当前 expectedPlanHash、expectedAfterHash；未经审核的实际变更先由负责研发具名确认。动作完成验收后直接归档，记录实际方式、人员与版本，不把未执行的环境验证算作通过。

首次 `init` 会生成带源码与配置指纹的项目基线；维护者可用 `baseline-status` 检查当前性，源码或配置变动后用 `baseline-refresh` 明确更新。`src/baseline.js` 的 `readProjectBaseline` 可供其他适配器读取，必须保留其哈希与当前性校验。基线的静态线索会进入角色评审和方案提示词，已开始的不同角色评审不能混用新旧基线。刷新命令是本地项目维护操作，权限由项目目录的文件权限控制；它不替代需求审批。

项目代码规范由 `resolveStandards(config, inScopeFiles)` 选取；网页或其他上游可用 `standardsCatalog()` 展示内置预设，使用 `validateConfig` 检查团队全局规则。CLI 的 `standards-preview` 和 `standards-show` 提供按文件的只读预览。规范哈希绑定角色评审、方案与实际变更；提示词遵循不等于静态扫描通过，机器检查必须接入 `checks`。

服务端先验证用户，再调用 `createRequirement`、`listRequirements`、`getRequirement`、`getRequirementEvidence`、`getChangedFile` 或 `executeRequirementAction`。读取证据时会校验归档哈希及可见范围。当前 `authenticate` 使用项目令牌；若接入 OIDC/SSO，应在服务端验证组织身份并安全映射到项目角色和成员，不能信任浏览器提交的 `id`、`roles` 或 `actor`。动作入口会再次检查该成员是否被分配到具体需求、是否接单以及需求所处状态。

```js
import { authenticate } from "../src/auth.js";
import { loadProject } from "../src/config.js";
import { createRequirement, executeRequirementAction, listRequirements } from "../src/core.js";

const project = await loadProject(projectPath);
const principal = await authenticate(project, projectToken);
const page = await listRequirements(projectPath, principal, 0, 50);
await createRequirement(projectPath, principal, { id: "REQ-101", title: "筛选优化", request: "..." });
await executeRequirementAction(projectPath, "REQ-101", { action: "analyze-intake" }, principal);
await executeRequirementAction(projectPath, "REQ-101", {
  action: "intake-message", message: { text: "补充目标和验收口径。" },
}, principal);
await executeRequirementAction(projectPath, "REQ-101", { action: "analyze-intake" }, principal);
// 用 getRequirementEvidence 展示 discussion.latestAnalysis.analysis.contract。
// 产品确认后调用 confirm-contract，传该契约及 expectedAnalysisHash = evidence.meta.intakeAnalysisHash。
// 此后再指定研发成员。
await executeRequirementAction(projectPath, "REQ-101", {
  action: "assign-member", role: "developer", member: "dev1",
}, principal);
```

成员分配以需求为单位。产品负责人可指定已注册的研发账号。分配处于 `pending` 时，成员可查看该需求并选择接单或拒绝；只有 `accepted` 的成员可以执行对应职责动作。`assign-team` 可在方案设计前调整协作方式与成员，变更留痕，新成员重新接单；方案生成后不能直接换人替代历史审核。需求归档后不能新增分配。管理员可读全项目，不自动获得其他人的产品确认、方案审批、实施或发布权限。

方案有阻断项或未知影响时 `approve-plan` 拒绝；研发调用 `revise-plan` 附带反馈重分析，涉及业务变化则在方案批准前由产品重新对齐需求，旧方案失效但保留历史。项目显式启用 `fastPath` 时，已接单研发可调用 `fast-track`：限定方案仍等待具名方案确认，批准后自动实施、验证，研发再选择验证环境，不增加固定差异审批。真实风险仍按承接判断和具体方案审核处理。部署提交结果不明时，用相应 `reconcile-*` 动作记录外部核查证据，系统不会重发请求。

管理员使用 `getAuditReport`、`getTaskHistory` 和 `getAuthenticationHistory` 读取分页报告。`getAuditReport` 的 `summary` 和 `usage` 验证整个项目后统计，筛选和分页只作用于需求列表；每页最多 100 条。负责人使用 `getRequirementLifecycle` 分页回看自己的完整关键流程，不限最近 100 条。`auditHead`、事件时间、操作者、证据路径和方案版本可用于外部审计索引。项目级不可篡改审计仍需使用方接入外部存储或签名锚点；本地哈希链只能发现普通文件篡改。口径和展示分层见 [审计与管理报表](audit-management.md)。

```js
import { getAuditReport, getTaskHistory } from "../src/core.js";

const report = await getAuditReport(projectPath, adminPrincipal, 0, 50);
const history = await getTaskHistory(projectPath, adminPrincipal, "REQ-101", 0, 100);
```

网页示例 API 同样只调用核心动作入口。`GET /api/overview` 按当前用户可见范围分页；`GET /api/tasks/:id/lifecycle` 允许需求创建人、指定研发和管理员回看；`GET /api/admin/report`、`/api/admin/tasks/:id/history`、`/api/admin/tasks/:id/observability` 和 `/api/admin/auth-history` 仅管理员可读。产品和研发前端可以完全替换，但不要跳过 `executeRequirementAction`，也不要直接修改 `.reqflow/` 中的状态或事件文件。
# 项目根目录导入

管理员可向 `POST /api/projects` 提交 `{ "name": "Form editor", "rootDir": "/absolute/path/form-edit" }`，选择整个既有项目。不能同时提交 `rootDir` 与 `frontendDir`/`backendDir`。前后端识别结果只用于项目说明，不会将根目录重新放进 `frontend` 或 `backend`。Git 模式保留完整仓库，普通目录保持原相对路径；工作台账号和模型设置继续继承。

`POST /api/projects/analyze` 支持 `rootDir`（也兼容原 `directory` 字段）。例如 Vue 前端和 Maven 后端可同时返回 `frontendDir: "frontend"`、`backendDir: "backend"`。导入默认仅识别已有 npm 测试/部署入口，不执行脚本；Maven 测试命令和发布流水线由管理员配置，缺少时明确标为待配置。原仓库未提交修改仍需由使用者处理，导入不会自动提交或丢弃。
