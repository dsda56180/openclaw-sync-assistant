const simpleGit = require("simple-git");
const chokidar = require("chokidar");
const fs = require("fs");
const path = require("path");
const {
  normalizeSyncItems,
  resolveSyncEntries,
} = require("./sync-items");

const PRESERVED_ENTRY_NAMES = new Set([".git"]);

function listDirectoryEntries(rootPath, { excludePreserved = false } = {}) {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const entryNames = fs.readdirSync(rootPath);
  if (!excludePreserved) {
    return entryNames;
  }

  return entryNames.filter((entryName) => !PRESERVED_ENTRY_NAMES.has(entryName));
}

function mirrorDirectory(sourcePath, targetPath, { preserveTargetEntries = false } = {}) {
  if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  fs.mkdirSync(targetPath, { recursive: true });

  const sourceEntries = listDirectoryEntries(sourcePath, {
    excludePreserved: true,
  });
  const sourceEntrySet = new Set(sourceEntries);
  const targetEntries = listDirectoryEntries(targetPath, {
    excludePreserved: preserveTargetEntries,
  });

  for (const entryName of targetEntries) {
    if (!sourceEntrySet.has(entryName)) {
      fs.rmSync(path.join(targetPath, entryName), { recursive: true, force: true });
    }
  }

  for (const entryName of sourceEntries) {
    const sourceEntryPath = path.join(sourcePath, entryName);
    const targetEntryPath = path.join(targetPath, entryName);
    const sourceStat = fs.statSync(sourceEntryPath);

    if (sourceStat.isDirectory()) {
      mirrorDirectory(sourceEntryPath, targetEntryPath);
      continue;
    }

    fs.mkdirSync(path.dirname(targetEntryPath), { recursive: true });
    fs.copyFileSync(sourceEntryPath, targetEntryPath);
  }
}

class GitSyncService {
  constructor(syncDir, githubRepo, syncMode, options = {}, debug = false) {
    if (typeof options === "boolean") {
      debug = options;
      options = {};
    }

    this.syncDir = syncDir;
    this.githubRepo = githubRepo;
    this.syncMode = syncMode;
    this.debug = debug;
    this.openclawDir = options.openclawDir || path.dirname(syncDir);
    this.syncItems = GitSyncService.normalizeSyncItems(options.syncItems);
    this.syncEntries = GitSyncService.resolveSyncEntries(
      this.openclawDir,
      this.syncDir,
      this.syncItems,
    );
    fs.mkdirSync(this.syncDir, { recursive: true });
    this.git = simpleGit(this.syncDir);
    this.watcher = null;
    this.syncTimeout = null;
    this.isSyncing = false;
    this.suspendWatchUntil = 0;
    this.lastSyncAt = null;
    this.lastError = null;
    this.lastConflictFiles = [];
    this.lastConflictAt = null;
    this.primaryBranch = "main";

  }

  static normalizeSyncItems(syncItems) {
    return normalizeSyncItems(syncItems);
  }

  static resolveSyncEntries(openclawDir, syncDir, syncItems) {
    return resolveSyncEntries(openclawDir, syncDir, syncItems);
  }

  static buildConflictFilePath(filePath, timestamp, label = "conflict") {
    return `${filePath}.${label}.${timestamp}`;
  }

  static getModePolicy(syncMode) {
    if (syncMode === "centralized") {
      return {
        mergeStrategy: "theirs",
        preserveSource: "local",
        conflictLabel: "local-conflict",
      };
    }

    return {
      mergeStrategy: "ours",
      preserveSource: "remote",
      conflictLabel: "conflict",
    };
  }

  static collectStatusFiles(status) {
    const files = new Set();
    const arrays = [
      status.not_added || [],
      status.created || [],
      status.deleted || [],
      status.modified || [],
      status.renamed || [],
      status.staged || [],
      status.conflicted || [],
    ];

    for (const entries of arrays) {
      for (const entry of entries) {
        if (!entry) continue;
        if (typeof entry === "string") {
          files.add(entry);
          continue;
        }
        if (entry.from) files.add(entry.from);
        if (entry.to) files.add(entry.to);
        if (entry.path) files.add(entry.path);
      }
    }

    return [...files];
  }

