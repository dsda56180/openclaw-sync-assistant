const {
  intro,
  outro,
  text,
  multiselect,
  select,
  spinner,
} = require("@clack/prompts");
const fs = require("fs");
const pc = require("picocolors");
const path = require("path");
const os = require("os");
const GitSyncService = require("./src/github-sync");
const P2PSyncService = require("./src/p2p-sync");
const {
  normalizeSyncItems,
  getRecommendedSyncItems,
  getSyncItemDefinition,
} = require("./src/sync-items");

const CONFLICT_FILE_PATTERN = /\.(?:conflict|local-conflict|peer-conflict)\./;
const CONFLICT_FILE_DETAILS_PATTERN =
  /^(.*)\.(conflict|local-conflict|peer-conflict)\.([^\\/]+)$/;

let isWizardRunning = false;
let gitSyncInstance = null;

function getStateDirFromContext(context) {
  return (
    context?.api?.paths?.stateDir ||
    context?.paths?.stateDir ||
    process.env.OPENCLAW_STATE_DIR ||
    null
  );
}

function getOpenClawDir(context) {
  const stateDir = getStateDirFromContext(context);

  if (stateDir) {
    const normalizedStateDir = path.resolve(stateDir);
    const lowerStateDir = normalizedStateDir.toLowerCase();

    if (path.basename(lowerStateDir) === ".openclaw") {
      return normalizedStateDir;
    }

    return path.dirname(normalizedStateDir);
  }

  return path.join(os.homedir(), ".openclaw");
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readGitRemoteUrl(repoDir, remoteName = "origin") {
  const configPath = path.join(repoDir, ".git", "config");
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, "utf8");
    const escapedRemoteName = remoteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = content.match(
      new RegExp(`\\[remote "${escapedRemoteName}"\\][\\s\\S]*?url\\s*=\\s*(.+)`),
    );
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function loadFallbackConfig(context) {
  const openclawDir = getOpenClawDir(context);
  const legacyConfigPaths = [
    path.join(openclawDir, "sync-data", "openclaw.json"),
    path.join(openclawDir, "p2p-sync-data", "openclaw.json"),
  ];

  for (const configPath of legacyConfigPaths) {
    const parsed = readJsonFile(configPath);
    const entry =
      parsed?.plugins?.entries?.["openclaw-sync-assistant"] ||
      parsed?.["openclaw-sync-assistant"];

    if (!entry || typeof entry !== "object") {
      continue;
    }

    const syncMethod =
      typeof entry.syncMethod === "string" ? entry.syncMethod : null;
    const fallbackRepoDir = path.dirname(configPath);
    const githubRepo =
      readGitRemoteUrl(fallbackRepoDir) ||
      (typeof entry.githubRepo === "string" ? entry.githubRepo : null);
    const syncMode = typeof entry.syncMode === "string" ? entry.syncMode : null;
    const syncSecret =
      typeof entry.syncSecret === "string" ? entry.syncSecret : null;
    const syncItems = normalizeSyncItems(entry.syncItems || []);

    if (!syncMethod) {
      continue;
    }

    return {
      hasConfigured: true,
      syncMethod,
      githubRepo,
      syncMode,
      syncSecret,
      syncItems,
    };
  }

  return null;
}

function isConflictFile(filePath) {
  return CONFLICT_FILE_PATTERN.test(filePath);
}

function getFileMetadata(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      exists: false,
      size: null,
      modifiedAt: null,
    };
  }

  const stat = fs.statSync(filePath);

  return {
    exists: true,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function formatFileMetadata(metadata) {
  if (!metadata || !metadata.exists) {
    return "不存在";
  }

  return `${metadata.size} B, ${metadata.modifiedAt}`;
}

function assessExperienceConsistency(syncItems) {
  const normalizedItems = normalizeSyncItems(syncItems);
  const recommendedItems = getRecommendedSyncItems();
  const selectedSet = new Set(normalizedItems);
  const missingItems = recommendedItems.filter((item) => !selectedSet.has(item));
  const coverageRatio =
    recommendedItems.length === 0
      ? 1
      : (recommendedItems.length - missingItems.length) / recommendedItems.length;
  let level = "partial";

  if (normalizedItems.length === 0) {
    level = "unconfigured";
  } else if (missingItems.length === 0) {
    level = "full";
  }

  return {
    level,
    selectedItems: normalizedItems,
    recommendedItems: [...recommendedItems],
    missingItems,
    coverageRatio,
  };
}

function formatExperienceConsistencySummary(summary) {
  if (!summary || summary.level === "unconfigured") {
    return "未建立一致性保障";
  }

  if (summary.level === "full") {
    return "完整";
  }

  return `部分一致 (${summary.selectedItems.length}/${summary.recommendedItems.length})`;
}

function assessExperienceBaseline(rootDir, syncItems) {
  const selectedItems = normalizeSyncItems(syncItems);
  const rootExists = Boolean(rootDir) && fs.existsSync(rootDir);
  const items = getRecommendedSyncItems().map((item) => {
    const definition = getSyncItemDefinition(item);
    const paths = (definition?.paths || []).map((relativePath) => {
      const targetPath = rootDir ? path.join(rootDir, relativePath) : null;
      const exists = Boolean(targetPath) && fs.existsSync(targetPath);

      return {
        relativePath,
        path: targetPath,
        exists,
      };
    });
    const matchedPaths = paths
      .filter((entry) => entry.exists)
      .map((entry) => entry.relativePath);
    const exists = matchedPaths.length > 0;

    return {
      item,
      paths,
      selected: selectedItems.includes(item),
      exists,
      matchedPaths,
    };
  });
  const selectedEntries = items.filter((entry) => entry.selected);
  const presentSelectedItems = selectedEntries
    .filter((entry) => entry.exists)
    .map((entry) => entry.item);
  const missingSelectedItems = selectedEntries
    .filter((entry) => !entry.exists)
    .map((entry) => entry.item);
  let level = "partial";

  if (selectedEntries.length === 0) {
    level = "unconfigured";
  } else if (missingSelectedItems.length === 0) {
    level = "ready";
  } else if (presentSelectedItems.length === 0) {
    level = "missing";
  }

  return {
    rootDir,
    rootExists,
    level,
    selectedItems,
    presentSelectedItems,
    missingSelectedItems,
    selectedCount: selectedEntries.length,
    presentCount: presentSelectedItems.length,
    items,
  };
}

function formatExperienceBaselineSummary(baseline) {
  if (!baseline || baseline.level === "unconfigured") {
    return "未配置检查项";
  }

  if (baseline.level === "ready") {
    return `完整 (${baseline.presentCount}/${baseline.selectedCount})`;
  }

  if (baseline.level === "missing") {
    return `缺失 (${baseline.presentCount}/${baseline.selectedCount})`;
  }

  return `部分就绪 (${baseline.presentCount}/${baseline.selectedCount})`;
}

function findBaselineItem(baseline, item) {
  return baseline?.items?.find((entry) => entry.item === item) || null;
}

function getMigrationReadinessSummary(level) {
  if (level === "ready") {
    return "就绪";
  }

  if (level === "at-risk") {
    return "存在风险";
  }

  if (level === "partial") {
    return "部分覆盖";
  }

  return "未验证";
}

function assessMigrationReadiness(status) {
  if (!status) {
    return {
      level: "unavailable",
      syncItems: [],
      consistency: assessExperienceConsistency([]),
      localBaseline: assessExperienceBaseline(null, []),
      syncBaseline: assessExperienceBaseline(null, []),
      automaticChecks: [],
      manualChecks: [
        {
          label: "Gateway 运行状态",
          state: "manual",
          detail: "需在目标机器执行 openclaw status",
        },
      ],
      failures: ["同步服务尚未启动或未完成配置"],
      warnings: [],
    };
  }

  const syncItems = normalizeSyncItems(status.syncItems);
  const consistency = assessExperienceConsistency(syncItems);
  const localBaseline = assessExperienceBaseline(status.openclawDir, syncItems);
  const syncBaseline = assessExperienceBaseline(status.syncDir, syncItems);
  const automaticChecks = getRecommendedSyncItems().map((item) => {
    const definition = getSyncItemDefinition(item);
    const localEntry = findBaselineItem(localBaseline, item);
    const syncEntry = findBaselineItem(syncBaseline, item);
    const selected = syncItems.includes(item);
    let state = "not-covered";
    let detail = "未纳入同步范围";

    if (selected && localEntry?.exists && syncEntry?.exists) {
      state = "ready";
      detail = `本地与同步副本均已检测到 (${syncEntry.matchedPaths.join(", ")})`;
    } else if (selected && localEntry?.exists) {
      state = "partial";
      detail = `本地已检测到，同步副本缺失 (${localEntry.matchedPaths.join(", ")})`;
    } else if (selected && syncEntry?.exists) {
      state = "partial";
      detail = `同步副本已检测到，本地缺失 (${syncEntry.matchedPaths.join(", ")})`;
    } else if (selected) {
      state = "missing";
      detail = "本地与同步副本都未检测到";
    }

    return {
      item,
      label: definition?.label || item,
      sensitive: Boolean(definition?.sensitive),
      selected,
      state,
      detail,
    };
  });
  const manualChecks = [
    {
      label: "Gateway 运行状态",
      state: "manual",
      detail: "需在目标机器执行 openclaw status",
    },
    {
      label: "Channels 连接状态",
      state: syncItems.includes("ChannelState") ? "manual" : "not-covered",
      detail: syncItems.includes("ChannelState")
        ? "需在目标机器确认渠道仍保持登录"
        : "未纳入 ChannelState，同步后大概率仍需重新登录",
    },
    {
      label: "现有会话可见性",
      state: syncItems.includes("Sessions") ? "manual" : "not-covered",
      detail: syncItems.includes("Sessions")
        ? "需在目标机器打开 Dashboard 检查会话列表"
        : "未纳入 Sessions，历史对话与 Agent 状态不会完整迁移",
    },
  ];
  const failures = [];
  const warnings = [];

  if (localBaseline.missingSelectedItems.length > 0) {
    failures.push(`本地缺失: ${localBaseline.missingSelectedItems.join(", ")}`);
  }

  if (syncBaseline.missingSelectedItems.length > 0) {
    failures.push(`同步副本缺失: ${syncBaseline.missingSelectedItems.join(", ")}`);
  }

  if (consistency.missingItems.length > 0) {
    warnings.push(`未纳入迁移目标: ${consistency.missingItems.join(", ")}`);
  }

  const hasMissingSensitiveItems = automaticChecks.some(
    (entry) => entry.selected && entry.sensitive && entry.state !== "ready",
  );

  if (hasMissingSensitiveItems) {
    warnings.push("敏感同步项尚未全部就绪，请谨慎在新机器直接切换");
  }

  let level = "ready";

  if (failures.length > 0) {
    level = "at-risk";
  } else if (warnings.length > 0) {
    level = "partial";
  }

  return {
    level,
    syncItems,
    consistency,
    localBaseline,
    syncBaseline,
    automaticChecks,
    manualChecks,
    failures,
    warnings,
  };
}

function formatMigrationVerificationReport(report) {
  if (!report || report.level === "unavailable") {
    return [
      "迁移验证结论: 未验证",
      "失败项: 同步服务尚未启动或未完成配置",
      "建议动作: 先运行 sync.setup 完成配置，再执行 sync.verify-migration",
    ].join("\n");
  }

  const lines = [
    `迁移验证结论: ${getMigrationReadinessSummary(report.level)}`,
    `迁移目标覆盖: ${report.consistency.selectedItems.length}/${report.consistency.recommendedItems.length}`,
    `已纳入同步: ${
      report.syncItems.length > 0 ? report.syncItems.join(", ") : "无"
    }`,
    `本地关键数据: ${formatExperienceBaselineSummary(report.localBaseline)}`,
    `同步副本关键数据: ${formatExperienceBaselineSummary(report.syncBaseline)}`,
  ];

  if (report.consistency.missingItems.length > 0) {
    lines.push(`未纳入迁移目标: ${report.consistency.missingItems.join(", ")}`);
  }

  lines.push("自动检查:");
  lines.push(
    ...report.automaticChecks.map(
      (entry) =>
        `- ${entry.label}: ${
          entry.state === "ready"
            ? "已覆盖"
            : entry.state === "partial"
              ? "部分覆盖"
              : entry.state === "missing"
                ? "缺失"
                : "未纳入"
        } | ${entry.detail}`,
    ),
  );
  lines.push("人工复核:");
  lines.push(
    ...report.manualChecks.map(
      (entry) =>
        `- ${entry.label}: ${
          entry.state === "manual" ? "需人工确认" : "当前未覆盖"
        } | ${entry.detail}`,
    ),
  );

  if (report.failures.length > 0) {
    lines.push(`失败项: ${report.failures.join("；")}`);
  }

  if (report.warnings.length > 0) {
    lines.push(`风险提示: ${report.warnings.join("；")}`);
  }

  if (report.level === "ready") {
    lines.push("建议动作: 可进入目标机器进行最终人工验收。");
  } else {
    lines.push("建议动作: 先补齐缺失同步项并执行一次完整同步，再复查迁移验证。");
  }

  return lines.join("\n");
}

function parseConflictFileDetails(relativePath) {
  const directory = path.dirname(relativePath);
  const fileName = path.basename(relativePath);
  const match = fileName.match(CONFLICT_FILE_DETAILS_PATTERN);

  if (!match) {
    return {
      baseRelativePath: relativePath,
      conflictLabel: null,
      conflictTimestamp: null,
    };
  }

  const [, originalFileName, conflictLabel, conflictTimestamp] = match;

  return {
    baseRelativePath:
      directory === "."
        ? originalFileName
        : path.join(directory, originalFileName),
    conflictLabel,
    conflictTimestamp,
  };
}

async function loadConfig(context) {
  const configApi = context?.api?.config;

  if (!configApi || typeof configApi.get !== "function") {
    return (
      loadFallbackConfig(context) || {
        hasConfigured: false,
        syncMethod: null,
        githubRepo: null,
        syncMode: null,
        syncSecret: null,
        syncItems: [],
      }
    );
  }

  const syncMethod = await configApi.get("openclaw-sync-assistant.syncMethod");
  const githubRepo = await configApi.get("openclaw-sync-assistant.githubRepo");
  const syncMode = await configApi.get("openclaw-sync-assistant.syncMode");
  const syncSecret = await configApi.get("openclaw-sync-assistant.syncSecret");
  const syncItems =
    normalizeSyncItems(
      (await configApi.get("openclaw-sync-assistant.syncItems")) || [],
    );

  if (syncMethod) {
    return {
      hasConfigured: true,
      syncMethod,
      githubRepo,
      syncMode,
      syncSecret,
      syncItems,
    };
  }

  return (
    loadFallbackConfig(context) || {
      hasConfigured: false,
      syncMethod: null,
      githubRepo: null,
      syncMode: null,
      syncSecret: null,
      syncItems: [],
    }
  );
}

function createSyncService(context, config) {
  const openclawDir = getOpenClawDir(context);
  const debug = process.env.DEBUG === "openclaw:sync";

  if (config.syncMethod === "github" && config.githubRepo) {
    return new GitSyncService(
      path.join(openclawDir, "sync-data"),
      config.githubRepo,
      config.syncMode,
      {
        openclawDir,
        syncItems: config.syncItems,
      },
      debug,
    );
  }

  if (config.syncMethod === "p2p") {
    return new P2PSyncService(
      path.join(openclawDir, "p2p-sync-data"),
      config.syncSecret,
      config.syncMode,
      {
        openclawDir,
        syncItems: config.syncItems,
      },
      debug,
    );
  }

  return null;
}

function resolveSyncDir(openclawDir, syncMethod) {
  if (syncMethod === "github") {
    return path.join(openclawDir, "sync-data");
  }

  if (syncMethod === "p2p") {
    return path.join(openclawDir, "p2p-sync-data");
  }

  return null;
}

function collectConflictFiles(rootDir, ignoredDirs = []) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const entries = [];
  const normalizedIgnoredDirs = ignoredDirs.map((dirPath) => path.resolve(dirPath));
  const walk = (currentDir) => {
    for (const childName of fs.readdirSync(currentDir)) {
      if (childName === ".git" || childName === ".p2p-storage") {
        continue;
      }

      const childPath = path.join(currentDir, childName);
      const normalizedChildPath = path.resolve(childPath);

      if (normalizedIgnoredDirs.includes(normalizedChildPath)) {
        continue;
      }

      const stat = fs.statSync(childPath);

      if (stat.isDirectory()) {
        walk(childPath);
        continue;
      }

      if (stat.isFile() && isConflictFile(childName)) {
        entries.push(childPath);
      }
    }
  };

  walk(rootDir);
  return entries;
}

