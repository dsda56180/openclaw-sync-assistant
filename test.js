const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const plugin = require("./index.js");
const GitSyncService = require("./src/github-sync");
const P2PSyncService = require("./src/p2p-sync");
const { resolveSyncEntries } = require("./src/sync-items");

async function main() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "openclaw-sync-assistant-"),
  );
  const tempSyncDir = path.join(tempRoot, "sync");
  const tempP2pDir = path.join(tempRoot, "p2p");
  const conflictFilePath = path.join(
    tempRoot,
    "workspace",
    "state.json.local-conflict.2026-03-24T16-00-00.000Z",
  );
  const syncConflictFilePath = path.join(
    tempRoot,
    "sync-data",
    "config",
    "settings.json.conflict.2026-03-24T16-00-00.000Z",
  );

  fs.mkdirSync(path.dirname(conflictFilePath), { recursive: true });
  fs.mkdirSync(path.dirname(syncConflictFilePath), { recursive: true });
  fs.writeFileSync(conflictFilePath, "local");
  fs.writeFileSync(syncConflictFilePath, "remote");

  const commandContext = {
    api: {
      config: {
        get(key) {
          const values = {
            "openclaw-sync-assistant.syncMethod": "github",
            "openclaw-sync-assistant.githubRepo":
              "https://github.com/demo/repo.git",
            "openclaw-sync-assistant.syncMode": "decentralized",
            "openclaw-sync-assistant.syncSecret": null,
            "openclaw-sync-assistant.syncItems": ["Config"],
          };
          return values[key];
        },
      },
      paths: {
        stateDir: path.join(tempRoot, "runtime-state"),
      },
    },
  };

  assert.ok(plugin !== undefined, "Plugin module should be exported properly");
  assert.strictEqual(
    plugin.getSyncStatus(),
    null,
    "plugin.getSyncStatus should return null when no service is active",
  );
  assert.deepStrictEqual(
    GitSyncService.normalizeSyncItems([
      "Config",
      "Workspace",
      "Config",
      "Unknown",
    ]),
    ["Config", "WorkspaceFiles"],
    "normalizeSyncItems should filter invalid items and deduplicate",
  );
  assert.deepStrictEqual(
    resolveSyncEntries(
      "C:\\Users\\demo\\.openclaw",
      "C:\\Users\\demo\\.openclaw\\sync-data",
      ["Config", "Sessions"],
    ),
    [
      {
        item: "Config",
        relativePath: "config",
        source: "C:\\Users\\demo\\.openclaw\\config",
        target: "C:\\Users\\demo\\.openclaw\\sync-data\\config",
      },
      {
        item: "Config",
        relativePath: "openclaw.json",
        source: "C:\\Users\\demo\\.openclaw\\openclaw.json",
        target: "C:\\Users\\demo\\.openclaw\\sync-data\\openclaw.json",
      },
      {
        item: "Sessions",
        relativePath: "sessions",
        source: "C:\\Users\\demo\\.openclaw\\sessions",
        target: "C:\\Users\\demo\\.openclaw\\sync-data\\sessions",
      },
      {
        item: "Sessions",
        relativePath: "history",
        source: "C:\\Users\\demo\\.openclaw\\history",
        target: "C:\\Users\\demo\\.openclaw\\sync-data\\history",
      },
      {
        item: "Sessions",
        relativePath: "agent-state",
        source: "C:\\Users\\demo\\.openclaw\\agent-state",
        target: "C:\\Users\\demo\\.openclaw\\sync-data\\agent-state",
      },
    ],
    "resolveSyncEntries should expand sync items into source and target paths",
  );
  assert.strictEqual(
    GitSyncService.buildConflictFilePath(
      "workspace\\state.json",
      "2026-03-24T16-00-00.000Z",
    ),
    "workspace\\state.json.conflict.2026-03-24T16-00-00.000Z",
    "buildConflictFilePath should append the conflict suffix",
  );
  assert.strictEqual(
    GitSyncService.buildConflictFilePath(
      "config\\settings.json",
      "2026-03-24T16-00-00.000Z",
      "local-conflict",
    ),
    "config\\settings.json.local-conflict.2026-03-24T16-00-00.000Z",
    "buildConflictFilePath should support custom conflict labels",
  );
  assert.deepStrictEqual(
    GitSyncService.getModePolicy("centralized"),
    {
      mergeStrategy: "theirs",
      preserveSource: "local",
      conflictLabel: "local-conflict",
    },
    "centralized mode should prefer remote state and preserve local conflicts",
  );
  assert.deepStrictEqual(
    GitSyncService.getModePolicy("decentralized"),
    {
      mergeStrategy: "ours",
      preserveSource: "remote",
      conflictLabel: "conflict",
    },
    "decentralized mode should preserve remote conflicts and keep local changes",
  );
  assert.deepStrictEqual(
    new GitSyncService(
      tempSyncDir,
      "https://github.com/demo/repo.git",
      "decentralized",
      {
        openclawDir: tempRoot,
        syncItems: ["Config"],
      },
    ).getStatus(),
    {
      transport: "github",
      mode: "decentralized",
      repo: "https://github.com/demo/repo.git",
      syncDir: tempSyncDir,
      openclawDir: tempRoot,
      syncItems: ["Config"],
      isSyncing: false,
      lastSyncAt: null,
      lastError: null,
      lastConflictAt: null,
      lastConflictFiles: [],
    },
    "GitSyncService should expose an initial status snapshot",
  );
  const tempMirrorRoot = path.join(tempRoot, "mirror-case");
  const tempMirrorSyncDir = path.join(tempMirrorRoot, "sync");
  const workspaceDir = path.join(tempMirrorRoot, "workspace");
  const workspaceGitDir = path.join(workspaceDir, ".git");
  fs.mkdirSync(workspaceGitDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceGitDir, "HEAD"), "ref: refs/heads/main");
  fs.writeFileSync(path.join(workspaceDir, "USER.md"), "local-user");
  const gitMirrorService = new GitSyncService(
    tempMirrorSyncDir,
    "https://github.com/demo/repo.git",
    "decentralized",
    {
      openclawDir: tempMirrorRoot,
      syncItems: ["WorkspaceFiles"],
    },
  );
  await gitMirrorService.syncSourcesToRepo();
  assert.strictEqual(
    fs.existsSync(path.join(tempMirrorSyncDir, "workspace", ".git")),
    false,
    "syncSourcesToRepo should not copy nested git metadata into the sync repository",
  );
  assert.strictEqual(
    fs.readFileSync(path.join(tempMirrorSyncDir, "workspace", "USER.md"), "utf8"),
    "local-user",
    "syncSourcesToRepo should still copy regular workspace files",
  );
  fs.mkdirSync(path.join(tempMirrorSyncDir, "workspace", ".git"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(tempMirrorSyncDir, "workspace", ".git", "HEAD"),
    "ref: refs/heads/stale",
  );
  await gitMirrorService.syncSourcesToRepo();
  assert.strictEqual(
    fs.existsSync(path.join(tempMirrorSyncDir, "workspace", ".git")),
    false,
    "syncSourcesToRepo should remove stale nested git metadata from the sync repository",
  );
  fs.writeFileSync(path.join(workspaceDir, "STALE.md"), "stale");
  fs.writeFileSync(path.join(tempMirrorSyncDir, "workspace", "USER.md"), "remote-user");
  await gitMirrorService.syncRepoToSources();
  assert.strictEqual(
    fs.existsSync(path.join(workspaceGitDir, "HEAD")),
    true,
    "syncRepoToSources should preserve nested local git metadata",
  );
  assert.strictEqual(
    fs.readFileSync(path.join(workspaceDir, "USER.md"), "utf8"),
    "remote-user",
    "syncRepoToSources should apply synced workspace changes",
  );
  assert.strictEqual(
    fs.existsSync(path.join(workspaceDir, "STALE.md")),
    false,
    "syncRepoToSources should remove stale mirrored files while preserving .git",
  );
  assert.deepStrictEqual(
    P2PSyncService.normalizeSyncItems(["Auth", "Auth", "Workspace", "Unknown"]),
    ["Auth", "WorkspaceFiles"],
    "P2PSyncService should normalize sync items the same way",
  );
  assert.deepStrictEqual(
    P2PSyncService.getModePolicy("centralized"),
    {
      startupSync: "pull-first",
    },
    "centralized P2P mode should prefer remote startup state",
  );
  assert.deepStrictEqual(
    P2PSyncService.getModePolicy("decentralized"),
    {
      startupSync: "push-first",
    },
    "decentralized P2P mode should prefer local startup state",
  );
  assert.strictEqual(
    P2PSyncService.derivePrimaryKey("shared-secret").length,
    32,
    "derivePrimaryKey should return a 32-byte key",
  );
  assert.strictEqual(
    P2PSyncService.buildConflictFilePath(
      "workspace\\state.json",
      "2026-03-24T16-00-00.000Z",
      "peer-conflict",
    ),
    "workspace\\state.json.peer-conflict.2026-03-24T16-00-00.000Z",
    "P2PSyncService should support custom conflict labels",
  );
  assert.strictEqual(
    P2PSyncService.isConflictFile(
      "workspace\\state.json.local-conflict.2026-03-24T16-00-00.000Z",
    ),
    true,
    "P2PSyncService should detect generated conflict files",
  );
  assert.deepStrictEqual(
    new P2PSyncService(tempP2pDir, "shared-secret", "centralized", {
      openclawDir: tempRoot,
      syncItems: ["Workspace"],
    }).getStatus(),
    {
      transport: "p2p",
      mode: "centralized",
      syncDir: tempP2pDir,
      openclawDir: tempRoot,
      syncItems: ["WorkspaceFiles"],
      discoveryKey: null,
      driveVersion: 0,
      peerCount: 0,
      isSyncing: false,
      lastSyncAt: null,
      lastSyncDirection: null,
      lastError: null,
      lastConflictAt: null,
      lastConflictFiles: [],
    },
    "P2PSyncService should expose an initial status snapshot",
  );
  const tempP2pMirrorRoot = path.join(tempRoot, "p2p-mirror-case");
  const tempP2pMirrorSyncDir = path.join(tempP2pMirrorRoot, "sync");
  const p2pWorkspaceDir = path.join(tempP2pMirrorRoot, "workspace");
  const p2pWorkspaceGitDir = path.join(p2pWorkspaceDir, ".git");
  fs.mkdirSync(p2pWorkspaceGitDir, { recursive: true });
  fs.writeFileSync(path.join(p2pWorkspaceGitDir, "HEAD"), "ref: refs/heads/main");
  fs.writeFileSync(path.join(p2pWorkspaceDir, "USER.md"), "local-p2p");
  const p2pMirrorService = new P2PSyncService(
    tempP2pMirrorSyncDir,
    "shared-secret",
    "centralized",
    {
      openclawDir: tempP2pMirrorRoot,
      syncItems: ["WorkspaceFiles"],
    },
  );
  await p2pMirrorService.syncSourcesToStage();
  assert.strictEqual(
    fs.existsSync(path.join(tempP2pMirrorSyncDir, "workspace", ".git")),
    false,
    "P2PSyncService should not copy nested git metadata into the sync mirror",
  );
  fs.mkdirSync(path.join(tempP2pMirrorSyncDir, "workspace", ".git"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(tempP2pMirrorSyncDir, "workspace", ".git", "HEAD"),
    "ref: refs/heads/stale",
  );
  await p2pMirrorService.syncSourcesToStage();
  assert.strictEqual(
    fs.existsSync(path.join(tempP2pMirrorSyncDir, "workspace", ".git")),
    false,
    "P2PSyncService should remove stale nested git metadata from the sync mirror",
  );
  fs.writeFileSync(path.join(p2pWorkspaceDir, "STALE.md"), "stale");
  fs.writeFileSync(
    path.join(tempP2pMirrorSyncDir, "workspace", "USER.md"),
    "remote-p2p",
  );
  await p2pMirrorService.syncStageToSources();
  assert.strictEqual(
    fs.existsSync(path.join(p2pWorkspaceGitDir, "HEAD")),
    true,
    "P2PSyncService should preserve nested local git metadata",
  );
  assert.strictEqual(
    fs.readFileSync(path.join(p2pWorkspaceDir, "USER.md"), "utf8"),
    "remote-p2p",
    "P2PSyncService should apply mirrored workspace changes",
  );
  assert.strictEqual(
    fs.existsSync(path.join(p2pWorkspaceDir, "STALE.md")),
    false,
    "P2PSyncService should remove stale mirrored files while preserving .git",
  );
  assert.strictEqual(
    plugin.formatSyncStatus(null),
    "同步服务尚未启动。",
    "formatSyncStatus should handle missing status",
  );
  assert.ok(
    plugin
      .formatSyncStatus({
        transport: "p2p",
        mode: "centralized",
        syncDir: tempP2pDir,
        syncItems: ["Workspace"],
        openclawDir: tempRoot,
        isSyncing: false,
        lastSyncAt: null,
        discoveryKey: "abcdef",
        peerCount: 1,
        driveVersion: 7,
        lastSyncDirection: "pull",
        lastConflictAt: null,
        lastConflictFiles: [],
        lastError: null,
      })
      .includes("连接节点: 1"),
    "formatSyncStatus should include transport-specific details",
  );
  assert.strictEqual(
    plugin.isConflictFile(path.basename(conflictFilePath)),
    true,
    "isConflictFile should match generated conflict filenames",
  );
  assert.deepStrictEqual(
    plugin.collectConflictFiles(tempRoot).sort(),
    [conflictFilePath, syncConflictFilePath].sort(),
    "collectConflictFiles should scan nested conflict files",
  );
  assert.deepStrictEqual(
    plugin.parseConflictFileDetails(
      "workspace\\state.json.local-conflict.2026-03-24T16-00-00.000Z",
    ),
    {
      baseRelativePath: "workspace\\state.json",
      conflictLabel: "local-conflict",
      conflictTimestamp: "2026-03-24T16-00-00.000Z",
    },
    "parseConflictFileDetails should expose the base file path and suffix metadata",
  );
  assert.deepStrictEqual(
    plugin.getFileMetadata(path.join(tempRoot, "missing.txt")),
    {
      exists: false,
      size: null,
      modifiedAt: null,
    },
    "getFileMetadata should report missing files",
  );
  assert.deepStrictEqual(
    plugin.assessExperienceConsistency(["Config", "Workspace"]),
    {
      level: "partial",
      selectedItems: ["Config", "WorkspaceFiles"],
      recommendedItems: [
        "Config",
        "Auth",
        "Sessions",
        "ChannelState",
        "WorkspaceFiles",
      ],
      missingItems: ["Auth", "Sessions", "ChannelState"],
      coverageRatio: 2 / 5,
    },
    "assessExperienceConsistency should report missing experience-critical items",
  );
  assert.strictEqual(
    plugin.formatExperienceConsistencySummary(
      plugin.assessExperienceConsistency([
        "Config",
        "Auth",
        "Sessions",
        "ChannelState",
        "WorkspaceFiles",
      ]),
    ),
    "完整",
    "formatExperienceConsistencySummary should mark full coverage as complete",
  );
  fs.mkdirSync(path.join(tempRoot, "config"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "workspace"), { recursive: true });
  const baseline = plugin.assessExperienceBaseline(tempRoot, [
    "Config",
    "Auth",
    "Workspace",
  ]);
  assert.deepStrictEqual(
    {
      rootDir: baseline.rootDir,
      rootExists: baseline.rootExists,
      level: baseline.level,
      selectedItems: baseline.selectedItems,
      presentSelectedItems: baseline.presentSelectedItems,
      missingSelectedItems: baseline.missingSelectedItems,
      selectedCount: baseline.selectedCount,
      presentCount: baseline.presentCount,
    },
    {
      rootDir: tempRoot,
      rootExists: true,
      level: "partial",
      selectedItems: ["Config", "Auth", "WorkspaceFiles"],
      presentSelectedItems: ["Config", "WorkspaceFiles"],
      missingSelectedItems: ["Auth"],
      selectedCount: 3,
      presentCount: 2,
    },
    "assessExperienceBaseline should report selected item coverage under a state directory",
  );
  assert.deepStrictEqual(
    baseline.items.find((entry) => entry.item === "WorkspaceFiles")?.matchedPaths,
    ["workspace"],
    "assessExperienceBaseline should expose matched paths for composite sync items",
  );
  assert.strictEqual(
    plugin.formatExperienceBaselineSummary(
      plugin.assessExperienceBaseline(tempRoot, ["Config", "Workspace"]),
    ),
    "完整 (2/2)",
    "formatExperienceBaselineSummary should show fully ready selected items",
  );
  assert.deepStrictEqual(
    plugin.planConflictResolution(
      [
        { filePath: conflictFilePath },
        { filePath: syncConflictFilePath },
      ],
      {
        strategy: "cleanup",
        conflictFiles: [syncConflictFilePath],
      },
    ),
    {
      strategy: "cleanup",
      conflicts: [{ filePath: syncConflictFilePath }],
    },
    "planConflictResolution should filter selected conflict files",
  );
  assert.deepStrictEqual(
    plugin.listConflictScopes([
      { scope: "openclaw" },
      { scope: "sync" },
      { scope: "openclaw" },
    ]),
    ["openclaw", "sync"],
    "listConflictScopes should deduplicate available scopes",
  );
  assert.deepStrictEqual(
    plugin.planConflictResolution(
      [
        { scope: "openclaw", filePath: conflictFilePath },
        { scope: "sync", filePath: syncConflictFilePath },
      ],
      {
        strategy: "cleanup",
        scopes: ["sync"],
      },
    ),
    {
      strategy: "cleanup",
      conflicts: [{ scope: "sync", filePath: syncConflictFilePath }],
    },
    "planConflictResolution should respect selected scopes",
  );
  assert.ok(
    plugin
      .formatConflictResolutionPreview({
        strategy: "accept-conflict-copy",
        conflicts: [
          {
            scope: "sync",
            relativePath: "config\\settings.json.local-conflict.2026-03-24T16-00-00.000Z",
            baseRelativePath: "config\\settings.json",
            targetFileStats: {
              exists: true,
              size: 3,
              modifiedAt: "2026-03-24T10:00:00.000Z",
            },
            conflictFileStats: {
              exists: true,
              size: 6,
              modifiedAt: "2026-03-24T10:05:00.000Z",
            },
          },
        ],
      })
      .includes("风险提示: 将尝试覆盖 1 个正式文件"),
    "formatConflictResolutionPreview should describe overwrite actions",
  );
  assert.ok(
    plugin
      .formatConflictResolutionPreview({
        strategy: "accept-conflict-copy",
        conflicts: [
          {
            scope: "sync",
            relativePath: "config\\settings.json.local-conflict.2026-03-24T16-00-00.000Z",
            baseRelativePath: "config\\settings.json",
            targetFileStats: {
              exists: true,
              size: 3,
              modifiedAt: "2026-03-24T10:00:00.000Z",
            },
            conflictFileStats: {
              exists: true,
              size: 6,
              modifiedAt: "2026-03-24T10:05:00.000Z",
            },
          },
        ],
      })
      .includes("目标文件: 3 B, 2026-03-24T10:00:00.000Z"),
    "formatConflictResolutionPreview should include target file metadata",
  );
  assert.ok(
    plugin
      .formatConflictStatus([
        {
          scope: "openclaw",
          relativePath:
            "workspace\\state.json.local-conflict.2026-03-24T16-00-00.000Z",
          filePath: conflictFilePath,
        },
      ])
      .includes("[openclaw]"),
    "formatConflictStatus should include scope labels",
  );
  assert.strictEqual(
    await plugin.executeCommand("sync.status"),
    "同步服务尚未启动。",
    "sync.status should return a readable empty-state message",
  );
  assert.ok(
    plugin
      .formatSyncStatus({
        transport: "github",
        mode: "decentralized",
        syncDir: path.join(tempRoot, "sync-data"),
        openclawDir: tempRoot,
        syncItems: ["Config", "Workspace"],
        isSyncing: false,
        lastSyncAt: null,
        repo: "https://github.com/example/repo.git",
        lastConflictAt: null,
        lastConflictFiles: [],
        lastError: null,
      })
      .includes("建议补齐: Auth, Sessions, ChannelState"),
    "formatSyncStatus should surface missing experience-critical items",
  );
  assert.ok(
    plugin
      .formatSyncStatus({
        transport: "github",
        mode: "decentralized",
        syncDir: path.join(tempRoot, "sync-data"),
        openclawDir: tempRoot,
        syncItems: ["Config", "Auth", "Workspace"],
        isSyncing: false,
        lastSyncAt: null,
        repo: "https://github.com/example/repo.git",
        lastConflictAt: null,
        lastConflictFiles: [],
        lastError: null,
      })
      .includes("同步副本缺失: Auth, WorkspaceFiles"),
    "formatSyncStatus should surface missing selected items in the sync mirror",
  );
  const verifyReport = plugin.formatMigrationVerificationReport(
    plugin.assessMigrationReadiness({
      transport: "github",
      mode: "decentralized",
      syncDir: path.join(tempRoot, "sync-data"),
      openclawDir: tempRoot,
      syncItems: ["Config", "Auth", "Workspace"],
      isSyncing: false,
      lastSyncAt: null,
      repo: "https://github.com/example/repo.git",
      lastConflictAt: null,
      lastConflictFiles: [],
      lastError: null,
    }),
  );
  assert.ok(
    verifyReport.includes("迁移验证结论: 存在风险"),
    "formatMigrationVerificationReport should summarize migration risks",
  );
  assert.ok(
    verifyReport.includes("未纳入迁移目标: Sessions, ChannelState"),
    "migration verification should report uncovered official migration targets",
  );
  assert.strictEqual(
    await plugin.executeCommand("sync.sync-now"),
    "同步服务尚未配置，无法立即同步。",
    "sync.sync-now should fail gracefully when not configured",
  );
  assert.strictEqual(
    await plugin.executeCommand("sync.verify-migration"),
    "迁移验证结论: 未验证\n失败项: 同步服务尚未启动或未完成配置\n建议动作: 先运行 sync.setup 完成配置，再执行 sync.verify-migration",
    "sync.verify-migration should handle missing configuration gracefully",
  );
  const conflictReport = await plugin.executeCommand("sync.conflicts", commandContext);
  assert.ok(
    conflictReport.includes("发现 2 个冲突文件:"),
    "sync.conflicts should report conflict count",
  );
  assert.ok(
    (
      await plugin.resolveConflictFiles({
        ...commandContext,
        commandOptions: {
          strategy: "cleanup",
          conflictFiles: [conflictFilePath],
          previewOnly: true,
        },
      })
    ).includes("冲突副本:"),
    "resolveConflictFiles should support preview-only mode",
  );
  assert.ok(
    conflictReport.includes(
      `- [openclaw] workspace\\state.json.local-conflict.2026-03-24T16-00-00.000Z -> ${conflictFilePath}`,
    ),
    "sync.conflicts should include openclaw conflict file",
  );
  assert.ok(
    conflictReport.includes(
      `- [sync] config\\settings.json.conflict.2026-03-24T16-00-00.000Z -> ${syncConflictFilePath}`,
    ),
    "sync.conflicts should include sync directory conflict file",
  );
  const cleanupReport = await plugin.executeCommand("sync.resolve-conflicts", {
    ...commandContext,
    commandOptions: {
      strategy: "cleanup",
      conflictFiles: [conflictFilePath],
    },
  });
  assert.ok(
    cleanupReport.includes("已处理 1/1 个冲突文件，策略: cleanup"),
    "sync.resolve-conflicts should support non-interactive cleanup mode",
  );
  assert.strictEqual(
    fs.existsSync(conflictFilePath),
    false,
    "cleanup mode should remove the selected conflict file",
  );
  assert.strictEqual(
    fs.existsSync(syncConflictFilePath),
    true,
    "cleanup mode should keep unselected conflict files",
  );
  const baseSyncFilePath = path.join(tempRoot, "sync-data", "config", "settings.json");
  fs.writeFileSync(baseSyncFilePath, "old");
  const applyConflictFilePath = path.join(
    tempRoot,
    "sync-data",
    "config",
    "settings.json.local-conflict.2026-03-25T08-30-00.000Z",
  );
  fs.writeFileSync(applyConflictFilePath, "new");
  const applyReport = await plugin.executeCommand("sync.resolve-conflicts", {
    ...commandContext,
    commandOptions: {
      strategy: "accept-conflict-copy",
      conflictFiles: [applyConflictFilePath],
    },
  });
  assert.ok(
    applyReport.includes("已处理 1/1 个冲突文件，策略: accept-conflict-copy"),
    "sync.resolve-conflicts should support overwrite mode",
  );
  assert.strictEqual(
    fs.readFileSync(baseSyncFilePath, "utf8"),
    "new",
    "overwrite mode should copy the conflict content back to the base file",
  );
  assert.strictEqual(
    fs.existsSync(applyConflictFilePath),
    false,
    "overwrite mode should remove the applied conflict copy",
  );
  assert.strictEqual(
    await plugin.resolveConflictFiles({
      ...commandContext,
      commandOptions: {
        strategy: "keep",
      },
    }),
    "已保留当前冲突文件，未做修改。",
    "resolveConflictFiles should allow explicitly keeping conflicts",
  );
  await assert.rejects(
    plugin.executeCommand("sync.unknown"),
    /未知命令/,
    "executeCommand should reject unknown commands",
  );
  console.log("✅ Test passed: Plugin and sync helpers load successfully.");
}

main().catch((error) => {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
});