  log(...args) {
    if (this.debug) {
      console.log("[OpenClaw Sync (GitHub)]", ...args);
    }
  }

  error(...args) {
    this.lastError = args
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .join(" ");
    console.error("[OpenClaw Sync (GitHub)] ❌", ...args);
  }

  getStatus() {
    return {
      transport: "github",
      mode: this.syncMode,
      repo: this.githubRepo,
      syncDir: this.syncDir,
      openclawDir: this.openclawDir,
      syncItems: [...this.syncItems],
      isSyncing: this.isSyncing,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastConflictAt: this.lastConflictAt,
      lastConflictFiles: [...this.lastConflictFiles],
    };
  }

  pathExists(targetPath) {
    return fs.existsSync(targetPath);
  }

  copyEntry(sourcePath, targetPath, options = {}) {
    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.isDirectory()) {
      mirrorDirectory(sourcePath, targetPath, options);
      return;
    }

    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }

  async init() {
    try {
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        this.log("初始化本地 Git 仓库...");
        await this.git.init();
      }

      await this.ensureGitTransportConfig();
      await this.ensureRemote();
      await this.detectPrimaryBranch();
      await this.ensurePrimaryBranch();

      const hasRemoteBranch = await this.fetchRemoteBranch();

      if (hasRemoteBranch) {
        const localHeadExists = await this.localHeadExists();
        const hasSharedHistory = localHeadExists
          ? await this.hasSharedHistoryWithRemote()
          : false;

        if (!localHeadExists || !hasSharedHistory) {
          this.log(`建立远端 ${this.primaryBranch} 基线...`);
          await this.alignLocalRepoWithRemoteBranch();
        } else {
          this.log("拉取远程最新状态...");
          await this.git.pull("origin", this.primaryBranch, { "--no-rebase": null });
          await this.syncRepoToSources();
          this.log("✅ 拉取成功");
        }
      }

      await this.syncSourcesToRepo();
      await this.performSync();
      this.startWatching();
    } catch (err) {
      this.error("初始化失败:", err);
    }
  }

  async ensureRemote() {
    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === "origin");

    if (!origin) {
      await this.git.addRemote("origin", this.githubRepo);
      return;
    }

    if (origin.refs.fetch !== this.githubRepo) {
      await this.git.removeRemote("origin");
      await this.git.addRemote("origin", this.githubRepo);
    }
  }

  async ensureGitTransportConfig() {
    const entries = [
      ["http.version", "HTTP/1.1"],
      ["http.lowSpeedLimit", "0"],
      ["http.lowSpeedTime", "999999"],
    ];

    for (const [key, value] of entries) {
      try {
        await this.git.addConfig(key, value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/could not lock config file|permission denied/i.test(message)) {
          this.log(`跳过本地 Git 配置写入: ${key}`);
          continue;
        }
        throw error;
      }
    }
  }

  getRemoteBranchRef() {
    return `origin/${this.primaryBranch}`;
  }

  async detectPrimaryBranch() {
    try {
      const output = await this.git.raw(["ls-remote", "--symref", "origin", "HEAD"]);
      const match = output.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
      if (match && match[1]) {
        this.primaryBranch = match[1];
        return this.primaryBranch;
      }
    } catch (error) {
      void error;
    }

    for (const candidate of ["main", "master"]) {
      try {
        await this.git.raw(["ls-remote", "--exit-code", "--heads", "origin", candidate]);
        this.primaryBranch = candidate;
        return this.primaryBranch;
      } catch (error) {
        void error;
      }
    }

    this.primaryBranch = "main";
    return this.primaryBranch;
  }

  async ensurePrimaryBranch() {
    const primaryBranch = this.primaryBranch;
    const branches = await this.git.branchLocal();
    if (branches.current === primaryBranch) {
      return;
    }

    if (branches.all.includes(primaryBranch)) {
      await this.git.checkout(primaryBranch);
      return;
    }

    await this.git.checkoutLocalBranch(primaryBranch);
  }

  async remoteBranchExists() {
    try {
      await this.git.raw(["rev-parse", "--verify", this.getRemoteBranchRef()]);
      return true;
    } catch {
      return false;
    }
  }

  async localHeadExists() {
    try {
      await this.git.raw(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  async fetchRemoteBranch() {
    try {
      await this.git.fetch("origin", this.primaryBranch);
      return await this.remoteBranchExists();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (new RegExp(`couldn't find remote ref ${this.primaryBranch}`, "i").test(message)) {
        return false;
      }
      throw error;
    }
  }

  async hasSharedHistoryWithRemote() {
    if (!(await this.localHeadExists()) || !(await this.remoteBranchExists())) {
      return false;
    }

    try {
      const mergeBase = await this.git.raw([
        "merge-base",
        "HEAD",
        this.getRemoteBranchRef(),
      ]);
      return Boolean(String(mergeBase).trim());
    } catch {
      return false;
    }
  }

  async alignLocalRepoWithRemoteBranch() {
    if (!(await this.remoteBranchExists())) {
      return;
    }

    if (await this.localHeadExists()) {
      await this.git.checkout(this.primaryBranch);
      await this.git.reset(["--hard", this.getRemoteBranchRef()]);
      return;
    }

    await this.git.checkout(["-B", this.primaryBranch, this.getRemoteBranchRef()]);
  }

  getWatchPaths() {
    if (this.syncEntries.length > 0) {
      return this.syncEntries.map((entry) => entry.source);
    }

    return [this.syncDir];
  }

  startWatching() {
    const watchPaths = this.getWatchPaths();
    this.log(`开始监听目录变化: ${watchPaths.join(", ")}`);

    this.watcher = chokidar.watch(watchPaths, {
      ignored: (targetPath) =>
        targetPath.includes(`${path.sep}.git${path.sep}`) ||
        path.basename(targetPath) === ".git",
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    const triggerSync = (event, filePath) => {
      if (Date.now() < this.suspendWatchUntil) {
        return;
      }

      this.log(`检测到文件变化 [${event}]: ${filePath}`);

      if (this.syncTimeout) clearTimeout(this.syncTimeout);
      this.syncTimeout = setTimeout(() => this.performSync(), 2000);
    };

    this.watcher
      .on("add", (filePath) => triggerSync("add", filePath))
      .on("change", (filePath) => triggerSync("change", filePath))
      .on("unlink", (filePath) => triggerSync("unlink", filePath))
      .on("addDir", (filePath) => triggerSync("addDir", filePath))
      .on("unlinkDir", (filePath) => triggerSync("unlinkDir", filePath));
  }

  async syncSourcesToRepo() {
    if (this.syncEntries.length === 0) {
      return;
    }

    for (const entry of this.syncEntries) {
      if (!this.pathExists(entry.source)) {
        fs.rmSync(entry.target, { recursive: true, force: true });
        continue;
      }

      this.copyEntry(entry.source, entry.target);
    }
  }

  async syncRepoToSources() {
    if (this.syncEntries.length === 0) {
      return;
    }

    this.suspendWatchUntil = Date.now() + 4000;

    for (const entry of this.syncEntries) {
      if (!this.pathExists(entry.target)) {
        fs.rmSync(entry.source, { recursive: true, force: true });
        continue;
      }

      this.copyEntry(entry.target, entry.source, {
        preserveTargetEntries: true,
      });
    }
  }

  async getAheadBehind() {
    const output = await this.git.raw([
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${this.getRemoteBranchRef()}`,
    ]);
    const [aheadText = "0", behindText = "0"] = output.trim().split(/\s+/);

    return {
      ahead: Number.parseInt(aheadText, 10) || 0,
      behind: Number.parseInt(behindText, 10) || 0,
    };
  }

  async listChangedFiles(fromRef, toRef) {
    const output = await this.git.raw([
      "diff",
      "--name-only",
      `${fromRef}..${toRef}`,
    ]);

    return output
      .split(/\r?\n/)
      .map((filePath) => filePath.trim())
      .filter(Boolean);
  }

  async saveRemoteConflictFiles(filePaths, timestamp, label = "conflict") {
    const writtenFiles = [];

    for (const filePath of filePaths) {
      try {
        const remoteContent = await this.git.raw([
          "show",
          `${this.getRemoteBranchRef()}:${filePath.replace(/\\/g, "/")}`,
        ]);
        const conflictPath = path.join(
          this.syncDir,
          GitSyncService.buildConflictFilePath(filePath, timestamp, label),
        );

        fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
        fs.writeFileSync(conflictPath, remoteContent);
        writtenFiles.push(
          GitSyncService.buildConflictFilePath(filePath, timestamp, label),
        );
      } catch {
        continue;
      }
    }

    return writtenFiles;
  }

  async saveLocalConflictFiles(filePaths, timestamp, label = "local-conflict") {
    const writtenFiles = [];

    for (const filePath of filePaths) {
      const sourcePath = path.join(this.syncDir, filePath);

      if (!this.pathExists(sourcePath)) {
        continue;
      }

      const sourceStat = fs.statSync(sourcePath);
      if (!sourceStat.isFile()) {
        continue;
      }

      const conflictPath = path.join(
        this.syncDir,
        GitSyncService.buildConflictFilePath(filePath, timestamp, label),
      );

      fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
      fs.copyFileSync(sourcePath, conflictPath);
      writtenFiles.push(
        GitSyncService.buildConflictFilePath(filePath, timestamp, label),
      );
    }

    return writtenFiles;
  }

  async commitAllChanges(message) {
    await this.git.add(".");
    const status = await this.git.status();

    if (status.isClean()) {
      return false;
    }

    await this.git.commit(message);
    return true;
  }

  async performSync() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      this.lastError = null;
      await this.detectPrimaryBranch();
      await this.ensurePrimaryBranch();
      const hasRemoteBranch = await this.fetchRemoteBranch();

      if (hasRemoteBranch && !(await this.hasSharedHistoryWithRemote())) {
        this.log(`检测到本地同步仓库与远端 ${this.primaryBranch} 分叉，重新对齐远端基线...`);
        await this.alignLocalRepoWithRemoteBranch();
      }

      await this.syncSourcesToRepo();

      const timestamp = new Date().toISOString().replace(/[:]/g, "-");
      const modePolicy = GitSyncService.getModePolicy(this.syncMode);
      const initialStatus = await this.git.status();
      const localChangedFiles = GitSyncService.collectStatusFiles(initialStatus);
      const hadLocalChanges = !initialStatus.isClean();

      if (hadLocalChanges) {
        this.log("检测到本地更改，准备提交...");
        await this.commitAllChanges(`Auto-sync: ${timestamp} via OpenClaw`);
      }

      if (hasRemoteBranch) {
        const { behind } = await this.getAheadBehind();

        if (behind > 0) {
          const remoteChangedFiles = await this.listChangedFiles(
            "HEAD",
            this.getRemoteBranchRef(),
          );
          const conflictCandidates = remoteChangedFiles.filter((filePath) =>
            localChangedFiles.includes(filePath),
          );

          if (
            modePolicy.preserveSource === "local" &&
            conflictCandidates.length > 0
          ) {
            this.lastConflictFiles = await this.saveLocalConflictFiles(
              conflictCandidates,
              timestamp,
              modePolicy.conflictLabel,
            );
            this.lastConflictAt =
              this.lastConflictFiles.length > 0 ? new Date().toISOString() : null;
          }

          await this.git.merge([
            "-X",
            modePolicy.mergeStrategy,
            this.getRemoteBranchRef(),
          ]);

          if (
            modePolicy.preserveSource === "remote" &&
            conflictCandidates.length > 0
          ) {
            this.lastConflictFiles = await this.saveRemoteConflictFiles(
              conflictCandidates,
              timestamp,
              modePolicy.conflictLabel,
            );

            this.lastConflictAt =
              this.lastConflictFiles.length > 0 ? new Date().toISOString() : null;

            if (this.lastConflictFiles.length > 0) {
              await this.commitAllChanges(
                `Preserve remote conflicts: ${timestamp}`,
              );
            }
          }

          await this.syncRepoToSources();
        }
      }

      const committed = await this.commitAllChanges(
        `Auto-sync: ${timestamp} via OpenClaw`,
      );

      if (committed || hadLocalChanges || (await this.remoteBranchExists())) {
        await this.git.push("origin", this.primaryBranch);
        this.log("✅ 同步推送成功！");
      } else {
        this.log("没有需要提交的更改");
      }

      this.lastSyncAt = new Date().toISOString();
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
