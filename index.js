const {
  intro,
  outro,
  text,
  multiselect,
  select,
  spinner,
} = require("@clack/prompts");
const pc = require("picocolors");

module.exports = {
  /**
   * 插件激活时的入口函数
   * @param {object} context - OpenClaw 提供的上下文对象，包含 api 等
   */
  async activate(context) {
    if (process.env.DEBUG === "openclaw:sync") {
      console.log("✅ openclaw-sync-assistant 插件已激活！");
    }

    // 检查是否已经配置过
    let hasConfigured = false;
    if (context.api && context.api.config && context.api.config.get) {
      const currentMethod = await context.api.config.get(
        "openclaw-sync-assistant.syncMethod",
      );
      if (currentMethod) {
        hasConfigured = true;
      }
    }

    // 如果未配置，则在安装/首次加载时触发引导向导
    if (!hasConfigured) {
      await this.runSetupWizard(context);
    }

    // 根据模式启动后台服务的逻辑占位
    // if (config.syncMethod === 'p2p') startP2PService(context);
    // else if (config.syncMethod === 'github') startGitSyncService(context);
  },

  /**
   * 运行配置引导向导
   */
  async runSetupWizard(context) {
    console.log("\n");
    intro(pc.bgCyan(pc.black(" OpenClaw Sync Assistant 初始配置引导 ")));
    console.log(
      pc.gray(
        "提示: 你可以随时按 Ctrl+C 跳过此向导，稍后在配置文件中手动设置。\n",
      ),
    );

    const syncMethod = await select({
      message: "请选择同步方式 (Sync Method):",
      options: [
        { value: "skip", label: "跳过配置 (稍后设置)" },
        { value: "p2p", label: "点对点直连 (P2P - 基于 Hyperswarm)" },
        { value: "github", label: "GitHub 托管 (基于 Git 仓库)" },
      ],
    });

    if (syncMethod === "skip" || typeof syncMethod === "symbol") {
      outro(pc.yellow("已跳过同步配置。你可以稍后修改 openclaw.json 来启用。"));
      return;
    }

    const syncMode = await select({
      message: "请选择同步模式 (Sync Mode):",
      options: [
        {
          value: "decentralized",
          label: "去中心模式 (Decentralized - 适合多设备对等同步)",
        },
        {
          value: "centralized",
          label: "中心模式 (Centralized - 适合以某台设备为主的主从同步)",
        },
        { value: "skip", label: "跳过" },
      ],
    });

    if (syncMode === "skip" || typeof syncMode === "symbol") {
      outro(pc.yellow("已跳过同步配置。"));
      return;
    }

    let syncSecret = "";
    let githubRepo = "";

    if (syncMethod === "p2p") {
      syncSecret = await text({
        message: "请输入您的同步密钥 (Sync Secret, 用于生成 P2P 发现和加密):",
        placeholder: "例如: my-super-secret-key (直接回车可跳过)",
      });
      if (typeof syncSecret === "symbol") return;
    } else if (syncMethod === "github") {
      githubRepo = await text({
        message: "请输入用于同步的 GitHub 仓库地址:",
        placeholder: "例如: https://github.com/... (直接回车可跳过)",
      });
      if (typeof githubRepo === "symbol") return;
    }

    const syncItems = await multiselect({
      message: "请选择要同步的内容 (按空格勾选，回车确认):",
      options: [
        { value: "Config", label: "Config", hint: "OpenClaw 核心配置" },
        { value: "Auth", label: "Auth", hint: "认证信息" },
        { value: "Workspace", label: "Workspace", hint: "工作区状态" },
      ],
      required: false,
    });

    if (typeof syncItems === "symbol") return;

    const s = spinner();
    s.start(`正在保存初始配置...`);

    if (
      context &&
      context.api &&
      context.api.config &&
      context.api.config.update
    ) {
      await context.api.config.update(
        "openclaw-sync-assistant.syncMethod",
        syncMethod,
      );
      await context.api.config.update(
        "openclaw-sync-assistant.syncMode",
        syncMode,
      );
      if (syncSecret) {
        await context.api.config.update(
          "openclaw-sync-assistant.syncSecret",
          syncSecret,
        );
      }
      if (githubRepo) {
        await context.api.config.update(
          "openclaw-sync-assistant.githubRepo",
          githubRepo,
        );
      }
      if (syncItems && syncItems.length > 0) {
        await context.api.config.update(
          "openclaw-sync-assistant.syncItems",
          syncItems,
        );
      }
    }

    s.stop("配置已保存！");
    outro(
      pc.green(
        `✔ 配置向导完成！后台服务将按 [${syncMethod.toUpperCase()}] 模式运行。`,
      ),
    );
  },

  /**
   * 插件卸载时的清理函数
   */
  deactivate() {
    console.log("❌ openclaw-sync-assistant 插件已卸载。");
  },
};