async function listConflictFiles(context) {
  const config = await loadConfig(context);
  const openclawDir = getOpenClawDir(context);
  const syncDir = resolveSyncDir(openclawDir, config.syncMethod);
  const roots = [
    { label: "openclaw", dir: openclawDir },
    ...(syncDir && syncDir !== openclawDir ? [{ label: "sync", dir: syncDir }] : []),
  ];
  const seenPaths = new Set();
  const conflicts = [];

  for (const root of roots) {
    const ignoredDirs =
      root.label === "openclaw" && syncDir && syncDir !== openclawDir ? [syncDir] : [];

    for (const filePath of collectConflictFiles(root.dir, ignoredDirs)) {
      const normalizedPath = path.resolve(filePath);

      if (seenPaths.has(normalizedPath)) {
        continue;
      }

      seenPaths.add(normalizedPath);
      const relativePath = path.relative(root.dir, normalizedPath);
      const details = parseConflictFileDetails(relativePath);
      const resolutionTargetPath = path.join(root.dir, details.baseRelativePath);
      conflicts.push({
        scope: root.label,
        filePath: normalizedPath,
        relativePath,
        baseRelativePath: details.baseRelativePath,
        resolutionTargetPath,
        conflictLabel: details.conflictLabel,
        conflictTimestamp: details.conflictTimestamp,
        conflictFileStats: getFileMetadata(normalizedPath),
        targetFileStats: getFileMetadata(resolutionTargetPath),
      });
    }
  }

  return conflicts;
}

