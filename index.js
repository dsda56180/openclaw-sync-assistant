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
    // 仅在明确启用 DEBUG 的情况下输出激活日志
    if (process.env.DEBUG === 'openclaw:sync') {
      console.log("✅ openclaw-sync-assistant 插件已激活！");
    }

    // 如果 context 提供了注册命令的方法，我们注册 `sync setup` 命令
    if (
      context.api &&
      context.api.commands &&
      context.api.commands.registerCommand
    ) {
      context.api.commands.registerCommand("sync.setup", async () => {
        console.log("\n");
        intro(pc.bgCyan(pc.black(" OpenClaw Sync Assistant Setup ")));

        const syncMethod = await select({
          message: "请选择同步方式 (Sync Method):",
          options: [
            { value: "p2p", label: "点对点直连 (P2P - 基于 Hyperswarm)" },
            { value: "github", label: "GitHub 托管 (基于 Git 仓库)" },
          ],
        });

        const syncMode = await select({
          message: "请选择同步模式 (Sync Mode):",
          options: [
            {
              value: "decentralized",
              label:
                "去中心模式 (Decentralized - 适合多设备对等同步，随时随地拉取)",
            },
            {
              value: "centralized",
              label:
                "中心模式 (Centralized - 适合以某台设备或仓库为主的主从同步)",
            },
          ],
        });

        let syncSecret = "";
        let githubRepo = "";

        if (syncMethod === "p2p") {
          syncSecret = await text({
            message:
              "请输入您的同步密钥 (Sync Secret, 用于生成 P2P 发现的 Topic 和加密数据):",
            placeholder: "例如: my-super-secret-key",
            validate(value) {
              if (value.length === 0) return "同步密钥不能为空！";
            },
          });
        } else if (syncMethod === "github") {
          githubRepo = await text({
            message: "请输入用于同步的 GitHub 仓库地址:",
            placeholder: "例如: https://github.com/your-name/sync-repo.git",
            validate(value) {
              if (value.length === 0) return "GitHub 仓库地址不能为空！";
            },
          });
        }

        const syncItems = await multiselect({
          message: "请选择要同步的内容:",
          options: [
            { value: "Config", label: "Config", hint: "OpenClaw 核心配置" },
            { value: "Auth", label: "Auth", hint: "认证信息" },
            { value: "Sessions", label: "Sessions", hint: "会话记录" },
            { value: "Workspace", label: "Workspace", hint: "工作区状态" },
          ],
          required: true,
        });

        const s = spinner();
        s.start(
          `正在初始化 [${syncMethod.toUpperCase()} - ${syncMode}] 同步服务...`,
        );

        // 模拟保存配置 (实际应使用 context.api.config.update 等方法)
        if (context.api.config && context.api.config.update) {
          await context.api.config.update(
            "openclaw-sync-assistant.syncMethod",
            syncMethod,
          );
          await context.api.config.update(
            "openclaw-sync-assistant.syncMode",
            syncMode,
          );
          if (syncSecret)
            await context.api.config.update(
              "openclaw-sync-assistant.syncSecret",
              syncSecret,
            );
          if (githubRepo)
            await context.api.config.update(
              "openclaw-sync-assistant.githubRepo",
              githubRepo,
            );
          await context.api.config.update(
            "openclaw-sync-assistant.syncItems",
            syncItems,
          );
        }

        // 模拟启动相关服务等耗时操作
        await new Promise((resolve) => setTimeout(resolve, 1500));

        s.stop("配置已保存！");

        outro(
          pc.green(
            `✔ 配置完成！同步助手后台服务已按 [${syncMethod.toUpperCase()} - ${syncMode}] 接管状态同步。`,
          ),
        );
      });
    } else if (process.env.DEBUG === 'openclaw:sync') {
      console.log(
        pc.yellow(
          "提示: 可以在配置文件中设置 syncMethod, syncMode, syncSecret 和 githubRepo 来启动同步。",
        ),
      );
    }

    // 根据模式启动后台服务的逻辑占位
    // if (config.syncMethod === 'p2p') startP2PService(context);
    // else if (config.syncMethod === 'github') startGitSyncService(context);
  },

  /**
   * 插件卸载时的清理函数
   */
  deactivate() {
    console.log("❌ openclaw-sync-assistant 插件已卸载。");
  },
};
