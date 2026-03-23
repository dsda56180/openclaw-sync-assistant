# OpenClaw Sync Assistant

> 一个开箱即用的分布式数据同步扩展，为 OpenClaw 提供 P2P 或 GitHub 托管的状态同步能力。

## ✨ 功能特性 (Features)

- **原生集成**：完全遵循 OpenClaw 的 Native Plugin 标准，支持官方 CLI 一键安装与卸载。
- **双引擎同步**：
  - **P2P 直连模式**：基于 Node.js 的 Holepunch 开源栈 (`hyperswarm` + `hyperdrive`)，自带内网穿透 (NAT Traversal) 与端到端加密，无需服务器即可实现设备间极速同步。
  - **GitHub 托管模式**：支持将配置与状态备份至私有/公共 GitHub 仓库，便于归档与版本控制。
- **灵活架构**：
  - **去中心模式 (Decentralized)**：适合多设备对等同步，随时随地拉取与合并。
  - **中心模式 (Centralized)**：适合以某台设备或远程仓库为主的主从同步。
- **交互式向导**：提供精美的终端配置界面 (`@clack/prompts`)，降低上手门槛。
- **AI 技能集成**：内置大模型对话能力 (规划中)，可通过自然语言查询同步状态或解决冲突。

## 📦 系统要求与环境依赖 (Requirements)

- **操作系统**：Windows / macOS / Linux
- **主程序**：[OpenClaw](https://github.com/openclaw/openclaw) >= 2026.3.0
- **Node.js**：>= 18.0.0
- **NPM**：>= 8.0.0

## 🚀 安装与配置指南 (Installation & Setup)

### 1. 安装插件

你可以通过 OpenClaw 官方的 CLI 工具直接从 GitHub 或 NPM 仓库进行安装。

从 GitHub 安装（推荐最新版）：

```bash
openclaw plugins install github:dsda56180/openclaw-sync-assistant
```

从 NPM 仓库安装（如果你已发布）：

```bash
openclaw plugins install openclaw-sync-assistant
```

### 2. 初始化与配置

安装完成后，在终端运行以下命令启动交互式配置向导：

```bash
openclaw sync setup
```

**配置步骤说明**：

1. **选择同步方式 (Sync Method)**：选择 `P2P` 或 `GitHub`。
2. **选择同步模式 (Sync Mode)**：选择 `Centralized` (中心模式) 或 `Decentralized` (去中心模式)。
3. **输入凭证**：
   - 如果选择 P2P：输入 `Sync Secret` (用于生成发现 Topic 和加密数据的密码)。
   - 如果选择 GitHub：输入 `GitHub Repo` (用于备份的远程仓库地址)。
4. **选择同步模块**：勾选需要同步的内容，例如 `Config`, `Auth`, `Workspace` 等。

配置完成后，后台服务将自动接管状态同步。

### 3. 卸载插件

如果你需要卸载，请运行：

```bash
openclaw plugins uninstall openclaw-sync-assistant
```

## 💻 使用示例与命令 (Usage)

本插件旨在“隐形”运行，配置完成后基本无需手动干预。但你仍可以通过以下命令/方式进行交互：

- **重新配置**：
  ```bash
  openclaw sync setup
  ```
- **自然语言交互 (AI Skill)**：
  在 OpenClaw 的对话框中直接向 Agent 提问（需结合技能配置）：
  - _"@OpenClaw 我的同步状态正常吗？两台电脑连上了吗？"_
  - _"@OpenClaw 帮我把现在的配置强制同步到 GitHub。"_
  - _"@OpenClaw 帮我处理一下本地的 .conflict 冲突文件。"_

## 🗂️ 目录结构说明 (Directory Structure)

```text
openclaw-sync-assistant/
├── index.js                # 插件主入口 (激活与注册生命周期)
├── openclaw.plugin.json    # OpenClaw 原生插件配置清单 (包含 Config Schema)
├── package.json            # NPM 包依赖与脚本配置
├── test.js                 # 基础单元测试
├── .eslintrc.json          # ESLint 校验配置
└── .trae/
    └── documents/          # 项目设计方案与架构文档
```

## 🤝 贡献指南 (Contributing)

我们欢迎任何形式的贡献！如果你想参与开发，请参考以下步骤：

1. Fork 本仓库。
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)。
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)。
4. 推送到分支 (`git push origin feature/AmazingFeature`)。
5. 开启一个 Pull Request。

请确保你的代码符合本项目的 ESLint 规范，并在提交前运行 `npm run prepublishOnly`。

## 📄 开源协议 (License)

本项目基于 [MIT License](LICENSE) 开源，允许自由使用、修改和分发。

## 👨‍💻 作者与致谢 (Author & Acknowledgments)

- **Author**: [dsda56180](https://github.com/dsda56180)
- **Acknowledgments**:
  - 感谢 [OpenClaw](https://github.com/openclaw/openclaw) 提供的强大插件生态。
  - 感谢 [Holepunch](https://holepunch.to/) 团队提供的底层 P2P 架构 (`hyperswarm`, `hyperdrive`)。

---

_最后更新日期: 2026-03-23 | 版本: v1.0.0_