function formatConflictStatus(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    return "未发现冲突文件。";
  }

  return [
    `发现 ${conflicts.length} 个冲突文件:`,
    ...conflicts.map(
      (entry) => `- [${entry.scope}] ${entry.relativePath} -> ${entry.filePath}`,
    ),
  ].join("\n");
}

function getCommandOptions(context) {
  return context?.commandOptions || context?.options || {};
}

function listConflictScopes(conflicts) {
  return [...new Set(conflicts.map((entry) => entry.scope))];
}

function filterConflictsByScopes(conflicts, scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return conflicts;
  }

  const scopeSet = new Set(scopes);
  return conflicts.filter((entry) => scopeSet.has(entry.scope));
}

function planConflictResolution(conflicts, options = {}) {
  const strategy = options.strategy || "cleanup";

  if (!["cleanup", "accept-conflict-copy", "keep"].includes(strategy)) {
    throw new Error(`未知冲突处理策略: ${strategy}`);
  }

  const scopedConflicts = filterConflictsByScopes(conflicts, options.scopes);

  const selectedPaths = Array.isArray(options.conflictFiles)
    ? options.conflictFiles.map((filePath) => path.resolve(filePath))
    : [];
  const selectedPathSet =
    selectedPaths.length > 0 ? new Set(selectedPaths) : null;

  return {
    strategy,
    conflicts: selectedPathSet
      ? scopedConflicts.filter((entry) =>
          selectedPathSet.has(path.resolve(entry.filePath)),
        )
      : scopedConflicts,
  };
}

