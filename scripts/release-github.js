const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/release-github.js --notes-file <path> [options]",
      "",
      "Options:",
      "  --tag <tag>           Release tag, defaults to v<package.version>",
      "  --name <name>         Release title, defaults to tag",
      "  --repo <owner/name>   GitHub repository, defaults to origin remote",
      "  --target <branch>     Target branch or commitish, defaults to main",
      "  --notes-file <path>   UTF-8 markdown file for release notes",
      "  --notes-stdin         Read release notes from stdin",
      "  --draft               Create or update as draft release",
      "  --prerelease          Mark release as prerelease",
      "  --dry-run             Validate inputs and print payload without publishing",
      "  --help                Show this help message",
      "",
      "Examples:",
      "  npm run release:github -- --notes-file .trae/documents/release.md",
      "  Get-Content release.md | npm run release:github -- --tag v0.1.5 --notes-stdin",
      "",
    ].join("\n"),
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      fail(`Unsupported argument: ${token}`);
    }

    const key = token.slice(2);

    if (["draft", "prerelease", "dry-run", "help", "notes-stdin"].includes(key)) {
      args[key] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function readPackageJson() {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function normalizeRepo(input) {
  const value = String(input || "")
    .trim()
    .replace(/^git\+/, "");
  const match = value.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);

  if (!match) {
    fail(`Unable to parse GitHub repository from: ${input}`);
  }

  return `${match[1]}/${match[2]}`;
}

function resolveRepo(args, packageJson) {
  if (args.repo) {
    return normalizeRepo(args.repo);
  }

  let remote = "";
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (process.env.DEBUG === "openclaw:sync") {
      process.stderr.write(`${String(error)}\n`);
    }
  }

  if (remote) {
    return normalizeRepo(remote);
  }

  const repositoryUrl =
    packageJson &&
    packageJson.repository &&
    typeof packageJson.repository.url === "string"
      ? packageJson.repository.url
      : "";

  if (repositoryUrl) {
    return normalizeRepo(repositoryUrl);
  }

  fail("Unable to resolve GitHub repository. Use --repo <owner/name>.");
}

function readGitHubCredential() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    return envToken.trim();
  }

  let credentialOutput = "";
  try {
    credentialOutput = execFileSync("git", ["credential", "fill"], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      input: "protocol=https\nhost=github.com\n",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error) {
    if (process.env.DEBUG === "openclaw:sync") {
      process.stderr.write(`${String(error)}\n`);
    }
  }

  const fields = {};
  for (const line of credentialOutput.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    fields[key] = value;
  }

  if (fields.password) {
    return fields.password.trim();
  }

  fail("Missing GitHub token. Set GITHUB_TOKEN/GH_TOKEN or configure git credential for github.com.");
}

function readNotesFromFile(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(absolutePath)) {
    fail(`Release notes file not found: ${absolutePath}`);
  }

  return fs.readFileSync(absolutePath, "utf8");
}

function readNotesFromStdin() {
  return new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      content += chunk;
    });
    process.stdin.on("end", () => resolve(content));
    process.stdin.on("error", reject);
  });
}

async function resolveReleaseNotes(args) {
  if (args["notes-file"]) {
    return readNotesFromFile(args["notes-file"]);
  }

  if (args["notes-stdin"] || !process.stdin.isTTY) {
    return readNotesFromStdin();
  }

  fail("Release notes are required. Use --notes-file <path> or --notes-stdin.");
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      data && typeof data.message === "string"
        ? data.message
        : `GitHub API request failed with status ${response.status}`;
    const detail =
      data && Array.isArray(data.errors) && data.errors.length > 0
        ? ` ${JSON.stringify(data.errors)}`
        : "";
    throw new Error(`${message}${detail}`);
  }

  return data;
}

function assertVerification(actual, expected) {
  const checks = [
    ["tag_name", actual.tag_name, expected.tag_name],
    ["name", actual.name, expected.name],
    ["body", actual.body, expected.body],
    ["draft", actual.draft, expected.draft],
    ["prerelease", actual.prerelease, expected.prerelease],
  ];

  for (const [field, actualValue, expectedValue] of checks) {
    if (actualValue !== expectedValue) {
      throw new Error(`Release verification failed for ${field}`);
    }
  }
}

async function upsertRelease({
  owner,
  repo,
  payload,
  token,
}) {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openclaw-sync-assistant-release-script",
    "Content-Type": "application/json; charset=utf-8",
  };
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/releases`;
  let existingRelease = null;

  try {
    existingRelease = await requestJson(`${apiBase}/tags/${payload.tag_name}`, {
      method: "GET",
      headers,
    });
  } catch (error) {
    if (!String(error.message || "").includes("Not Found")) {
      throw error;
    }
  }

  const response = existingRelease
    ? await requestJson(`${apiBase}/${existingRelease.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload),
      })
    : await requestJson(apiBase, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

  const verified = await requestJson(`${apiBase}/tags/${payload.tag_name}`, {
    method: "GET",
    headers,
  });

  assertVerification(verified, payload);
  return response;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const packageJson = readPackageJson();
  const tag = args.tag || `v${packageJson.version}`;
  const name = args.name || tag;
  const targetCommitish = args.target || "main";
  const releaseNotes = await resolveReleaseNotes(args);

  if (!releaseNotes.trim()) {
    fail("Release notes are empty.");
  }

  const [owner, repo] = resolveRepo(args, packageJson).split("/");
  const payload = {
    tag_name: tag,
    name,
    body: releaseNotes,
    draft: Boolean(args.draft),
    prerelease: Boolean(args.prerelease),
    target_commitish: targetCommitish,
  };

  if (args["dry-run"]) {
    process.stdout.write(
      `${JSON.stringify(
        {
          repository: `${owner}/${repo}`,
          payload,
          bodyLength: Buffer.byteLength(releaseNotes, "utf8"),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const token = readGitHubCredential();
  const release = await upsertRelease({
    owner,
    repo,
    payload,
    token,
  });

  process.stdout.write(`${release.html_url}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
