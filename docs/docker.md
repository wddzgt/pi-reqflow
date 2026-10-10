# Docker 启动与持久化

镜像包含 Node 22、Git、ripgrep 和固定版本 Pi（`@earendil-works/pi-coding-agent@0.87.1`）。核心 CLI 和可选 Web 共用镜像；无需在宿主机安装 Node 或 Pi。目标项目所需 Java、Python、Go、数据库客户端等应由使用方扩展镜像。

## 首次启动

在源码目录执行

```sh
docker compose up -d --build
```

打开 <http://localhost:4173>，使用默认管理员 `admin` / `admin123` 登录。首次启动自动创建“内置演示项目”，包含计算器源码与真实测试入口，模型初始为未配置。

接入自己的代码库时，用这一条命令替换上面的启动命令

```sh
REQFLOW_PROJECT_DIR=/absolute/path/to/your-project docker compose up -d --build
```

登录后点击左侧“导入”，项目目录预填为 `/projects/project`，填写项目名称后接入。导入建立静态源码索引，不调用模型；源码挂载为只读，后续工作在 service-state 卷中的导入副本和隔离工作区中完成。已有 Git 项目仍需具备干净的基础分支和明确的远程仓库。系统不会替你提交或丢弃未提交修改。

启动后可以在“模型设置”测试并保存连接，在“项目设置”核对检查方式，在“用户管理”添加产品与研发成员。需要 AI 项目指南时，配置模型后在“项目文档”点击刷新。

默认管理员只在从未注册项目的新部署中创建。登录后可在“用户管理”重置管理员密码、创建产品与研发账号。重启使用已有账号与项目，密码不会恢复为默认值；全部项目归档也不会重新创建演示项目或账号。

日常启动、查看日志和停止服务

```sh
docker compose up -d
docker compose logs --tail 100 reqflow
docker compose down
```

只有改变代码或镜像时才需要重建。默认端口仅发布到本机，持久化卷在 `down` 后保留。

指定自定义项目目录后，后续 Compose 命令继续传入相同的 `REQFLOW_PROJECT_DIR`；也可将目录保存到 `.docker.env`，使用 `docker compose --env-file .docker.env ...`。首次导入后的项目副本与账号保存在 service-state 卷中。

## 可选的命令行部署

已经使用 CLI 初始化、希望直接管理宿主机项目的用户，可额外加载 `compose.project.yaml`。以下高级流程使用 `docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml`；默认账号登录与网页导入无需执行。

准备一个真实目标仓库、独立的 Docker 项目配置以及 Compose 环境文件。项目配置可从 `examples/config.docker.json` 复制；在 `.docker.env` 中显式填写 `REQFLOW_CONFIG_FILE` 的绝对路径。按真实项目填写 provider/model、路径、验证与测试发布命令。不要使用宿主机可执行文件路径。

```sh
cp docker/compose.env.example .docker.env
# 编辑 .docker.env 中两个绝对路径；编辑项目配置中的模型、检查和发布命令。
docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml build
docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml run --rm reqflow policy-preview --project /projects/project --config /config/project.json
```

Linux 上可将 `.docker.env` 的 REQFLOW_UID/GID 设置为目标文件所属用户的非 root UID/GID，再构建镜像。宿主机目录必须事先存在，并允许该用户读写；Compose 不会创建缺失目录或递归更改宿主机权限。

默认初始化会调用一次模型生成项目理解，需先配置 Pi 账号或自定义 provider。可进入持久化 Pi 环境交互操作

```sh
docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml run --rm --entrypoint pi reqflow
docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml run --rm reqflow init --project /projects/project --config /config/project.json
```

Pi 配置与凭据保存在专用 `pi-state` 卷中，不会进入镜像或源码。交互式 Pi 可使用 `/login` 配置内置 provider 的认证。若通过环境变量提供模型密钥，在项目 `environment.pi` 显式列出变量名称；Compose 已提供 `DASHSCOPE_API_KEY` 透传，其他变量需要覆盖文件注入。不要写入模型配置 JSON 或 Compose 环境示例。Jenkins 凭据同理由使用方的 secret 管理流程注入。

