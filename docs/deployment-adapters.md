# 发布适配器接入

常规流程仍是研发确认方案后自动开发、测试并发布到测试环境，最后人工验证。管理员在服务启动时注册公司自己的发布实现，项目配置选择它；产品和研发不需要增加操作步骤。已有 local 和 Jenkins 继续可用。生产发布仍须单独批准，不因新增适配器而自动开启。

接入点为 `src/core.js` 导出的 `registerDeploymentAdapter(kind, adapter)`。这是一个进程内接口，无插件服务、消息队列或额外依赖。参考实现见 [公司发布网关示例](../examples/deployment/company-ci.mjs)。示例约定一个 HTTP 网关协议，使用方需实现这个网关或替换其中的 API 调用；它并未直接支持 GitLab、Argo CD 等具体平台。

## 最小接口

```js
import { registerDeploymentAdapter } from "pi-reqflow";

registerDeploymentAdapter("your-ci", {
  version: "1",
  requiresPublishedRevision: true,
  validateOptions(options) { /* 同步校验，非法输入抛错，成功不返回值 */ },
  async submit(context) { /* 调用真实发布系统，返回下述回执 */ },
  async poll(context, previousReceipt) { /* 可选：查询同一个发布任务 */ },
});
```

`kind` 为 2–41 位小写字母、数字或连字符，以字母开头。内置名称保留，同一进程不能重复注册或覆盖。`version` 必须与项目的 `adapterVersion` 相同；改变协议或发布行为时应更新版本，已有任务的配置指纹检查会要求重新确认。

`requiresPublishedRevision: true` 表示平台从 Git 获取已推送代码，必须使用 git 模式并记录真实推送版本；false 表示实现直接使用已验证的隔离工作区。它不是权限开关，也不会自动提交或推送。

| context 字段 | 含义 |
| --- | --- |
| request.taskId / environment | 需求编号；test 或 production |
| request.workspace / sourceHash | 已验证工作区绝对路径与源码快照指纹 |
| request.revision / branch | 要发布的版本；Git 提交或源码指纹；无分支时为 null |
| request.planHash / contractHash | 确认过的方案与业务需求指纹 |
| request.operationKey | 同一需求、环境、源码与配置的稳定幂等键 |
| options | 适配器自己校验的项目参数副本 |
| credentials | credentialsEnv 中声明的服务端环境变量值 |
| signal | 超时取消信号，必须传给网络请求或 SDK |

submit 与 poll 返回 `{ status, operationId, revision, evidence, url? }`，不附加其他字段。status 只能是 running、succeeded 或 failed；operationId 是非空平台任务编号；revision 必须与本次目标版本完全相同；evidence 是非空、最多 4000 字符的真实执行说明；url 可返回动态测试地址，必须为不含用户名密码的 HTTP(S) 地址。running 必须实现 poll，查询时 operationId 不得改变。

失败也应带上平台任务编号与目标版本。平台无法确认请求是否已接收时应抛错，不能返回虚构的成功或失败。平台仅“已受理”时返回 running；成功须确认平台确实发布了该版本，不能只把请求里的 revision 原样填回作为发布证据。

## 配置与启动

将示例或自己的注册模块放到部署主机上，调整 import 到实际核心入口。先注册，再初始化、加载项目或启动服务；每个 CLI/Web 进程都需要加载同一模块，例如在仓库目录执行：

```sh
node --import ./examples/deployment/company-ci.mjs ./src/cli.js web \
  --project /path/to/project --port 4173
```

项目执行配置中的 testDeployment 可写为：

```json
{
  "kind": "company-ci",
  "adapterVersion": "1",
  "options": { "baseUrl": "https://deploy.company.example/", "project": "legacy-app" },
  "credentialsEnv": ["COMPANY_DEPLOY_TOKEN"],
  "timeoutMs": 60000
}
```

示例要求 git 模式。其他项目字段与 checks 保持实际配置，可选 url 指定固定验证地址；回执给出的动态 url 优先。credentialsEnv 是必填数组，无凭据也要明确写 `[]`。密钥由部署主机环境或密钥管理系统注入，不写进 options、业务对话或回执。核心不把这些值放入审计请求，也禁止它们出现在 Pi、检查及本地命令的环境变量白名单中。

启动模块属于使用方受信任的服务端代码，与服务具有相同权限；这里不提供代码沙箱。不要从需求内容动态导入模块。实现应使用平台官方 SDK 或已有发布接口，并遵守 signal；核心超时停止等待不等于远端发布已经取消。适配器不得在 evidence、url 或异常中泄露密钥。

## 状态与回溯

同步成功直接进入人工验证，异步任务沿用查询流程。核心记录提交前事件、平台编号、版本、适配器版本、状态、证据与访问地址；测试环境成功后检查 HTTP 可访问性，连通性不替代业务验收或版本证明。提交和查询均核对工作区指纹，不能借发布修改已验证代码。

提交超时、异常或非法回执进入“结果待核实”，不能重新提交；先在平台核对，再用现有 reconcile-test-deploy / reconcile-release 记录真实结果。查询错误保留已提交任务，可再次查询同一编号。平台应使用 operationKey 做幂等处理；更换版本或配置后不能继续沿用旧回执。

人工核实成功时的 observedRevision 与适配器的 revision 口径相同：从 Git 发布填已推送提交；直接发布工作区填测试 afterHash 或生产 candidateHash。核实期间也必须保留原执行配置，不能更换适配器再确认旧发布结果。

项目设置支持 local、Jenkins、GitLab CI/CD、GitHub Actions，见 [内置发布接入](ci-platforms.md)。表单不覆盖自定义适配器；公司扩展由开发人员通过注册模块及执行配置维护。修改执行配置会改变任务指纹，应在新需求开始前完成。发布环境的回滚 API 尚未统一；已有 rollback 只恢复需求工作区文件，不能当成远端部署回滚。需要远端回滚时使用方应通过自己的平台接口并记录真实证据，不返回伪造回执。

该接口也可作为 productionDeployment 的实现，但仍需原有候选验证与人工发布批准。新增适配器不会自动解锁生产操作。
