# 分布式数据同步项目 (OpenClaw Sync Assistant) 实施计划

## 摘要 (Summary)

本项目旨在开发一个**开箱即用**的分布式数据同步扩展，中文名为 **“OpenClaw 同步助手”**，英文名为 **OpenClaw Sync Assistant**。
该项目将在 `D:\ai_project\openclaw-sync-assistant` 下作为独立项目开发，并严格遵循 OpenClaw 的 **原生插件 (Native Plugin) 标准**。开发完成后将开源到 GitHub，用户完全可以通过 OpenClaw 的**官方插件命令直接安装和卸载**。底层引入基于 Node.js 的 **Holepunch (原 Hypercore Protocol)** 开源栈（`hyperswarm` + `hyperdrive`），自带 P2P 内网穿透与端到端加密，解决跨网同步痛点。

## 极简安装与官方集成 (Official Installation & UX)

### 1. 官方原生插件机制安装/卸载

为了满足“必须通过官方插件安装方法直接安装卸载”的要求，本项目将打包为标准 npm 包，并支持通过 GitHub 或 NPM 仓库一键安装：

- **安装 (Installation)**：

  ```bash
  # 从开源后的 GitHub 仓库直接安装
  openclaw plugin install github:您的用户名/openclaw-sync-assistant

  # 或者从 npm 官方仓库安装 (若发布)
  openclaw plugin install openclaw-sync-assistant
  ```

- **卸载 (Uninstallation)**：

  ```bash
  openclaw plugin uninstall openclaw-sync-assistant
  ```

### 2. 初始化与配置向导

安装后，通过官方 CLI 扩展注册机制提供交互式配置：

```bash
$ openclaw sync setup
? 请输入您的同步密钥 (Sync Secret, 用于生成 P2P 发现的 Topic 和加密数据): [********]
? 请选择要同步的内容: [x] Config  [x] Auth  [ ] Sessions  [x] Workspace
✔ 配置完成！同步助手后台服务已接管状态同步。
```

### 3. Skill 对话集成

内置 `skills/sync.md`，用户可直接与大模型对话：

- `@OpenClaw 我的公司电脑连上了吗？` -> Agent 调用内部接口查看连接状态。

- `@OpenClaw 帮我处理一下配置冲突。` -> 辅助合并 `.conflict` 文件。

## 拟议变更与独立建库 (Proposed Changes & Independent Repo)

项目在 `D:\ai_project\openclaw-sync-assistant` 下创建，但内部结构完全遵循 OpenClaw 插件规范：

### 1. 独立项目初始化步骤

1. 在 `D:\ai_project` 下新建 `openclaw-sync-assistant`。
2. `npm init -y` 并安装 P2P 核心依赖：`hyperswarm`, `hyperdrive`, `localdrive` 等。
3. 初始化 Git，准备开源推送到 GitHub `main` 分支。

### 2. 核心模块与官方插件结构

- **`openclaw.plugin.json`**：OpenClaw 插件清单。声明 `id: "sync-assistant"`、技能路径、配置 Schema（如 `syncSecret`）。

- **`package.json`**：声明入口点 `main: "dist/index.js"`，确保 OpenClaw 运行时可以正确加载。

- **`src/index.ts`**：插件入口，必须导出一个 `export async function register(api: OpenClawPluginAPI)` 函数。在此处拦截生命周期：
  - 注册 CLI 命令 `openclaw sync`。

  - 启动后台的 `hyperswarm` 守护进程，监听 `$OPENCLAW_STATE_DIR`。

- **`src/p2p-network.ts`**：利用 `hyperswarm` 进行 DHT 穿透和对等节点发现。

- **`src/drive-manager.ts`**：将 `~/.openclaw` 中的指定目录映射为 `localdrive`，与远端的 `hyperdrive` 建立双向镜像。

- **`src/conflict.ts`**：文件冲突时保留本地修改，远端重命名为 `.conflict.<timestamp>`。

- **`skills/sync.md`**：官方技能描述文件。

## 现有开源方案对比与本方案优化 (Reference & Optimization)

**社区现有参考方案**：`awesome-openclaw-skills` 中的 `/sync` 技能。

- **工作原理**：基于 `Tailscale + SSH + rsync`。

- **致命缺点**：需要用户手动配置 VPN、配置 SSH 密钥、依赖系统级命令，**极难一键安装**，且在 Windows 上体验差。

**本项目极致优化**：
采用 **Hypercore / Hyperswarm / Hyperdrive** 栈全面替代：

- **无外部依赖 (Pure Node.js)**：不需要 Tailscale，不需要 SSH 密钥。所有逻辑打包在一个 NPM 插件内。

- **自带 P2P 打洞 (NAT Traversal)**：利用 `hyperswarm` 自动穿透防火墙。

- **完全符合官方插件生命周期**：随 OpenClaw 启动而启动，随 `openclaw plugin uninstall` 干净卸载，无需残留第三方守护进程。

## 假设与决策 (Assumptions & Decisions)

1. **运行时接管**：插件将在 `register(api)` 阶段读取 OpenClaw 的上下文路径（`api.paths.stateDir` 等），确保同步的绝对路径完全动态适应当前运行的 OpenClaw 实例。
2. **多写一致性决策**：采用“Last-Write-Wins (最后写入者赢) + 冲突文件留存”的策略，确保任何情况都不丢失本地数据。

## 验证步骤 (Verification Steps)

1. **插件打包与安装验证**：在独立项目内运行构建后，使用 `openclaw plugin install /path/to/local/folder` 验证官方安装流程是否成功。
2. **网络穿透测试**：在两台不同网络的机器上分别安装该插件，输入相同密钥，确认打洞成功。
3. **OpenClaw 挂载与卸载测试**：运行 `openclaw plugin uninstall openclaw-sync-assistant`，确认相关进程优雅退出且配置清理干净。
4. **开源发布**：确认代码无敏感信息，推送到您的 GitHub 仓库供社区通过 `openclaw plugin install github:...` 安装。
