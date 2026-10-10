# 开源发布

项目名、CLI 主命令和 npm 包名为 `pi-reqflow`，许可证为 MIT。当前版本 0.1.0 为 Preview。

## 公开文件范围

| 保留 | 原因 |
| --- | --- |
| `src/`、`web/`、`test/` | 运行源码、参考工作台与可复现回归测试 |
| `package.json`、`package-lock.json` | 包入口和锁定依赖；Docker 构建也需要锁文件 |
| `Dockerfile`、`compose.yaml`、`compose.project.yaml`、`docker/` | 内置演示项目启动、可选 CLI 部署与健康检查；环境示例只填占位路径 |
| `examples/config.*.json`、`examples/review/`、`examples/demo-app/src/`、`test/` 和 `package.json` | 可移植配置、接口字段示例和可独立运行的演示项目 |
| `examples/deployment/` 中的流水线与适配器 | 接入既有发布系统的示例 |
| README、LICENSE、CONTRIBUTING、`.github/workflows/` | 使用入口、许可证、参与方式与持续验证/镜像发布 |
| `.gitignore` 允许列表中的 `docs/` 文件与 `docs/screenshots/*.png` | 安装、配置、接口说明与独立演示工作台截图 |

## 留在本地的内容

`.gitignore` 排除以下内容，原文件保留在磁盘

- `.reqflow`、`.reqflow-init`、`.reqflow-workspaces`、`work/`，包括账号、需求原文、模型日志、代码快照和审计。
- `.env*`、`.docker.env`、`.npmrc`、私钥与证书、`secrets/`、`credentials/`，以及本机 Agent 配置目录。
- 根目录 `config.demo.json` 与本地配置，含个人路径或真实环境信息。
- 本地验证报告、审计记录、调研对比与开发过程总结。`docs/` 使用允许列表，新增文档默认留在本地。
- `examples/demo-app/PROJECT_REFERENCE.md` 自动生成的本机参考，以及 `validate-jenkins.mjs` 本地真实平台验证脚本。
- `node_modules`、构建/覆盖率产物、日志、压缩包、IDE 配置与缓存。

忽略规则不会移除已经跟踪的文件。首次提交前查看实际待提交文件；以后发布也检查已跟踪文件与历史。真实凭据不得写入任何公开源码、测试或示例。

## 本地验证

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
docker build -t pi-reqflow:local .
REQFLOW_DOCKER_DEPLOYMENT_TEST=1 node --test test/docker-deployment.test.js
git status --short --untracked-files=all
```

npm 包使用 `package.json.files` 允许列表。Docker 构建使用 `.dockerignore` 允许列表；源码仓库、npm 包和镜像分别控制内容。不要上传整个本地目录打包的 ZIP。

## 发布 Docker 镜像

GitHub 的 CI 工作流运行语法检查、常规测试、镜像构建和 Compose 部署验收。手工发布与 `package.json.version` 一致的 `v<版本>` 标签后，发布工作流先运行同一套检查，再向 `ghcr.io/<owner>/<repository>:<版本>` 推送 `linux/amd64` 和 `linux/arm64` 镜像，附带来源、许可证、SBOM 与 provenance。

发布工作流使用仓库 `GITHUB_TOKEN`，需要允许写入 Packages。首次发布后，在 GHCR 的包设置中按需设为 Public，使用户可以匿名拉取。仓库命名建议使用 `pi-reqflow`；工作流会将镜像路径转为小写。标签与包版本不一致时发布失败。自动部署验收运行在 CI runner 的架构上，其他架构仍需实际部署验证。

标签发布属于维护者操作；此配置不会自动提交、打标签或推送代码，也不发布 npm 包。npm 名称是否可注册、作者信息与仓库地址应在实际 npm 发布前核实。

仓库简介建议使用 `Multi-agent AI coding for existing codebases, with human-approved plans and traceable requirement delivery. Powered by Pi.`。Topics 可设置 `pi`、`pi-coding-agent`、`ai-coding`、`multi-agent`、`requirements`、`workflow`、`human-in-the-loop`、`docker`，帮助用户按用途发现项目。
