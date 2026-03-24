const simpleGit = require("simple-git");
const chokidar = require("chokidar");
const fs = require("fs");

class GitSyncService {
  constructor(syncDir, githubRepo, syncMode, debug = false) {
    this.syncDir = syncDir;
    this.githubRepo = githubRepo;
    this.syncMode = syncMode; // 'centralized' or 'decentralized'
    this.debug = debug;

    // 确保同步目录存在，否则 simple-git 初始化会报错
    if (!fs.existsSync(this.syncDir)) {
      fs.mkdirSync(this.syncDir, { recursive: true });
    }

    this.git = simpleGit(this.syncDir);
    this.watcher = null;
    this.syncTimeout = null;
    this.isSyncing = false;
  }

  log(...args) {
    if (this.debug) {
      console.log("[OpenClaw Sync (GitHub)]", ...args);
    }
  }

  error(...args) {
    console.error("[OpenClaw Sync (GitHub)] ❌", ...args);
  }

  async init() {
    try {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        this.log("初始化本地 Git 仓库...");
        await this.git.init();
        await this.git.addRemote("origin", this.githubRepo);

        // 尝试拉取远程仓库以防它是非空的
        try {
          await this.git.pull("origin", "main", {
            "--allow-unrelated-histories": null,
          });
        } catch (e) {
          this.log("远程仓库可能为空，或者拉取失败 (可忽略):", e.message);
        }
      } else {
        // 检查并更新 remote
        const remotes = await this.git.getRemotes(true);
        const origin = remotes.find((r) => r.name === "origin");
        if (!origin) {
          await this.git.addRemote("origin", this.githubRepo);
        } else if (origin.refs.fetch !== this.githubRepo) {
          await this.git.removeRemote("origin");
          await this.git.addRemote("origin", this.githubRepo);
        }

        // 获取当前分支，如果为空则尝试设置为 main
        let currentBranch = "";
        try {
          const branches = await this.git.branch();
          currentBranch = branches.current;
        } catch (e) {
          // ignore
        }

        if (!currentBranch) {
          try {
            await this.git.checkoutLocalBranch("main");
          } catch (e) {
            // ignore
          }
        }

        // 启动时自动拉取最新更改
        this.log("拉取远程最新状态...");
        try {
          await this.git.pull("origin", "main");
          this.log("✅ 拉取成功");
        } catch (e) {
          this.error("拉取失败 (可能仓库为空或无 main 分支):", e.message);
        }
      }

      this.startWatching();
    } catch (err) {
      this.error("初始化失败:", err);
    }
  }

  startWatching() {
    this.log(`开始监听目录变化: ${this.syncDir}`);

    // 监听目录变化，忽略 .git 目录
    this.watcher = chokidar.watch(this.syncDir, {
      ignored: /(^|[/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    const triggerSync = (event, filepath) => {
      this.log(`检测到文件变化 [${event}]: ${filepath}`);

      // 防抖：2秒内没有新变化则触发同步
      if (this.syncTimeout) clearTimeout(this.syncTimeout);
      this.syncTimeout = setTimeout(() => this.performSync(), 2000);
    };

    this.watcher
      .on("add", (path) => triggerSync("add", path))
      .on("change", (path) => triggerSync("change", path))
      .on("unlink", (path) => triggerSync("unlink", path));
  }

  async performSync() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const status = await this.git.status();
      if (status.isClean()) {
        this.log("没有需要提交的更改");
        this.isSyncing = false;
        return;
      }

      this.log("正在提交并推送到 GitHub...");
      await this.git.add("./*");

      const timestamp = new Date().toISOString();
      await this.git.commit(`Auto-sync: ${timestamp} via OpenClaw`);

      // 推送
      await this.git.push("origin", "main");
      this.log("✅ 同步推送成功！");
    } catch (err) {
      this.error("同步推送失败:", err);
    } finally {
      this.isSyncing = false;
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.log("停止监听文件变化");
    }
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
  }
}

module.exports = GitSyncService;
