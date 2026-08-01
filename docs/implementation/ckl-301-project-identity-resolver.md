# CKL-301 Project Identity Resolver

## 1. 目标与边界

`@zhiloop/project-identity` 把任意工作目录解析为稳定 `ProjectContext`，统一 Git Remote、仓库根、worktree、分支和无 Git 降级身份。输出同时包含 identity source、root marker 和 machine-readable reason codes，供 Episode Builder、Scope Resolver 和 Verifier 使用。

本模块只读取本地 Git/文件系统元数据，不访问网络、不修改 Git 配置、不扫描代码内容，也不决定 Knowledge Scope。

## 2. 三种身份来源

### 2.1 GIT_REMOTE

存在可移植网络 Remote 时：

```text
projectId = SHA256("project-identity-v1", "portable-git", normalizedRemote)
portable = true
```

ID 不包含当前 worktree root 或 branch，因此同一 Remote 的 main worktree、linked worktree 和不同机器 clone 得到相同 ID。`repositoryRoot` 仍保留当前 worktree 的 realpath，branch 只作为 Context，不参与身份。

### 2.2 GIT_LOCAL

Git 仓库没有 Remote，或 Remote 是本地 path/file URL 时：

```text
projectId = SHA256("project-identity-v1", "local-git", realGitCommonDir)
portable = false
```

`git rev-parse --git-common-dir` 在 linked worktree 间共享，避免用各 worktree root 产生不同本地 ID。仓库移动或复制到另一机器会改变 ID，符合不可移植语义。

### 2.3 FILESYSTEM_LOCAL

不在 Git 仓库时，从 realpath cwd 向上寻找最近标识文件：

```text
.zhiloop-project, .git, package.json, pom.xml,
settings.gradle(.kts), build.gradle(.kts), Cargo.toml,
go.mod, .project
```

身份为 root realpath + marker 名；没有 marker 时以 cwd 和 `directory` 生成。符号链接先 realpath，因此同一目录的别名不产生多个 ID。自定义 marker 必须是单个相对 basename，不能用 `../` 逃逸扫描目录。

## 3. Remote 规范化

`normalizeGitRemote` 支持 SCP-like、SSH、Git、HTTP 和 HTTPS：

```text
git@github.com:SmartEACup/ZhiLoop.git
ssh://git@github.com:22/SmartEACup/ZhiLoop.git
https://token@github.com/SmartEACup/ZhiLoop.git

=> github.com/smarteacup/zhiloop
```

规则包括：

- 去除 scheme、用户名、密码/token、query、fragment、默认端口、尾部 `.git` 和斜杠；
- host 小写并校验 label；GitHub/GitLab/Bitbucket path 小写，其他自建 Host 保留 path 大小写，避免假设其服务端大小写规则；
- 非默认端口保留在 authority；
- local/file、NUL、编码 dot traversal、非法 host/path 返回 undefined，触发本地身份而不是泄露原值。

不同 normalized Remote 进入哈希前保持不同字符串；测试覆盖不同 Host、Repo 和端口不碰撞。

## 4. Git CLI Probe

默认 `CliGitProjectProbe` 只通过 `execFile` 参数数组执行本地只读命令，不使用 shell：

```text
git -C <cwd> rev-parse --show-toplevel
git -C <root> rev-parse --git-common-dir
git -C <root> symbolic-ref --short -q HEAD
git -C <root> remote
git -C <root> config --get ...
git -C <root> remote get-url <name>
```

Remote 选择顺序为 `remote.pushDefault`、当前 branch remote、origin、字典序首个合法 remote。`.` 和非法/过长 remote name 被忽略。每条命令默认 2 秒、最大 30 秒，输出上限 64 KiB；Git 不可用或目录非仓库时不抛出命令 stderr，而是进入 filesystem fallback。

common-dir、branch、remote 列表并行读取，pushDefault 和 branch remote 并行读取。真实仓库基准从串行中位约 57.49ms 降到 31.31ms。

## 5. 输出契约

```ts
interface ProjectIdentityResolution {
  context: ProjectContext;
  source: "GIT_REMOTE" | "GIT_LOCAL" | "FILESYSTEM_LOCAL";
  rootMarker: string;
  reasonCodes: string[];
}
```

所有路径使用 realpath + NFKC；Windows 额外统一大小写。Probe facts 的 path、remote、branch 均有非空、长度和控制字符门禁。输出递归冻结，normalized Remote 不包含凭证。

## 6. 验证与性能

- 9 条专项测试覆盖 Remote transport/凭证/大小写/端口/攻击输入、portable worktree、不同 Remote、无 Remote common-dir、filesystem marker、symlink 和输入门禁。
- 2 条 Node 架构/Gate 测试使用真实临时 Git repository + linked worktree，验证参数安全命令，以及有/无 Remote 时 ID 一致。
- Resolver Lines 98.13%、Branches 88.23%、Functions 100%、Statements 95.12%。
- 全仓 285 条模块测试、27 条架构/Gate 测试通过。
- 当前真实 ZhiLoop 仓库 12 次计时样本：中位 31.31ms、P95 32.11ms。
- npm 官方 registry 审计：0 vulnerabilities。

## 7. 已知边界

- Resolver 是异步 I/O Adapter；Episode Builder 仍通过同步 `projectResolver` 接受已经解析/缓存的 ProjectContext。Daemon 装配应先解析并缓存，再构建 Episode，不能在每条 Event 上重复起 Git 子进程。
- Git executable 不可用时 linked worktree 只能按各自 `.git`/root 做 filesystem fallback，无法读取 shared common-dir，因此不能保证 worktree 合并；reasonCodes 会明确降级来源。
- 多 Remote 只选择一个确定性 primary remote，不把 fork/upstream 关系合并成同一项目。
- 自建 Git Host 的 repository path 保留大小写；如果服务端实际大小写不敏感，不同大小写 URL 会保守地产生不同 ID。
- 不验证 Remote 是否可连接或仓库是否存在，避免身份解析触网。
- 本模块未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
