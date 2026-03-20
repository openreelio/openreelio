import { Buffer } from "node:buffer";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";

const CODEX_CLI_AUTH_FILENAME = "auth.json";

function resolveUserPath(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveCodexHomePath() {
  const configured = process.env.CODEX_HOME;
  const home = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function resolveCodexCliAuthPath() {
  return path.join(resolveCodexHomePath(), CODEX_CLI_AUTH_FILENAME);
}

function computeCodexKeychainAccount(codexHome) {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function decodeJwtExpiryMs(token) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw);
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readCodexKeychainCredentials() {
  if (process.platform !== "darwin") return null;
  const codexHome = resolveCodexHomePath();
  const account = computeCodexKeychainAccount(codexHome);
  try {
    const secret = execSync(`security find-generic-password -s "Codex Auth" -a "${account}" -w`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const parsed = JSON.parse(secret);
    return normalizeCodexJson(parsed, "keychain");
  } catch {
    return null;
  }
}

function normalizeCodexJson(data, source) {
  if (!data || typeof data !== "object") return null;
  const tokens = data.tokens;
  const access = tokens?.access_token;
  const refresh = tokens?.refresh_token;
  const openaiApiKey = typeof data.OPENAI_API_KEY === "string" ? data.OPENAI_API_KEY.trim() : "";
  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;

  const result = {
    source,
    hasAuthFile: source === "file",
    hasAccessToken: typeof access === "string" && access.length > 0,
    hasRefreshToken: typeof refresh === "string" && refresh.length > 0,
    hasOpenaiApiKey: openaiApiKey.length > 0,
    openaiApiKey: openaiApiKey || null,
    oauth: null,
  };

  if (typeof access === "string" && access && typeof refresh === "string" && refresh) {
    let fallbackExpiry = Date.now() + 60 * 60 * 1000;
    if (source === "file") {
      try {
        fallbackExpiry = fs.statSync(resolveCodexCliAuthPath()).mtimeMs + 60 * 60 * 1000;
      } catch {
        // keep default
      }
    } else {
      const lastRefreshRaw = data.last_refresh;
      const lastRefresh =
        typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
          ? new Date(lastRefreshRaw).getTime()
          : Date.now();
      if (Number.isFinite(lastRefresh)) {
        fallbackExpiry = lastRefresh + 60 * 60 * 1000;
      }
    }

    result.oauth = {
      type: "oauth",
      provider: "openai-codex",
      access,
      refresh,
      expires: decodeJwtExpiryMs(access) ?? fallbackExpiry,
      ...(accountId ? { accountId } : {}),
    };
  }

  return result;
}

function readCodexFileCredentials() {
  const authPath = resolveCodexCliAuthPath();
  if (!fs.existsSync(authPath)) {
    return null;
  }
  const parsed = readJsonFile(authPath);
  return normalizeCodexJson(parsed, "file");
}

function readCodexCredentials() {
  return readCodexKeychainCredentials() ?? readCodexFileCredentials();
}

async function main() {
  const command = process.argv[2] ?? "status";
  const creds = readCodexCredentials();

  if (command === "status") {
    const payload = creds ?? {
      source: null,
      hasAuthFile: fs.existsSync(resolveCodexCliAuthPath()),
      hasAccessToken: false,
      hasRefreshToken: false,
      hasOpenaiApiKey: false,
      openaiApiKey: null,
      oauth: null,
    };
    process.stdout.write(
      JSON.stringify({
        hasAuthFile: payload.hasAuthFile,
        hasAccessToken: payload.hasAccessToken,
        hasRefreshToken: payload.hasRefreshToken,
        hasOpenaiApiKey: payload.hasOpenaiApiKey,
        canExchangeOauth: Boolean(payload.oauth),
        source: payload.source,
      }),
    );
    return;
  }

  if (command === "exchange") {
    if (!creds) {
      process.stdout.write(JSON.stringify({ ok: false, message: "Codex auth not found." }));
      return;
    }

    if (creds.openaiApiKey) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          mode: "api_key",
          apiKey: creds.openaiApiKey,
          source: creds.source,
        }),
      );
      return;
    }

    if (!creds.oauth) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          message: "Codex auth did not include reusable OAuth credentials.",
        }),
      );
      return;
    }

    const result = await getOAuthApiKey("openai-codex", { "openai-codex": creds.oauth });
    if (!result?.apiKey) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          message: "Failed to exchange Codex OAuth credentials for an API key.",
        }),
      );
      return;
    }

    process.stdout.write(
      JSON.stringify({
        ok: true,
        mode: "oauth_exchange",
        apiKey: result.apiKey,
        source: creds.source,
        newCredentials: result.newCredentials ?? null,
      }),
    );
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(2);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