function getConflictResolutionStrategyLabel(strategy) {
  if (strategy === "cleanup") {
    return "仅删除冲突副本";
  }

  if (strategy === "accept-conflict-copy") {
    return "用冲突副本覆盖原文件";
  }

  if (strategy === "keep") {
    return "暂不处理";
  }

  return strategy;
}

function formatConflictResolutionPreview(plan) {
  if (!plan || plan.strategy === "keep") {
    return "当前没有待执行的冲突处理操作。";
  }

  if (!Array.isArray(plan.conflicts) || plan.conflicts.length === 0) {
    return `未选择任何冲突文件，策略: ${getConflictResolutionStrategyLabel(plan.strategy)}`;
  }

  const overwriteCount = plan.strategy === "accept-conflict-copy" ? plan.conflicts.length : 0;

  return [
    `即将处理 ${plan.conflicts.length} 个冲突文件`,
    `处理策略: ${getConflictResolutionStrategyLabel(plan.strategy)}`,
    ...(overwriteCount > 0
      ? [`风险提示: 将尝试覆盖 ${overwriteCount} 个正式文件`]
      : []),
    ...plan.conflicts.map((entry) =>
      plan.strategy === "cleanup"
        ? `- 删除 [${entry.scope}] ${entry.relativePath} | 冲突副本: ${formatFileMetadata(
            entry.conflictFileStats,
          )}`
        : `- 覆盖 [${entry.scope}] ${entry.baseRelativePath} <- ${entry.relativePath} | 目标文件: ${formatFileMetadata(
            entry.targetFileStats,
          )} | 冲突副本: ${formatFileMetadata(entry.conflictFileStats)}`,
    ),
  ].join("\n");
}