初始化自动生成开发者和 Agent 指南，无需人工确认。尚未配置模型时，可明确选择 `init --inventory-only true` 仅建立静态索引，配置模型后运行 `project-document` 生成指南。

首次创建管理员，以下输入示例使用 Bash，输入内容不会写入命令历史；网页登录不需要创建 CLI 令牌

```bash
read -r -s -p 'Admin password: ' ADMIN_PASSWORD; printf '\n'
export ADMIN_PASSWORD
docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml run --rm -e ADMIN_PASSWORD reqflow auth-add --project /projects/project --user admin --username admin --roles admin --password-env ADMIN_PASSWORD
unset ADMIN_PASSWORD
```

人工身份只有 product、developer、admin；frontend/backend/qa 等是执行角色，不创建人工账号。不同用户不能共享令牌。密码至少 6 字节，令牌至少 32 字节。随后启动服务

```sh
docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml up -d
docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml ps
docker compose --env-file .docker.env -f compose.yaml -f compose.project.yaml logs --tail 100 reqflow
```

默认打开 `http://localhost:4173`。修改宿主机端口时，同步修改 REQFLOW_PUBLIC_ORIGIN，例如端口 4174 对应 `http://localhost:4174`。停服务使用 `docker compose --env-file .docker.env down`，持久化卷保留。

## 数据和路径约定

| 容器路径 | 来源与用途 |
| --- | --- |
| /projects/project | 待导入项目的只读源码挂载；CLI 高级部署改为读写，审计和基线留在宿主机项目下 |
| /projects/.reqflow-workspaces | workspaces 持久卷，保存计划副本、需求 worktree 和候选版本 |
| /home/node/.pi | pi-state 持久卷，保存模型配置与凭据 |
| /var/lib/reqflow | service-state 持久卷，保存项目注册、导入项目及其隔离工作区、受保护的会话文件 |
| /config/project.json | 仅 CLI 高级部署挂载的只读候选配置文件 |
| /tmp | 有容量限制的临时内存文件系统 |

使用容器路径初始化新项目，全程通过容器 CLI 管理，命令形式为 `docker compose ... run --rm reqflow <子命令> --project /projects/project ...`；身份命令以 `-e REQFLOW_TOKEN` 传入当前用户令牌。已经由宿主机初始化的任务含宿主机路径，不会自动迁移或重写审计记录。

工作区卷和目标项目审计必须一起备份，并在恢复时保持容器路径不变。改变 Compose 项目名会选择另一组命名卷；固定项目名可使用 `-p your-project`，后续命令保持一致。不要对有待处理需求的部署删除卷。更换 UID/GID 时还需显式安排旧卷的权限迁移，构建新镜像不会修改旧卷。

Git 模式要求完整仓库的 `.git` 在项目挂载内；指向宿主机外部 gitdir 的已有 worktree 不适用此挂载方案。远端访问使用专用凭据和已知主机配置，由使用方单独配置，系统不自动挂载宿主机 SSH、Git 或 Docker 配置。提交、推送和测试分支合并仅在研发查看变更并明确授权后执行；系统不自动删除分支或改写历史。

基础镜像支持 Git HTTPS 访问；SSH 访问需在扩展镜像安装 openssh-client，并显式配置受限凭据与 known_hosts。初始化临时数据位于项目内的保留目录 `.reqflow-init`，不会被纳入业务基线或交给 Pi。

## 网络与执行边界

CLI 与 Web 通过 `REQFLOW_STATE_DIR=/var/lib/reqflow` 共用受保护的服务状态。默认 Web 启动创建内置演示项目和管理员；高级 CLI 部署可使用 `project-import` 显式配置管理员。管理员登录后导入新项目，新项目沿用当前账号目录。项目导入和模型配置均要求认证。备份时包括 service-state 卷；项目归档不会删除该卷或源代码。

