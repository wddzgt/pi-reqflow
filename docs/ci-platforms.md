# pi-reqflow 测试环境发布

管理员在“项目设置”选择 Jenkins、GitLab CI/CD 或 GitHub Actions，填写连接信息、已有发布入口及人工验证地址。点击“验证连接”只读取平台信息，不构建、不发布。保存后所有需求复用配置，令牌不回显；同一平台留空保留原令牌，填入新值即更新。

| 平台 | 页面填写 |
| --- | --- |
| Jenkins | 地址、流水线名称（文件夹用 / 分隔）、用户名、API Token、测试地址 |
| GitLab CI/CD | GitLab 地址、项目数字 ID、项目访问令牌、测试地址 |
| GitHub Actions | 组织/用户名、仓库名、发布工作流文件、访问令牌、测试地址；API 地址默认 github.com |

测试命令与环境变量授权在“测试与高级设置”。已有项目使用部署脚本时也可选择“项目已有部署脚本”，不会强迫接入 CI。扩展发布仍通过开发人员的 [适配器接口](deployment-adapters.md) 接入。

## 一次性项目准备

这三类远程平台从 Git 获取源码，项目需要真实远端和分支。导入已有 Git 目录会保留仓库历史并创建隔离副本；普通目录仍是 local 模式。研发审核方案时选择需求分支，开发测试完成后可先本地验证，再明确确认提交、推送和测试发布；管理员可配置直接部署需求分支或合并到指定测试分支后部署。旧的人工推送及 record-published 核验接口继续兼容。完整交互与边界见 [Git 与研发交付](git-delivery.md)。

第一次接入由研发/运维调整已有发布流水线，让它能接收版本参数，构建并部署到测试环境。选中的入口应真正执行测试环境发布；普通构建任务、手工待批准或跳过发布的流水线不能作为自动交付入口。流程仍是产品定版、研发确认方案、Pi 开发测试、测试环境发布、人工验收；生产发布必须另行批准。

仓库提供三个一次性接入示例：[Jenkinsfile](../examples/deployment/Jenkinsfile)、[GitLab 作业](../examples/deployment/gitlab-ci.pi-reqflow.yml)、[GitHub 工作流](../examples/deployment/github-deploy-test.yml)。它们核对精确版本后调用 `scripts/deploy-test.sh`；请接入公司的实际构建、发布和健康检查脚本，失败必须返回非零退出码。示例不会替公司生成服务器、容器平台或发布凭据，部署依赖和凭据仍配置在原发布平台。

“验证连接”只证明能读取作业、项目或工作流，不能证明具有发布权限或已有可用 Runner。首次接入应执行一次测试发布；通过后业务用户只需要复用配置。pi-reqflow 不会把一次只读检查标记成真实发布验证。

## Jenkins

使用用户名与 API Token，访问具备构建权限的参数化流水线。声明字符串参数 REQ_ID、BRANCH、REVISION、PLAN_SHA256、CONTRACT_SHA256、DEPLOY_ENV。流水线按 REVISION 获取精确源码，验证实际 checkout 的提交等于 REVISION，发布成功才返回构建成功。测试 DEPLOY_ENV 为 test，生产为 production。

pi-reqflow 通过 buildWithParameters 提交，保存返回的排队地址，查询该次构建，核对构建记录中的 REVISION。嵌套文件夹与中文作业名由页面转换为 API 路径。平台作业需已存在且可构建；连接验证不会创建或修改 Jenkins 作业。参见 [Jenkins 官方 API](https://www.jenkins.io/doc/book/using/remote-access-api/)。

## GitLab CI/CD

使用可创建、读取该项目流水线的项目访问令牌（API 权限），不使用仅能触发但无法查询结果的 trigger token。通过项目流水线 API 在已验证分支创建一次 pipeline，传递 REQ_ID、REVISION、PLAN_SHA256、CONTRACT_SHA256、DEPLOY_ENV 五个变量。

项目必须允许令牌所属角色传入 pipeline variables；若 minimum role 为 `no_one_allowed`，本接入会被 GitLab 拒绝。通常由项目管理员按公司权限规则配置，并使用满足该最低角色的令牌。已有 `workflow:rules` 必须允许 `CI_PIPELINE_SOURCE == "api"`，发布作业须有可用 Runner，且不能依赖人工启动。参见 [GitLab 变量权限](https://docs.gitlab.com/ci/variables/#restrict-pipeline-variables)。

现有 .gitlab-ci.yml 应根据 DEPLOY_ENV 选择实际发布作业，并核对 CI_COMMIT_SHA 与 REVISION。系统同时核对创建与查询响应的 sha，查询固定 pipeline ID。流水线失败、取消、跳过或仅等待手工执行不会显示为部署成功。参见 [GitLab 官方流水线 API](https://docs.gitlab.com/api/pipelines/)。

## GitHub Actions

使用具有目标仓库 Actions 读写权限的访问令牌。发布工作流需启用 workflow_dispatch，声明输入 req_id、revision、plan_sha256、contract_sha256、deploy_env；这些输入名称是固定接入协议。工作流按 revision 获取源码并核对实际提交，完成测试环境发布后才能成功结束。

工作流文件必须存在于默认分支，并在所选开发分支存在。示例使用当前版本 `actions/checkout@v7` 和公司 `self-hosted` Runner；该 Runner 需要保持更新并具备真实测试环境的发布能力。若平台 Environment 设置了 required reviewers，发布会等待人工批准；无人值守的测试环境应按公司规则使用允许自动发布的 Environment。生产环境的审批策略不受本测试示例影响。

使用 REST API 版本 2026-03-10，提交响应须返回 workflow_run_id；之后只查询该次运行，核对 head_sha、head_branch 和完成结论。仅返回 204、无法提供唯一运行编号的旧接口会进入结果待核实，不能靠“最近一次运行”猜测或重复提交；旧 GitHub Enterprise 需升级或使用自有扩展适配器。参见 [GitHub 官方 workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。

## 凭据、证据与异常

页面令牌通过同源管理员会话传给服务端，保存为项目 .reqflow/deployment-credentials 下的 0600 文件，配置只保存引用；目录为 0700。令牌不进入配置审计、AI 提示词或发布日志，并禁止透传给 Pi、测试与本地脚本。当前保护依赖部署主机文件权限，没有引入独立密钥管理服务；使用方可替换凭据存储接入自己的密钥系统。

开发人员仍可在 JSON 中使用 userEnv/tokenEnv（Jenkins）或 options.tokenEnv 与 credentialsEnv（GitLab/GitHub）从主机环境读取凭据，网页无需填写变量名。

提交超时或响应无法确认时进入结果待核实，不重复提交。查询错误保留运行中的任务，可再次查询原编号。成功后检查测试地址连通性；平台成功与 HTTP 连通性都不能替代业务验收。人工核实采用现有 reconcile 操作。文件 rollback 不会回滚外部环境，需要平台自身的回滚能力。

除三种官方接口的本地契约测试外，三个适配器均已走研发批准、Pi 开发测试、提交推送、远端取码、发布可访问页面的完整本地测试。CI 平台在这三条自动测试中是模拟接口，取码、运行新功能、发布和访问页面是真实执行。

这些测试不替代使用方实际平台的权限、Runner 和发布验证。首次接入应使用专用测试仓库完成真实发布，核对流水线取码版本、部署结果与验收地址。