async function confirmConflictResolution(plan) {
  console.log(formatConflictResolutionPreview(plan));

  const confirmation = await select({
    message: "确认执行以上冲突处理操作吗？",
    options: [
      {
        value: "confirm",
        label: "确认执行",
        hint: "立即应用以上变更",
      },
      {
        value: "cancel",
        label: "取消",
        hint: "保留现状，不修改任何文件",
      },
    ],
  });

  return confirmation === "confirm";
}

async function confirmOverwriteEntries(plan) {
  const confirmedConflicts = [];

  for (const entry of plan.conflicts) {
    const confirmation = await select({
      message: `确认覆盖 [${entry.scope}] ${entry.baseRelativePath} 吗？`,
      options: [
        {
          value: "confirm",
          label: "确认覆盖",
          hint: `${entry.relativePath} -> ${entry.baseRelativePath}`,
        },
        {
          value: "skip",
          label: "跳过此文件",
          hint: "保留该冲突副本，不覆盖正式文件",
        },
      ],
    });

    if (confirmation === "confirm") {
      confirmedConflicts.push(entry);
    }
  }

  return {
    ...plan,
    conflicts: confirmedConflicts,
  };
}

async function promptConflictResolution(conflicts) {
  const strategy = await select({
    message: `检测到 ${conflicts.length} 个冲突文件，选择处理方式:`,
    options: [
      {
        value: "cleanup",
        label: "仅删除冲突副本",
        hint: "推荐；保留当前正式文件不变",
      },
      {
        value: "accept-conflict-copy",
        label: "用冲突副本覆盖原文件",
        hint: "会替换正式文件并删除冲突副本",
      },
      {
        value: "keep",
        label: "暂不处理",
        hint: "退出，不做任何改动",
      },
    ],
  });

  if (typeof strategy === "symbol" || strategy === "keep") {
    return {
      strategy: "keep",
      conflicts: [],
    };
  }

  const availableScopes = listConflictScopes(conflicts);
  let scopedConflicts = conflicts;

  if (availableScopes.length > 1) {
    const selectedScopes = await multiselect({
      message: "请选择要处理的作用域:",
      options: availableScopes.map((scope) => ({
        value: scope,
        label: scope,
        hint: scope === "openclaw" ? "主目录冲突文件" : "同步目录冲突文件",
      })),
      required: false,
    });

    if (typeof selectedScopes === "symbol") {
      return {
        strategy: "keep",
        conflicts: [],
      };
    }

    scopedConflicts = filterConflictsByScopes(conflicts, selectedScopes);
  }

  const selectedPaths = await multiselect({
    message: "请选择要处理的冲突文件:",
    options: scopedConflicts.map((entry) => ({
      value: entry.filePath,
      label: `[${entry.scope}] ${entry.relativePath}`,
      hint:
        strategy === "cleanup"
          ? "删除冲突副本"
          : `覆盖 ${entry.baseRelativePath}`,
    })),
    required: false,
  });

  if (typeof selectedPaths === "symbol") {
    return {
      strategy: "keep",
      conflicts: [],
    };
  }

  const plan = planConflictResolution(scopedConflicts, {
    strategy,
    conflictFiles: selectedPaths,
  });

  if (plan.conflicts.length === 0) {
    return plan;
  }

  const confirmed = await confirmConflictResolution(plan);

  if (!confirmed) {
    return {
        strategy: "keep",
        conflicts: [],
      };
  }

  if (plan.strategy !== "accept-conflict-copy") {
    return plan;
  }

  const confirmedPlan = await confirmOverwriteEntries(plan);

  return confirmedPlan.conflicts.length > 0
    ? confirmedPlan
    : {
        strategy: "keep",
        conflicts: [],
      };
}

