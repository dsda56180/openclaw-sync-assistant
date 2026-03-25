const chokidar = require("chokidar");
const Corestore = require("corestore");
const fs = require("fs");
const Hyperdrive = require("hyperdrive");
const Hyperswarm = require("hyperswarm");
const Localdrive = require("localdrive");
const path = require("path");
const { createHash } = require("crypto");
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

class P2PSyncService {
  constructor(syncDir, syncSecret, syncMode, options = {}, debug = false) {
    if (typeof options === "boolean") {
      debug = options;
      options = {};
    }

    this.syncDir = syncDir;
    this.syncSecret = syncSecret;
    this.syncMode = syncMode;
    this.debug = debug;
    this.openclawDir = options.openclawDir || path.dirname(syncDir);
    this.syncItems = P2PSyncService.normalizeSyncItems(options.syncItems);
    this.syncEntries = P2PSyncService.resolveSyncEntries(
      this.openclawDir,
      this.syncDir,
      this.syncItems,
    );
    this.storageDir =
      options.storageDir || path.join(this.syncDir, ".p2p-storage");
    this.watcher = null;
    this.remoteWatcher = null;
    this.swarm = null;
    this.discovery = null;
    this.store = null;
    this.drive = null;
    this.localDrive = null;
    this.syncTimeout = null;
    this.remoteSyncTimeout = null;
    this.isSyncing = false;
    this.pendingSyncReason = null;
    this.suspendWatchUntil = 0;
    this.suspendRemoteWatchUntil = 0;
    this.stopped = false;
    this.lastSyncAt = null;
    this.lastSyncDirection = null;
    this.lastError = null;
    this.lastConflictFiles = [];
    this.lastConflictAt = null;
    this.lastAppliedRemoteVersion = -1;

    fs.mkdirSync(this.syncDir, { recursive: true });
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  static normalizeSyncItems(syncItems) {
    return normalizeSyncItems(syncItems);
  }

  static resolveSyncEntries(openclawDir, syncDir, syncItems) {
    return resolveSyncEntries(openclawDir, syncDir, syncItems);
  }

  static derivePrimaryKey(syncSecret) {
    return createHash("sha256")
      .update(String(syncSecret || ""))
      .digest();
  }

  static buildConflictFilePath(filePath, timestamp, label = "local-conflict") {
    return `${filePath}.${label}.${timestamp}`;
  }

  static isConflictFile(filePath) {
    return /\.(?:conflict|local-conflict|peer-conflict)\./.test(filePath);
  }

  static getModePolicy(syncMode) {
    if (syncMode === "centralized") {
      return {
        startupSync: "pull-first",
      };
    }

    return {
      startupSync: "push-first",
    };
  }

  log(...args) {
    if (this.debug) {
      console.log("[OpenClaw Sync (P2P)]", ...args);
    }
  }

  error(...args) {
    this.lastError = args
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .join(" ");
    console.error("[OpenClaw Sync (P2P)] ❌", ...args);
  }

  getStatus() {
    return {
      transport: "p2p",
      mode: this.syncMode,
      syncDir: this.syncDir,
      openclawDir: this.openclawDir,
      syncItems: [...this.syncItems],
      discoveryKey: this.drive ? this.drive.discoveryKey.toString("hex") : null,
      driveVersion: this.drive ? this.drive.version : 0,
      peerCount: this.swarm ? this.swarm.connections.size : 0,
      isSyncing: this.isSyncing,
      lastSyncAt: this.lastSyncAt,
      lastSyncDirection: this.lastSyncDirection,
      lastError: this.lastError,
      lastConflictAt: this.lastConflictAt,
      lastConflictFiles: [...this.lastConflictFiles],
    };
  }

  pathExists(targetPath) {
    return fs.existsSync(targetPath);
  }

  buildFileSignature(filePath) {
    const stat = fs.statSync(filePath);

    if (!stat.isFile()) {
      return null;
    }

    const digest = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");

    return `${stat.size}:${digest}`;
  }

  collectFileSignatures(rootPath, relativePrefix = "") {
    const signatures = new Map();

    if (!this.pathExists(rootPath)) {
      return signatures;
    }

    const walk = (currentPath, nestedRelativePath = "") => {
      const stat = fs.statSync(currentPath);

      if (stat.isDirectory()) {
        for (const childName of fs.readdirSync(currentPath)) {
          walk(
            path.join(currentPath, childName),
            path.join(nestedRelativePath, childName),
          );
        }
        return;
      }

      if (!stat.isFile()) {
        return;
      }

      const relativePath = path.join(relativePrefix, nestedRelativePath);
      if (P2PSyncService.isConflictFile(relativePath)) {
        return;
      }

      const signature = this.buildFileSignature(currentPath);
      if (signature) {
        signatures.set(relativePath, signature);
      }
    };

    walk(rootPath);
    return signatures;
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

  getWatchPaths() {
    if (this.syncEntries.length > 0) {
      return this.syncEntries.map((entry) => entry.source);
    }

    return [this.syncDir];
  }

  async init() {
    try {
      if (!this.syncSecret || !this.syncSecret.trim()) {
        throw new Error("P2P 模式需要配置 syncSecret");
      }

      this.store = new Corestore(this.storageDir, {
        primaryKey: P2PSyncService.derivePrimaryKey(this.syncSecret.trim()),
      });
      this.drive = new Hyperdrive(
        this.store.namespace("openclaw-sync-assistant"),
      );
      this.localDrive = new Localdrive(this.syncDir);

      await this.drive.ready();
      this.lastAppliedRemoteVersion = this.drive.version;

      this.swarm = new Hyperswarm();
      this.swarm.on("connection", (connection, peerInfo) => {
        this.log(
          `已连接 P2P 节点: ${peerInfo.publicKey.toString("hex").slice(0, 12)}`,
        );
        this.store.replicate(connection);
        this.scheduleRemoteSync(1500);
      });

      this.discovery = this.swarm.join(this.drive.discoveryKey, {
        server: true,
        client: true,
      });
      await this.discovery.flushed();
      await this.swarm.flush();

      await this.performSync(this.getModePolicy().startupSync);
      this.startWatching();
      this.startRemoteWatching();
      this.log(`P2P 发现主题已启动: ${this.drive.discoveryKey.toString("hex")}`);
    } catch (err) {
      this.error("初始化失败:", err);
    }
  }

  getModePolicy() {
    return P2PSyncService.getModePolicy(this.syncMode);
  }

  startWatching() {
    const watchPaths = this.getWatchPaths();
    this.log(`开始监听目录变化: ${watchPaths.join(", ")}`);

    this.watcher = chokidar.watch(watchPaths, {
      ignored: (targetPath) =>
        targetPath.includes(`${path.sep}.git${path.sep}`) ||
        targetPath.includes(`${path.sep}.p2p-storage${path.sep}`) ||
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

      this.log(`检测到本地文件变化 [${event}]: ${filePath}`);
      this.scheduleLocalSync(1500);
    };

    this.watcher
      .on("add", (filePath) => triggerSync("add", filePath))
      .on("change", (filePath) => triggerSync("change", filePath))
      .on("unlink", (filePath) => triggerSync("unlink", filePath))
      .on("addDir", (filePath) => triggerSync("addDir", filePath))
      .on("unlinkDir", (filePath) => triggerSync("unlinkDir", filePath));
  }

  startRemoteWatching() {
    if (!this.drive) {
      return;
    }

    this.remoteWatcher = this.drive.watch("/");

    const loop = async () => {
      await this.remoteWatcher.ready();

      for await (const change of this.remoteWatcher) {
        if (this.stopped) {
          return;
        }

        if (!change) {
          continue;
        }

        if (Date.now() < this.suspendRemoteWatchUntil) {
          continue;
        }

        this.log("检测到远端 Hyperdrive 变化");
        this.scheduleRemoteSync(1500);
      }
    };

    loop().catch((err) => {
      if (!this.stopped) {
        this.error("远端监听失败:", err);
      }
    });
  }

  scheduleLocalSync(delay = 1000) {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(() => {
      this.performSync("push");
    }, delay);
  }

  scheduleRemoteSync(delay = 1000) {
    if (this.remoteSyncTimeout) {
      clearTimeout(this.remoteSyncTimeout);
    }

    this.remoteSyncTimeout = setTimeout(() => {
      this.performSync("pull");
    }, delay);
  }

  async getLocalConflictCandidates() {
    const candidates = new Set();

    for (const entry of this.syncEntries) {
      const relativeRoot = path.relative(this.syncDir, entry.target);
      const sourceSignatures = this.collectFileSignatures(
        entry.source,
        relativeRoot,
      );
      const targetSignatures = this.collectFileSignatures(
        entry.target,
        relativeRoot,
      );
      const filePaths = new Set([
        ...sourceSignatures.keys(),
        ...targetSignatures.keys(),
      ]);

      for (const filePath of filePaths) {
        const sourceSignature = sourceSignatures.get(filePath) || null;
        const targetSignature = targetSignatures.get(filePath) || null;

        if (sourceSignature && sourceSignature !== targetSignature) {
          candidates.add(filePath);
        }
      }
    }

    return [...candidates];
  }

  async preserveLocalConflictFiles(
    filePaths,
    timestamp,
    label = "local-conflict",
  ) {
    const writtenFiles = [];

    for (const filePath of filePaths) {
      const sourcePath = path.join(this.openclawDir, filePath);

      if (!this.pathExists(sourcePath)) {
        continue;
      }

      const sourceStat = fs.statSync(sourcePath);
      if (!sourceStat.isFile()) {
        continue;
      }

      const conflictPath = path.join(
        this.openclawDir,
        P2PSyncService.buildConflictFilePath(filePath, timestamp, label),
      );

      fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
      fs.copyFileSync(sourcePath, conflictPath);
      writtenFiles.push(
        P2PSyncService.buildConflictFilePath(filePath, timestamp, label),
      );
    }

    return writtenFiles;
  }

  hasRemoteDelta() {
    return this.drive && this.drive.version > this.lastAppliedRemoteVersion;
  }

  async hasRemoteEntries() {
    for await (const _ of this.drive.entries()) {
      return true;
    }

    return false;
  }

  async syncSourcesToStage() {
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

  async syncStageToSources() {
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

  async syncStageToDrive() {
    this.suspendRemoteWatchUntil = Date.now() + 4000;
    const mirror = this.localDrive.mirror(this.drive);
    await mirror.done();
    this.lastAppliedRemoteVersion = this.drive.version;
  }

  async syncDriveToStage() {
    this.suspendWatchUntil = Date.now() + 4000;
    const mirror = this.drive.mirror(this.localDrive);
    await mirror.done();
    this.lastAppliedRemoteVersion = this.drive.version;
  }

  async performSync(reason = "push") {
    if (this.isSyncing) {
      this.pendingSyncReason = reason;
      return;
    }

    this.isSyncing = true;

    try {
      this.lastError = null;
      const hasRemoteEntries = await this.hasRemoteEntries();
      const timestamp = new Date().toISOString().replace(/[:]/g, "-");
      const modePolicy = this.getModePolicy();

      if (reason === "pull-first") {
        if (hasRemoteEntries) {
          if (this.hasRemoteDelta()) {
            const conflictFiles = await this.getLocalConflictCandidates();
            this.lastConflictFiles = await this.preserveLocalConflictFiles(
              conflictFiles,
              timestamp,
              "local-conflict",
            );
            this.lastConflictAt =
              this.lastConflictFiles.length > 0 ? new Date().toISOString() : null;
          }

          await this.syncDriveToStage();
          await this.syncStageToSources();
        } else {
          await this.syncSourcesToStage();
          await this.syncStageToDrive();
        }
      } else if (reason === "push-first") {
        await this.syncSourcesToStage();
        await this.syncStageToDrive();
        await this.syncDriveToStage();
        await this.syncStageToSources();
      } else if (reason === "pull") {
        if (!hasRemoteEntries) {
          return;
        }

        if (this.hasRemoteDelta()) {
          const conflictFiles = await this.getLocalConflictCandidates();
          this.lastConflictFiles = await this.preserveLocalConflictFiles(
            conflictFiles,
            timestamp,
            modePolicy.startupSync === "pull-first"
              ? "local-conflict"
              : "peer-conflict",
          );
          this.lastConflictAt =
            this.lastConflictFiles.length > 0 ? new Date().toISOString() : null;
        }

        await this.syncDriveToStage();
        await this.syncStageToSources();
      } else {
        await this.syncSourcesToStage();
        await this.syncStageToDrive();
      }

      if (reason === "push" || reason === "push-first") {
        this.lastConflictFiles = [];
        this.lastConflictAt = null;
      }

      this.lastSyncAt = new Date().toISOString();
      this.lastSyncDirection = reason;
    } catch (err) {
      this.error("同步失败:", err);
    } finally {
      this.isSyncing = false;

      if (this.pendingSyncReason) {
        const nextReason = this.pendingSyncReason;
        this.pendingSyncReason = null;
        await this.performSync(nextReason);
      }
    }
  }

  async stop() {
    this.stopped = true;

    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    if (this.remoteSyncTimeout) {
      clearTimeout(this.remoteSyncTimeout);
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    if (this.remoteWatcher) {
      await this.remoteWatcher.destroy();
      this.remoteWatcher = null;
    }

    if (this.discovery) {
      await this.discovery.destroy();
      this.discovery = null;
    }

    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }

    if (this.drive) {
      await this.drive.close();
      this.drive = null;
    }

    if (this.store) {
      await this.store.close();
      this.store = null;
    }
  }
}

module.exports = P2PSyncService;
