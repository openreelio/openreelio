import { Buffer } from "node:buffer";
import { execFile, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { complete, getModel, getModels } from "@mariozechner/pi-ai";
import { getOAuthApiKey, loginOpenAICodex } from "@mariozechner/pi-ai/oauth";

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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function exchangeOauth(oauth, source = "vault") {
  const result = await getOAuthApiKey("openai-codex", { "openai-codex": oauth });
  if (!result?.apiKey) {
    return {
      ok: false,
      message: "Failed to exchange Codex OAuth credentials for an API key.",
    };
  }

  return {
    ok: true,
    mode: "oauth_exchange",
    apiKey: result.apiKey,
    source,
    newCredentials: result.newCredentials ?? null,
  };
}

function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function normalizeCodexModels(models) {
  return [...new Set(models.map((model) => model.id).filter((id) => typeof id === "string" && id))]
    .sort((a, b) => a.localeCompare(b));
}

const DEFAULT_CODEX_SYSTEM_PROMPT = "You are OpenReelio's AI assistant.";

function buildCodexHistoryMessage(message, timestamp, index, modelId) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const content = typeof message?.content === "string" ? message.content : "";

  if (role === "assistant") {
    return {
      role: "assistant",
      content: content.length > 0 ? [{ type: "text", text: content }] : [],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: timestamp + index,
    };
  }

  return {
    role: "user",
    content,
    timestamp: timestamp + index,
  };
}

async function completeWithOauth(payload) {
  const oauth = payload?.oauth;
  const request = payload?.request;
  if (!oauth || !request || typeof request !== "object") {
    return {
      ok: false,
      message: "Both oauth and request are required.",
    };
  }

  const oauthResult = await getOAuthApiKey("openai-codex", { "openai-codex": oauth });
  if (!oauthResult?.apiKey) {
    return {
      ok: false,
      message: "Failed to exchange Codex OAuth credentials for a runtime key.",
    };
  }

  const modelId =
    typeof request.model === "string" && request.model.trim().length > 0 ? request.model.trim() : "gpt-5.4";
  const model = getModel("openai-codex", modelId);
  if (!model) {
    return {
      ok: false,
      message: `Unknown OpenAI Codex model: ${modelId}`,
    };
  }

  const timestamp = Date.now();
  const messages = Array.isArray(request.messages) && request.messages.length > 0
    ? request.messages.map((message, index) => buildCodexHistoryMessage(message, timestamp, index, modelId))
    : [
        {
          role: "user",
          content: typeof request.prompt === "string" ? request.prompt : "",
          timestamp,
        },
      ];

  const systemPromptParts = [];
  if (typeof request.system === "string" && request.system.trim().length > 0) {
    systemPromptParts.push(request.system.trim());
  }
  if (request.jsonMode) {
    systemPromptParts.push("Respond with valid JSON only.");
  }

  const response = await complete(
    model,
    {
      systemPrompt:
        systemPromptParts.length > 0
          ? systemPromptParts.join("\n\n")
          : DEFAULT_CODEX_SYSTEM_PROMPT,
      messages,
    },
    {
      apiKey: oauthResult.apiKey,
      ...(typeof request.maxTokens === "number" ? { maxTokens: request.maxTokens } : {}),
    },
  );

  return {
    ok: response.stopReason !== "error" && response.stopReason !== "aborted",
    provider: response.provider,
    api: response.api,
    model: response.model,
    text: extractAssistantText(response),
    usage: response.usage ?? null,
    stopReason: response.stopReason ?? null,
    errorMessage: response.errorMessage ?? null,
    newCredentials: oauthResult.newCredentials ?? null,
  };
}

function openExternalUrl(url) {
  return new Promise((resolve, reject) => {
    let command;
    let args;
    if (process.platform === "darwin") {
      command = "open";
      args = [url];
    } else if (process.platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    execFile(command, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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

    process.stdout.write(JSON.stringify(await exchangeOauth(creds.oauth, creds.source)));
    return;
  }

  if (command === "export-oauth") {
    if (!creds?.oauth) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          message: creds
            ? "Codex auth did not include reusable OAuth credentials."
            : "Codex auth not found.",
        }),
      );
      return;
    }

    process.stdout.write(
      JSON.stringify({
        ok: true,
        oauth: creds.oauth,
        source: creds.source,
      }),
    );
    return;
  }

  if (command === "exchange-oauth-stdin") {
    const raw = (await readStdin()).trim();
    if (!raw) {
      process.stdout.write(JSON.stringify({ ok: false, message: "No OAuth payload provided." }));
      return;
    }

    const oauth = JSON.parse(raw);
    process.stdout.write(JSON.stringify(await exchangeOauth(oauth, "vault")));
    return;
  }

  if (command === "list-models") {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        models: normalizeCodexModels(getModels("openai-codex")),
      }),
    );
    return;
  }

  if (command === "complete-oauth-stdin") {
    const raw = (await readStdin()).trim();
    if (!raw) {
      process.stdout.write(JSON.stringify({ ok: false, message: "No completion payload provided." }));
      return;
    }

    const payload = JSON.parse(raw);
    process.stdout.write(JSON.stringify(await completeWithOauth(payload)));
    return;
  }

  if (command === "login-oauth") {
    const credentials = await loginOpenAICodex({
      onAuth: async ({ url, instructions }) => {
        if (instructions) {
          process.stderr.write(`${instructions}\n`);
        }
        process.stderr.write(`Opening browser for OpenAI sign-in: ${url}\n`);
        await openExternalUrl(url);
      },
      onPrompt: async (prompt) => {
        throw new Error(
          `Manual OAuth prompt not supported in OpenReelio helper: ${prompt.message}`,
        );
      },
      onProgress: (message) => {
        if (message) {
          process.stderr.write(`${message}\n`);
        }
      },
    });

    process.stdout.write(
      JSON.stringify({
        ok: true,
        oauth: {
          type: "oauth",
          provider: "openai-codex",
          access: credentials.access,
          refresh: credentials.refresh,
          expires: credentials.expires,
          ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
        },
        source: "browser_oauth",
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