async function resolveConflictFiles(context) {
  const conflicts = await listConflictFiles(context);

  if (conflicts.length === 0) {
    return "未发现可处理的冲突文件。";
  }

  const options = getCommandOptions(context);
  const resolutionPlan = options.strategy
    ? planConflictResolution(conflicts, options)
    : await promptConflictResolution(conflicts);

  if (options.previewOnly || options.dryRun) {
    return formatConflictResolutionPreview(resolutionPlan);
  }

  if (resolutionPlan.strategy === "keep") {
    return "已保留当前冲突文件，未做修改。";
  }

  if (resolutionPlan.conflicts.length === 0) {
    return "未选择任何冲突文件，未做修改。";
  }

  const results = [];
  let successCount = 0;

  for (const entry of resolutionPlan.conflicts) {
    try {
      if (resolutionPlan.strategy === "cleanup") {
        fs.unlinkSync(entry.filePath);
        results.push(`- 已删除: [${entry.scope}] ${entry.relativePath}`);
        successCount += 1;
        continue;
      }

      fs.mkdirSync(path.dirname(entry.resolutionTargetPath), { recursive: true });
      fs.copyFileSync(entry.filePath, entry.resolutionTargetPath);
      fs.unlinkSync(entry.filePath);
      results.push(
        `- 已覆盖: [${entry.scope}] ${entry.baseRelativePath} <- ${entry.relativePath}`,
      );
      successCount += 1;
    } catch (error) {
      results.push(
        `- 处理失败: [${entry.scope}] ${entry.relativePath} (${error.message})`,
      );
    }
  }

  return [
    `已处理 ${successCount}/${resolutionPlan.conflicts.length} 个冲突文件，策略: ${resolutionPlan.strategy}`,
    ...results,
  ].join("\n");
}