旧账号 schema 2/3 需停止服务，并显式执行 `auth-reprovision --project /projects/project --passwords-file <容器内密码文件>`；密码文件为 0600 的 JSON，对每个现存用户提供新密码，例如 `{"user-id":"new-password-of-at-least-6-bytes"}`。使用只读临时挂载传入，由操作员妥善保管输入文件与生成的账号备份。schema 1 需单独重新配置。Docker 启动不会改写身份文件，重新构建镜像不能替代账号升级。

Compose 默认发布到宿主机 127.0.0.1。服务在容器内监听 0.0.0.0，显式 origin 同时限定 Host 与浏览器 Origin；`/healthz` 只返回存活状态，业务 API 仍需认证。HTTPS origin 使用 Secure 会话 Cookie。团队远程访问应经过 TLS 反向代理，保持原始 Host/Origin，并将 REQFLOW_PUBLIC_ORIGIN 设置为精确 HTTPS 地址；模板不提供公网监听或 TLS 终止服务。

容器默认非 root、只读根文件系统、移除 capabilities、no-new-privileges、限制进程数和内存，并由 init 回收进程。Pi、检查和本地发布都在此容器中运行。它们共享目标项目挂载及 Pi 配置卷；这是部署边界，尚不构成每个需求或角色独立的安全沙箱。模型调用需要网络，本模板没有出站网络白名单。

模板不挂载 Docker socket，也不内置 Docker CLI。此模板不支持 `checkSandbox.kind=docker`。嵌套检查需要独立 runner 适配与正确的宿主机路径映射，直接挂载 Docker socket 会扩大权限。容器版检查在服务容器中执行；需要更强隔离时先接入专用 runner。

生产发布、数据库访问和已有系统回归仍须明确授权与验证。停止服务会结束当前进程，不会自动重试处于实施或发布中的任务；应使用已有审计、锁恢复与外部结果核查流程。首次启动自动准备演示项目和管理员，业务项目导入、模型配置与任务操作均在登录后进行，后续审批规则照常执行。

## 镜像来源

默认 Node 基础镜像固定版本；生产使用可通过 REQFLOW_NODE_IMAGE 配置已批准的 digest 或镜像仓库。Pi 包版本固定且发行包自带依赖锁；构建过程中不会读取本机 API Key、`.pi`、`.reqflow`、工作区或 node_modules，构建上下文由 `.dockerignore` 白名单限定。镜像拉取失败时会报错，不自动换源；可由使用方明确指定已批准镜像源后重试。

构建完成后可显式运行容器验收测试 `REQFLOW_DOCKER_DEPLOYMENT_TEST=1 node --test test/docker-deployment.test.js`。测试创建随机名称的临时 Compose 项目，验证默认账号登录、项目导入、Pi 启动、审批权限、容器限制及重建后的审计/工作区/Pi 状态持久化，仅清理自己创建的测试卷。普通 `npm test` 默认不启动此部署测试。

## 使用发布镜像

如果构建阶段访问 npm 超时，而宿主机与运行容器能正常访问该地址，检查 Docker 构建网络及代理配置。在支持 host 构建网络的开发环境中，可显式用下面命令验证，再按部署主机策略修复网络

```sh
docker build --network=host -t pi-reqflow:local .
```

此参数只作用于构建过程，不改变 Compose 服务的运行网络。项目不会自动切换镜像源或 npm registry。

开源仓库发布版本标签后，GitHub 工作流可构建并推送 GHCR 镜像。镜像地址按实际仓库填写，不假定已有公开镜像。发布配置与权限见 [发布指南](releasing.md)。

在 `.docker.env` 设置 `REQFLOW_IMAGE=ghcr.io/<owner>/pi-reqflow:<version>`，然后运行

```sh
docker compose --env-file .docker.env pull
docker compose --env-file .docker.env up -d --no-build
```

首次访问使用默认管理员登录。优先使用固定版本或 digest。升级前停止活动任务，备份目标项目 `.reqflow`、工作区、Pi 和服务状态，再修改镜像版本、拉取并重建容器。使用相同 Compose 项目名与挂载路径；`down` 保留卷，`down --volumes` 会删除卷中的持久数据。
