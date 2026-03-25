const path = require("path");

const SYNC_ITEM_REGISTRY = {
  Config: {
    id: "Config",
    label: "Config",
    paths: ["config", "openclaw.json"],
    sensitive: false,
    verificationMode: "any",
  },
  Auth: {
    id: "Auth",
    label: "Auth",
    paths: ["auth"],
    sensitive: true,
    verificationMode: "any",
  },
  Sessions: {
    id: "Sessions",
    label: "Sessions",
    paths: ["sessions", "history", "agent-state"],
    sensitive: false,
    verificationMode: "any",
  },
  ChannelState: {
    id: "ChannelState",
    label: "ChannelState",
    paths: ["channels", "channel-state", "whatsapp", "telegram"],
    sensitive: true,
    verificationMode: "any",
  },
  WorkspaceFiles: {
    id: "WorkspaceFiles",
    label: "WorkspaceFiles",
    paths: ["workspace", "MEMORY.md", "USER.md", "skills", "prompts"],
    sensitive: false,
    verificationMode: "any",
  },
};

const SYNC_ITEM_ALIASES = {
  Workspace: "WorkspaceFiles",
};

function normalizeSyncItem(item) {
  if (!item || typeof item !== "string") {
    return null;
  }

  const normalizedItem = SYNC_ITEM_ALIASES[item] || item;
  return SYNC_ITEM_REGISTRY[normalizedItem] ? normalizedItem : null;
}

function normalizeSyncItems(syncItems) {
  if (!Array.isArray(syncItems)) {
    return [];
  }

  return [
    ...new Set(
      syncItems
        .map((item) => normalizeSyncItem(item))
        .filter((item) => item && SYNC_ITEM_REGISTRY[item]),
    ),
  ];
}

function getSyncItemDefinition(item) {
  const normalizedItem = normalizeSyncItem(item);
  return normalizedItem ? SYNC_ITEM_REGISTRY[normalizedItem] : null;
}

function getRecommendedSyncItems() {
  return Object.keys(SYNC_ITEM_REGISTRY);
}

function getSyncItemDefinitions(syncItems = getRecommendedSyncItems()) {
  return normalizeSyncItems(syncItems)
    .map((item) => getSyncItemDefinition(item))
    .filter(Boolean);
}

function resolveSyncEntries(openclawDir, syncDir, syncItems) {
  return getSyncItemDefinitions(syncItems).flatMap((definition) =>
    definition.paths.map((relativePath) => ({
      item: definition.id,
      relativePath,
      source: path.join(openclawDir, relativePath),
      target: path.join(syncDir, relativePath),
    })),
  );
}

module.exports = {
  SYNC_ITEM_REGISTRY,
  SYNC_ITEM_ALIASES,
  normalizeSyncItem,
  normalizeSyncItems,
  getSyncItemDefinition,
  getRecommendedSyncItems,
  getSyncItemDefinitions,
  resolveSyncEntries,
};