async function startSyncService(context) {
  if (gitSyncInstance) {
    return gitSyncInstance;
  }

  const config = await loadConfig(context);
  gitSyncInstance = createSyncService(context, config);

  if (!gitSyncInstance) {
    return null;
  }

  await gitSyncInstance.init();
  return gitSyncInstance;
}

function formatSyncStatus(status) {
  if (!status) {
    return "同步服务尚未启动。";
  }

  const syncItems = normalizeSyncItems(status.syncItems);
  const experienceSummary = assessExperienceConsistency(syncItems);
  const localBaseline = assessExperienceBaseline(status.openclawDir, syncItems);
  const syncBaseline = assessExperienceBaseline(status.syncDir, syncItems);
  const migrationReadiness = assessMigrationReadiness({
    ...status,
    syncItems,
  });
  const lines = [
    `同步方式: ${status.transport}`,
    `同步模式: ${status.mode || "unknown"}`,
    `同步目录: ${status.syncDir}`,
    `同步内容: ${
      syncItems.length > 0
        ? syncItems.join(", ")
        : "未配置"
    }`,
    `体验一致性: ${formatExperienceConsistencySummary(experienceSummary)}`,
    `迁移准备度: ${getMigrationReadinessSummary(migrationReadiness.level)}`,
    `本地状态基线: ${formatExperienceBaselineSummary(localBaseline)}`,
    `同步副本基线: ${formatExperienceBaselineSummary(syncBaseline)}`,
    `同步中: ${status.isSyncing ? "是" : "否"}`,
    `最近同步: ${status.lastSyncAt || "无"}`,
  ];

  if (experienceSummary.missingItems.length > 0) {
    lines.push(`建议补齐: ${experienceSummary.missingItems.join(", ")}`);
  }

  if (localBaseline.missingSelectedItems.length > 0) {
    lines.push(`本地缺失: ${localBaseline.missingSelectedItems.join(", ")}`);
  }

  if (syncBaseline.missingSelectedItems.length > 0) {
    lines.push(`同步副本缺失: ${syncBaseline.missingSelectedItems.join(", ")}`);
  }

  if (status.transport === "github") {
    lines.push(`仓库: ${status.repo || "未配置"}`);
  }

  if (status.transport === "p2p") {
    lines.push(`发现主题: ${status.discoveryKey || "未就绪"}`);
    lines.push(`连接节点: ${status.peerCount ?? 0}`);
    lines.push(`Drive 版本: ${status.driveVersion ?? 0}`);
    lines.push(`最近方向: ${status.lastSyncDirection || "无"}`);
  }

  lines.push(`最近冲突: ${status.lastConflictAt || "无"}`);
  lines.push(
    `冲突文件: ${
      Array.isArray(status.lastConflictFiles) && status.lastConflictFiles.length > 0
        ? status.lastConflictFiles.join(", ")
        : "无"
    }`,
  );
  lines.push(`最近错误: ${status.lastError || "无"}`);

  return lines.join("\n");
}

module.exports = {
  /**
   * 插件激活时的入口函数
   * @param {object} context - OpenClaw 提供的上下文对象，包含 api 等
   */
  activate(context) {
    if (process.env.DEBUG === "openclaw:sync") {
      console.log("✅ openclaw-sync-assistant 插件已激活！");
    }

    void (async () => {
      // 防止在 OpenClaw 的某些生命周期中 activate 被并发/多次调用导致向导重复弹出
      if (isWizardRunning) return;

      // 检查是否已经配置过
      let config = await loadConfig(context);

      const serviceMarker = process.env.OPENCLAW_SERVICE_MARKER;
      const serviceKind = (process.env.OPENCLAW_SERVICE_KIND || "").toLowerCase();
      const isGatewayService =
        Boolean(serviceMarker) && serviceKind.includes("gateway");

      if (!config.hasConfigured && isGatewayService) {
        isWizardRunning = true;
        try {
          await module.exports.runSetupWizard(context);
          config = await loadConfig(context);
        } finally {
          isWizardRunning = false;
        }
      }

      if (config.hasConfigured) {
        gitSyncInstance = createSyncService(context, config);

        if (gitSyncInstance) {
          await gitSyncInstance.init();
        }
      }
    })().catch((error) => {
      console.error("[openclaw-sync-assistant] activate failed:", error);
    });
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
        placeholder: "例如: https://github.com/user/repo.git (直接回车可跳过)",
        validate(value) {
          if (!value || value.trim() === "") return;
          const githubRegex =
            /^(https:\/\/github\.com\/|git@github\.com:)[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+(\.git)?$/;
          if (!githubRegex.test(value.trim())) {
            return "请输入有效的 GitHub 仓库地址，例如: https://github.com/user/repo.git";
          }
        },
      });
      if (typeof githubRepo === "symbol") return;
    }

    const syncItems = await multiselect({
      message: "请选择要同步的内容 (按空格勾选，回车确认；若希望跨 OpenClaw 保持一致体验，建议全选):",
      options: [
        { value: "Config", label: "Config", hint: "OpenClaw 核心配置" },
        { value: "Auth", label: "Auth", hint: "认证信息" },
        { value: "Sessions", label: "Sessions", hint: "会话历史与 Agent 状态" },
        {
          value: "ChannelState",
          label: "ChannelState",
          hint: "渠道登录状态，如 WhatsApp / Telegram",
        },
        {
          value: "WorkspaceFiles",
          label: "WorkspaceFiles",
          hint: "MEMORY.md、USER.md、skills、prompts 等工作区文件",
        },
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
    const experienceSummary = assessExperienceConsistency(syncItems);
    outro(
      pc.green(
        `✔ 配置向导完成！后台服务将按 [${syncMethod.toUpperCase()}] 模式运行。`,
      ),
    );
    if (experienceSummary.level !== "full") {
      console.log(
        pc.yellow(
          `当前体验一致性保障为 ${formatExperienceConsistencySummary(experienceSummary)}，建议补齐: ${experienceSummary.missingItems.join(", ") || "Config, Auth, Sessions, ChannelState, WorkspaceFiles"}`,
        ),
      );
    }
  },

  /**
   * 插件卸载或停用时的清理函数
   */
  deactivate() {
    console.log("❌ openclaw-sync-assistant 插件已卸载/停用。");
    if (gitSyncInstance) {
      gitSyncInstance.stop();
      gitSyncInstance = null;
    }
  },

  getSyncStatus() {
    if (!gitSyncInstance || typeof gitSyncInstance.getStatus !== "function") {
      return null;
    }

    return gitSyncInstance.getStatus();
  },

  formatSyncStatus,
  assessExperienceConsistency,
  formatExperienceConsistencySummary,
  assessExperienceBaseline,
  formatExperienceBaselineSummary,
  assessMigrationReadiness,
  formatMigrationVerificationReport,
  isConflictFile,
  getFileMetadata,
  formatFileMetadata,
  parseConflictFileDetails,
  collectConflictFiles,
  listConflictFiles,
  formatConflictStatus,
  listConflictScopes,
  filterConflictsByScopes,
  planConflictResolution,
  formatConflictResolutionPreview,
  resolveConflictFiles,

  async executeCommand(commandId, context) {
    if (commandId === "sync.setup") {
      await module.exports.runSetupWizard(context);
      return "同步配置向导已完成。";
    }

    if (commandId === "sync.status") {
      const service = await startSyncService(context);
      const status =
        service && typeof service.getStatus === "function"
          ? service.getStatus()
          : module.exports.getSyncStatus();
      const output = formatSyncStatus(status);
      console.log(output);
      return output;
    }

    if (commandId === "sync.sync-now") {
      const service = await startSyncService(context);

      if (!service || typeof service.performSync !== "function") {
        const output = "同步服务尚未配置，无法立即同步。";
        console.log(output);
        return output;
      }

      if (service instanceof P2PSyncService) {
        await service.performSync("push");
      } else {
        await service.performSync();
      }

      const output = formatSyncStatus(service.getStatus());
      console.log(output);
      return output;
    }

    if (commandId === "sync.conflicts") {
      const output = formatConflictStatus(await listConflictFiles(context));
      console.log(output);
      return output;
    }

    if (commandId === "sync.verify-migration") {
      const service = await startSyncService(context);
      const status =
        service && typeof service.getStatus === "function"
          ? service.getStatus()
          : module.exports.getSyncStatus();
      const output = formatMigrationVerificationReport(
        assessMigrationReadiness(status),
      );
      console.log(output);
      return output;
    }

    if (commandId === "sync.resolve-conflicts") {
      const output = await resolveConflictFiles(context);
      console.log(output);
      return output;
    }

    throw new Error(`未知命令: ${commandId}`);
  },

  async runCommand(commandId, context) {
    return module.exports.executeCommand(commandId, context);
  },
};
