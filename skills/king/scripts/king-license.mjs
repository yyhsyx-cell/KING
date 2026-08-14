#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CLIENT_VERSION = "1.0.0";
export const DEVICE_KEYCHAIN_SERVICE = "ai.king.license.device-key";
export const ADMIN_KEYCHAIN_SERVICE = "ai.king.license.admin-token";
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;
export const MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_OFFLINE_ALLOWANCE_MS = 72 * 60 * 60 * 1000;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BUNDLED_CONFIG_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  "..",
  "king-public-config.json",
);
const KEYCHAIN_HELPER_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  "king-keychain-native",
);
const OPEN_HELPER_PATH = path.join(path.dirname(SCRIPT_PATH), "king-open-native");
const WINDOWS_HELPER_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  "king-windows.ps1",
);

export function defaultSupportDirForPlatform(
  platform = process.platform,
  env = process.env,
  homeDirectory = homedir(),
) {
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA ||
      path.win32.join(env.USERPROFILE || homeDirectory, "AppData", "Local");
    return path.win32.join(localAppData, "KING");
  }
  return path.join(homeDirectory, "Library", "Application Support", "KING");
}

export class KingClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "KingClientError";
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }
}

function resolvePaths(env = process.env) {
  const supportDir =
    env.KING_DATA_DIR || defaultSupportDirForPlatform(process.platform, env);
  return {
    supportDir,
    configPath: env.KING_CONFIG_PATH || path.join(supportDir, "config.json"),
    bundledConfigPath:
      env.KING_BUNDLED_CONFIG_PATH || BUNDLED_CONFIG_PATH,
    devicePath: path.join(supportDir, "device.json"),
    issuedDir: path.join(supportDir, "issued"),
    leasePath: path.join(supportDir, "license.jws"),
    pendingPath: path.join(supportDir, "pending-activation.json"),
    statePath: path.join(supportDir, "state.json"),
  };
}

function credentialStoreName() {
  return process.platform === "win32"
    ? "Windows Credential Manager"
    : "macOS Keychain";
}

function powershellExecutable(env = process.env) {
  if (env.KING_POWERSHELL_PATH) return env.KING_POWERSHELL_PATH;
  if (env.SystemRoot) {
    return path.win32.join(
      env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }
  return "powershell.exe";
}

async function runWindowsHelper(operation, args = [], options = {}) {
  return runProcess(
    powershellExecutable(options.env),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WINDOWS_HELPER_PATH,
      operation,
      ...args,
    ],
    options,
  );
}

async function protectLocalPath(localPath) {
  if (process.platform === "win32") {
    await runWindowsHelper("protect-path", [localPath]);
  } else {
    await chmod(localPath, 0o700);
  }
}

async function protectLocalFile(filePath) {
  if (process.platform === "win32") {
    await runWindowsHelper("protect-path", [filePath]);
  } else {
    await chmod(filePath, 0o600);
  }
}

async function ensurePrivateDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await protectLocalPath(directoryPath);
}

async function atomicWritePrivate(filePath, value) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
  await protectLocalFile(temporaryPath);
  await rename(temporaryPath, filePath);
  await protectLocalFile(filePath);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new KingClientError(
        "invalid_local_json",
        `KING local file is invalid JSON: ${filePath}`,
      );
    }
    throw error;
  }
}

async function unlinkIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function runProcess(command, args, { input, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else {
        reject(
          new KingClientError(
            "process_failed",
            `${path.basename(command)} exited with status ${code}`,
            { details: result },
          ),
        );
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function runBundledMacHelper(helperPath, args, options = {}) {
  try {
    await chmod(helperPath, 0o700);
  } catch (error) {
    throw new KingClientError(
      "helper_unavailable",
      `KING could not prepare its bundled macOS helper: ${path.basename(helperPath)}`,
      { cause: error },
    );
  }
  return runProcess(helperPath, args, options);
}

async function keychainGet(service, account) {
  try {
    const result =
      process.platform === "win32"
        ? await runWindowsHelper("credential-get", [service, account])
        : await runBundledMacHelper(KEYCHAIN_HELPER_PATH, [
            "get",
            service,
            account,
          ]);
    const encoded = result.stdout.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new KingClientError(
        "keychain_invalid_response",
        `${credentialStoreName()} returned invalid KING data.`,
      );
    }
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch (error) {
    if (error instanceof KingClientError && error.details?.code === 44) return null;
    if (error instanceof KingClientError && error.code === "keychain_invalid_response") {
      throw error;
    }
    throw new KingClientError(
      "keychain_unavailable",
      `KING could not read ${credentialStoreName()}.`,
      { cause: error },
    );
  }
}

async function keychainSet(service, account, secret) {
  try {
    const input = `${Buffer.from(secret, "utf8").toString("base64")}\n`;
    if (process.platform === "win32") {
      await runWindowsHelper("credential-set", [service, account], { input });
    } else {
      await runBundledMacHelper(KEYCHAIN_HELPER_PATH, ["set", service, account], {
        input,
      });
    }
  } catch (error) {
    throw new KingClientError(
      "keychain_unavailable",
      `KING could not write ${credentialStoreName()}.`,
      { cause: error },
    );
  }
}

function publicKeyFingerprint(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("base64url");
}

export function encodeDevicePrivateKey(privateKey) {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new KingClientError(
      "invalid_device_key",
      "KING installation key must be Ed25519.",
    );
  }
  return privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
}

export function decodeDevicePrivateKey(value) {
  try {
    const privateKey = value.includes("-----BEGIN PRIVATE KEY-----")
      ? createPrivateKey(value)
      : createPrivateKey({
          key: Buffer.from(value, "base64url"),
          format: "der",
          type: "pkcs8",
        });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return privateKey;
  } catch {
    throw new KingClientError(
      "invalid_device_key",
      `KING installation key in ${credentialStoreName()} is invalid. Ask an administrator to reset the device binding.`,
    );
  }
}

async function loadDevice(paths = resolvePaths()) {
  const device = await readJsonIfPresent(paths.devicePath);
  if (!device) return null;
  if (
    typeof device.installation_id !== "string" ||
    typeof device.public_key_pem !== "string" ||
    typeof device.fingerprint !== "string" ||
    publicKeyFingerprint(device.public_key_pem) !== device.fingerprint
  ) {
    throw new KingClientError(
      "invalid_device_metadata",
      "KING device metadata is invalid. An administrator must reset the device binding.",
    );
  }
  return device;
}

async function ensureDevice(paths = resolvePaths()) {
  const existing = await loadDevice(paths);
  if (existing) {
    const privateKeyValue = await keychainGet(
      DEVICE_KEYCHAIN_SERVICE,
      existing.installation_id,
    );
    if (!privateKeyValue) {
      throw new KingClientError(
        "device_key_missing",
        `KING installation key is missing from ${credentialStoreName()}. Ask an administrator to reset the device binding.`,
      );
    }
    const privateKey = decodeDevicePrivateKey(privateKeyValue);
    const restoredPublicKeyPem = createPublicKey(privateKey).export({
      format: "pem",
      type: "spki",
    });
    if (publicKeyFingerprint(restoredPublicKeyPem) !== existing.fingerprint) {
      throw new KingClientError(
        "device_key_mismatch",
        "KING installation key does not match this device. Ask an administrator to reset the device binding.",
      );
    }
    return { ...existing, private_key: privateKey };
  }

  const installationId = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const fingerprint = publicKeyFingerprint(publicKeyPem);

  await keychainSet(
    DEVICE_KEYCHAIN_SERVICE,
    installationId,
    encodeDevicePrivateKey(privateKey),
  );
  const metadata = {
    version: 1,
    installation_id: installationId,
    public_key_pem: publicKeyPem,
    fingerprint,
    created_at: new Date().toISOString(),
  };
  await atomicWritePrivate(paths.devicePath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { ...metadata, private_key: privateKey };
}

function isLoopbackHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

export function validateServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new KingClientError("invalid_server_url", "KING server URL is invalid.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new KingClientError(
      "invalid_server_url",
      "KING server URL must be an origin without credentials, path, query, or fragment.",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new KingClientError(
      "insecure_server_url",
      "KING requires HTTPS except for a loopback development server.",
    );
  }
  return url.origin;
}

function validatePublicKey(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new KingClientError(
      "invalid_signing_key",
      "KING signing public key must be Ed25519.",
    );
  }
  return key;
}

export async function loadConfig(paths = resolvePaths()) {
  const config =
    (await readJsonIfPresent(paths.configPath)) ||
    (await readJsonIfPresent(paths.bundledConfigPath || BUNDLED_CONFIG_PATH));
  if (!config) return null;
  const serverUrl = validateServerUrl(config.server_url);
  if (
    !config.signing_public_keys ||
    typeof config.signing_public_keys !== "object" ||
    Array.isArray(config.signing_public_keys) ||
    Object.keys(config.signing_public_keys).length === 0
  ) {
    throw new KingClientError(
      "invalid_config",
      "KING config must contain signing_public_keys.",
    );
  }
  for (const [kid, publicKeyPem] of Object.entries(config.signing_public_keys)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid) || typeof publicKeyPem !== "string") {
      throw new KingClientError("invalid_config", "KING signing key metadata is invalid.");
    }
    validatePublicKey(publicKeyPem);
  }
  return { server_url: serverUrl, signing_public_keys: config.signing_public_keys };
}

function decodeJsonSegment(segment, label) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new KingClientError("invalid_license", `KING license ${label} is invalid.`);
  }
}

function parseIsoDate(value, field) {
  if (typeof value !== "string") {
    throw new KingClientError("invalid_license", `KING license ${field} is missing.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new KingClientError("invalid_license", `KING license ${field} is invalid.`);
  }
  return time;
}

export function verifyLeaseToken(token, config, expectedFingerprint) {
  if (typeof token !== "string") {
    throw new KingClientError("invalid_license", "KING license token is missing.");
  }
  const segments = token.trim().split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new KingClientError("invalid_license", "KING license token is malformed.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJsonSegment(encodedHeader, "header");
  const payload = decodeJsonSegment(encodedPayload, "payload");
  if (
    header.alg !== "EdDSA" ||
    header.typ !== "KING-LICENSE" ||
    typeof header.kid !== "string"
  ) {
    throw new KingClientError("invalid_license", "KING license header is not supported.");
  }
  const publicKeyPem = config.signing_public_keys[header.kid];
  if (!publicKeyPem) {
    throw new KingClientError(
      "unknown_signing_key",
      "KING license was signed by an unknown key. Refresh the trusted public-key configuration.",
    );
  }
  const signatureValid = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    validatePublicKey(publicKeyPem),
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!signatureValid) {
    throw new KingClientError("invalid_license_signature", "KING license signature is invalid.");
  }
  if (
    payload.version !== 1 ||
    typeof payload.license_id !== "string" ||
    !["month", "permanent"].includes(payload.plan) ||
    typeof payload.installation_fingerprint !== "string" ||
    payload.installation_fingerprint !== expectedFingerprint
  ) {
    throw new KingClientError(
      "license_device_mismatch",
      "KING license does not belong to this installation.",
    );
  }
  const issuedAt = parseIsoDate(payload.issued_at, "issued_at");
  const nextCheckAt = parseIsoDate(payload.next_check_at, "next_check_at");
  const offlineUntil = parseIsoDate(payload.offline_until, "offline_until");
  const licenseExpiresAt =
    payload.license_expires_at === null
      ? null
      : parseIsoDate(payload.license_expires_at, "license_expires_at");
  if (
    nextCheckAt < issuedAt ||
    offlineUntil < nextCheckAt ||
    nextCheckAt - issuedAt > MAX_REFRESH_INTERVAL_MS ||
    offlineUntil - issuedAt > MAX_OFFLINE_ALLOWANCE_MS
  ) {
    throw new KingClientError("invalid_license", "KING license time bounds are invalid.");
  }
  if (payload.plan === "month" && licenseExpiresAt === null) {
    throw new KingClientError("invalid_license", "KING monthly license has no expiration.");
  }
  if (payload.plan === "permanent" && licenseExpiresAt !== null) {
    throw new KingClientError("invalid_license", "KING permanent license has an expiration.");
  }
  return {
    header,
    payload,
    times: { issuedAt, nextCheckAt, offlineUntil, licenseExpiresAt },
  };
}

export function evaluateLease({ verifiedLease, nowMs, lastObservedAtMs = null }) {
  const { payload, times } = verifiedLease;
  if (
    Number.isFinite(lastObservedAtMs) &&
    nowMs + CLOCK_ROLLBACK_TOLERANCE_MS < lastObservedAtMs
  ) {
    return {
      status: "clock_rollback",
      refreshRequired: true,
      message: "The local clock moved backwards. KING requires an online license refresh.",
    };
  }
  if (times.licenseExpiresAt !== null && nowMs >= times.licenseExpiresAt) {
    return {
      status: "expired",
      refreshRequired: false,
      message: "The KING monthly license has expired.",
    };
  }
  if (nowMs <= times.nextCheckAt) {
    return {
      status: "active",
      refreshRequired: false,
      message: "KING license is active.",
      license_id: payload.license_id,
      plan: payload.plan,
    };
  }
  if (nowMs <= times.offlineUntil) {
    return {
      status: "offline_grace",
      refreshRequired: true,
      message: "KING needs an online refresh but remains inside the signed offline allowance.",
      license_id: payload.license_id,
      plan: payload.plan,
    };
  }
  return {
    status: "offline_grace_exceeded",
    refreshRequired: true,
    message: "KING's signed offline allowance has ended. Connect to the license server.",
    license_id: payload.license_id,
    plan: payload.plan,
  };
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      signal: options.signal || AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new KingClientError("network_unavailable", "KING license server is unavailable.", {
      cause: error,
    });
  }
  let body = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      body = await response.json();
    } catch {
      throw new KingClientError(
        "invalid_server_response",
        "KING license server returned invalid JSON.",
        { status: response.status },
      );
    }
  }
  if (!response.ok) {
    throw new KingClientError(
      body?.code || "license_server_error",
      body?.message || `KING license server rejected the request (${response.status}).`,
      { status: response.status },
    );
  }
  return { body, status: response.status };
}

async function retrySafeNetwork(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof KingClientError) || error.code !== "network_unavailable") {
        throw error;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      }
    }
  }
  throw lastError;
}

function refreshProofMessage(licenseId, timestamp, nonce) {
  return Buffer.from(`KING-REFRESH\n${licenseId}\n${timestamp}\n${nonce}`, "utf8");
}

async function refreshLease({ config, device, verifiedLease, paths, now = new Date() }) {
  const nonce = randomBytes(32).toString("base64url");
  const timestamp = now.toISOString();
  const signature = sign(
    null,
    refreshProofMessage(verifiedLease.payload.license_id, timestamp, nonce),
    device.private_key,
  ).toString("base64url");
  const { body } = await fetchJson(`${config.server_url}/v1/licenses/refresh`, {
    method: "POST",
    body: JSON.stringify({
      license_id: verifiedLease.payload.license_id,
      nonce,
      timestamp,
      signature,
    }),
  });
  const refreshed = verifyLeaseToken(body?.license, config, device.fingerprint);
  await atomicWritePrivate(paths.leasePath, `${body.license}\n`);
  return refreshed;
}

async function updateObservedClock(paths, nowMs) {
  const state = (await readJsonIfPresent(paths.statePath)) || {};
  const previous = Date.parse(state.last_observed_at || "");
  if (!Number.isFinite(previous) || nowMs > previous) {
    await atomicWritePrivate(
      paths.statePath,
      `${JSON.stringify({ version: 1, last_observed_at: new Date(nowMs).toISOString() }, null, 2)}\n`,
    );
  }
  return Number.isFinite(previous) ? previous : null;
}

export async function getLicenseStatus({
  paths = resolvePaths(),
  now = new Date(),
  refresh = true,
} = {}) {
  const config = await loadConfig(paths);
  if (!config) {
    return {
      ok: false,
      status: "configuration_required",
      message: "KING license server is not configured.",
      action: "Run king-license configure with the HTTPS server URL and pinned public key.",
    };
  }
  const pending = await readJsonIfPresent(paths.pendingPath);
  let token;
  try {
    token = (await readFile(paths.leasePath, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!token) {
    if (pending && Date.parse(pending.expires_at) > now.getTime()) {
      return {
        ok: false,
        status: "activation_pending",
        message: "KING activation is waiting for the secure browser page.",
        action: "Run king-license poll --json after completing the activation page.",
      };
    }
    if (pending) await unlinkIfPresent(paths.pendingPath);
    return {
      ok: false,
      status: "inactive",
      message: "KING has not been activated on this installation.",
      action: "Run king-license activate --open --json.",
    };
  }
  const device = await ensureDevice(paths);
  const verified = verifyLeaseToken(token, config, device.fingerprint);
  const nowMs = now.getTime();
  const state = await readJsonIfPresent(paths.statePath);
  const lastObservedAtMs = Date.parse(state?.last_observed_at || "");
  let evaluation = evaluateLease({
    verifiedLease: verified,
    nowMs,
    lastObservedAtMs: Number.isFinite(lastObservedAtMs) ? lastObservedAtMs : null,
  });
  if (evaluation.refreshRequired && refresh) {
    try {
      const refreshed = await refreshLease({ config, device, verifiedLease: verified, paths, now });
      evaluation = evaluateLease({ verifiedLease: refreshed, nowMs });
    } catch (error) {
      const serverUnavailable =
        error instanceof KingClientError &&
        (error.code === "network_unavailable" || Number(error.status) >= 500);
      if (!serverUnavailable) {
        if (error instanceof KingClientError && ["license_revoked", "license_expired"].includes(error.code)) {
          return {
            ok: false,
            status: error.code === "license_revoked" ? "revoked" : "expired",
            message: error.message,
          };
        }
        throw error;
      }
      if (evaluation.status === "clock_rollback") return { ok: false, ...evaluation };
    }
  }
  await updateObservedClock(paths, nowMs);
  return {
    ok: ["active", "offline_grace"].includes(evaluation.status),
    ...evaluation,
  };
}

function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      options[rawName] = inlineValue;
      continue;
    }
    if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options[rawName] = argv[index + 1];
      index += 1;
    } else {
      options[rawName] = true;
    }
  }
  return { positional, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new KingClientError("missing_option", `Missing required option --${name}.`);
  }
  return value;
}

async function commandDependencies() {
  const result = await runProcess("codex", ["plugin", "list", "--json"]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new KingClientError(
      "plugin_list_invalid",
      "Codex returned an invalid plugin list.",
    );
  }
  const required = [
    "computer-use@openai-bundled",
    "chrome@openai-bundled",
  ];
  const installed = Array.isArray(parsed.installed) ? parsed.installed : [];
  const missing = [];
  const disabled = [];
  for (const pluginId of required) {
    const plugin = installed.find((entry) => entry.pluginId === pluginId);
    if (!plugin?.installed) missing.push(pluginId);
    else if (!plugin.enabled) disabled.push(pluginId);
  }
  return {
    ok: missing.length === 0 && disabled.length === 0,
    status: missing.length ? "missing_dependencies" : disabled.length ? "disabled_dependencies" : "ready",
    missing,
    disabled,
    install_commands: missing.map((pluginId) => `codex plugin add ${pluginId}`),
    message:
      missing.length || disabled.length
        ? "KING requires both OpenAI bundled capabilities."
        : "KING dependencies are installed and enabled.",
  };
}

async function commandConfigure(options, paths) {
  const serverUrl = validateServerUrl(requireOption(options, "server"));
  const kid = requireOption(options, "kid");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) {
    throw new KingClientError("invalid_kid", "Signing key id is invalid.");
  }
  const publicKeyPem = await readFile(requireOption(options, "public-key-file"), "utf8");
  validatePublicKey(publicKeyPem);
  const existing = (await readJsonIfPresent(paths.configPath)) || {};
  const config = {
    server_url: serverUrl,
    signing_public_keys: {
      ...(existing.signing_public_keys || {}),
      [kid]: publicKeyPem,
    },
  };
  await atomicWritePrivate(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    ok: true,
    status: "configured",
    server_url: serverUrl,
    signing_key_id: kid,
    message: "KING license server configuration was saved.",
  };
}

export function assertActivationUrl(activationUrl, serverUrl, activationId) {
  const activation = new URL(activationUrl);
  const server = new URL(serverUrl);
  const validActivationId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      activationId,
    );
  const legacyPath =
    activation.search === "" &&
    activation.pathname === `/activate/${activationId}`;
  const rootEntry =
    activation.pathname === "/" &&
    activation.searchParams.size === 1 &&
    activation.searchParams.get("activation") === activationId;
  if (
    !validActivationId ||
    activation.origin !== server.origin ||
    activation.username ||
    activation.password ||
    (!legacyPath && !rootEntry) ||
    !/^#[A-Za-z0-9_-]{32,256}$/.test(activation.hash)
  ) {
    throw new KingClientError(
      "invalid_activation_url",
      "KING server returned an unsafe activation URL.",
    );
  }
  return activation.toString();
}

export function assertAdminLoginUrl(loginUrl, serverUrl) {
  const login = new URL(loginUrl);
  const server = new URL(serverUrl);
  if (
    login.origin !== server.origin ||
    login.username ||
    login.password ||
    login.search ||
    login.pathname !== "/admin" ||
    !/^#[A-Za-z0-9_-]{32,256}$/.test(login.hash)
  ) {
    throw new KingClientError(
      "invalid_admin_login_url",
      "KING server returned an unsafe administrator login URL.",
    );
  }
  return login.toString();
}

async function openActivationUrl(activationUrl) {
  try {
    const input = `${Buffer.from(activationUrl, "utf8").toString("base64")}\n`;
    if (process.platform === "win32") {
      await runWindowsHelper("open-url", [], { input });
    } else {
      await runBundledMacHelper(OPEN_HELPER_PATH, [], { input });
    }
  } catch (error) {
    throw new KingClientError(
      "activation_open_failed",
      "KING could not open the secure activation page.",
      { cause: error },
    );
  }
}

async function commandActivate(options, paths) {
  const config = await loadConfig(paths);
  if (!config) {
    throw new KingClientError(
      "configuration_required",
      "KING license server is not configured.",
    );
  }
  if (!options.open) {
    throw new KingClientError(
      "secure_open_required",
      "KING activation must be opened directly with --open so its secret is not printed.",
    );
  }
  const device = await ensureDevice(paths);
  const { body } = await retrySafeNetwork(() =>
    fetchJson(`${config.server_url}/v1/activations/start`, {
      method: "POST",
      body: JSON.stringify({
        installation_id: device.installation_id,
        installation_public_key: device.public_key_pem,
        installation_fingerprint: device.fingerprint,
        client_version: CLIENT_VERSION,
      }),
    }),
  );
  if (
    typeof body?.activation_id !== "string" ||
    typeof body?.activation_url !== "string" ||
    typeof body?.poll_token !== "string" ||
    !Number.isFinite(Date.parse(body?.expires_at))
  ) {
    throw new KingClientError(
      "invalid_server_response",
      "KING server returned invalid activation data.",
    );
  }
  const activationUrl = assertActivationUrl(
    body.activation_url,
    config.server_url,
    body.activation_id,
  );
  await atomicWritePrivate(
    paths.pendingPath,
    `${JSON.stringify(
      {
        version: 1,
        activation_id: body.activation_id,
        poll_token: body.poll_token,
        expires_at: body.expires_at,
      },
      null,
      2,
    )}\n`,
  );
  await openActivationUrl(activationUrl);
  return {
    ok: true,
    status: "activation_pending",
    activation_id: body.activation_id,
    opened: true,
    expires_at: body.expires_at,
    message: "The secure KING activation page was opened. Enter the code there, then invoke KING again.",
  };
}

async function commandPoll(paths) {
  const config = await loadConfig(paths);
  if (!config) {
    throw new KingClientError(
      "configuration_required",
      "KING license server is not configured.",
    );
  }
  const pending = await readJsonIfPresent(paths.pendingPath);
  if (!pending) {
    return {
      ok: false,
      status: "inactive",
      message: "No KING activation is pending.",
      action: "Run king-license activate --open --json.",
    };
  }
  if (Date.parse(pending.expires_at) <= Date.now()) {
    await unlinkIfPresent(paths.pendingPath);
    return {
      ok: false,
      status: "inactive",
      message: "The KING activation session expired.",
      action: "Run king-license activate --open --json again.",
    };
  }
  let response;
  try {
    response = await fetchJson(
      `${config.server_url}/v1/activations/${encodeURIComponent(pending.activation_id)}`,
      { headers: { authorization: `Bearer ${pending.poll_token}` } },
    );
  } catch (error) {
    if (error instanceof KingClientError && error.status === 202) {
      return {
        ok: false,
        status: "activation_pending",
        message: "KING activation has not been completed yet.",
      };
    }
    throw error;
  }
  if (response.body?.status === "pending") {
    return {
      ok: false,
      status: "activation_pending",
      message: "KING activation has not been completed yet.",
    };
  }
  const device = await ensureDevice(paths);
  verifyLeaseToken(response.body?.license, config, device.fingerprint);
  await atomicWritePrivate(paths.leasePath, `${response.body.license}\n`);
  await unlinkIfPresent(paths.pendingPath);
  return {
    ok: true,
    status: "active",
    license_id: response.body.license_id,
    plan: response.body.plan,
    message: "KING activation completed.",
  };
}

function adminAccount(serverUrl) {
  return createHash("sha256").update(serverUrl).digest("hex").slice(0, 24);
}

async function readHiddenSecret(promptText) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new KingClientError(
      "interactive_terminal_required",
      "Run this command directly in a terminal so the secret can be entered without echo.",
    );
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const previousRaw = input.isRaw;
    let secret = "";
    process.stdout.write(promptText);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new KingClientError("cancelled", "Secret entry was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(secret);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          secret = secret.slice(0, -1);
        } else {
          secret += character;
        }
      }
    };
    input.on("data", onData);
  });
}

async function getAdminToken(config) {
  const token = await keychainGet(
    ADMIN_KEYCHAIN_SERVICE,
    adminAccount(config.server_url),
  );
  if (!token) {
    throw new KingClientError(
      "admin_token_missing",
      "KING administrator token is not stored. Run king-license admin set-token in a terminal.",
    );
  }
  return token;
}

async function commandAdminSetToken(paths) {
  const config = await loadConfig(paths);
  if (!config) {
    throw new KingClientError(
      "configuration_required",
      "KING license server is not configured.",
    );
  }
  const token = await readHiddenSecret("KING administrator token: ");
  if (token.length < 32) {
    throw new KingClientError(
      "weak_admin_token",
      "KING administrator token must contain at least 32 characters.",
    );
  }
  await keychainSet(ADMIN_KEYCHAIN_SERVICE, adminAccount(config.server_url), token);
  return {
    ok: true,
    status: "admin_token_stored",
    message: `KING administrator token was stored in ${credentialStoreName()}.`,
  };
}

async function adminRequest(config, route, options = {}) {
  const token = await getAdminToken(config);
  return fetchJson(`${config.server_url}${route}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
  });
}

async function commandAdminOpen(paths) {
  const config = await loadConfig(paths);
  if (!config) {
    throw new KingClientError(
      "configuration_required",
      "KING license server is not configured.",
    );
  }
  const { body } = await retrySafeNetwork(() =>
    adminRequest(config, "/v1/admin/sessions/start", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  );
  if (
    typeof body?.login_url !== "string" ||
    !Number.isFinite(Date.parse(body?.expires_at))
  ) {
    throw new KingClientError(
      "invalid_server_response",
      "KING server returned invalid administrator login data.",
    );
  }
  const loginUrl = assertAdminLoginUrl(body.login_url, config.server_url);
  await openActivationUrl(loginUrl);
  return {
    ok: true,
    status: "admin_opened",
    opened: true,
    message: "KING 管理后台已在浏览器打开。",
  };
}

async function commandAdminIssue(options, paths) {
  const config = await loadConfig(paths);
  if (!config) {
    throw new KingClientError(
      "configuration_required",
      "KING license server is not configured.",
    );
  }
  const plan = requireOption(options, "plan");
  if (!["month", "permanent"].includes(plan)) {
    throw new KingClientError("invalid_plan", "Plan must be month or permanent.");
  }
  const count = Number.parseInt(requireOption(options, "count"), 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new KingClientError("invalid_count", "Count must be an integer from 1 to 100.");
  }
  const { body } = await adminRequest(config, "/v1/admin/codes", {
    method: "POST",
    body: JSON.stringify({ plan, quantity: count }),
  });
  if (
    typeof body?.batch_id !== "string" ||
    !Array.isArray(body.codes) ||
    body.codes.length !== count ||
    body.codes.some((code) => typeof code !== "string")
  ) {
    throw new KingClientError(
      "invalid_server_response",
      "KING server returned an invalid code batch.",
    );
  }
  await ensurePrivateDirectory(paths.issuedDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const batchSuffix = createHash("sha256")
    .update(body.batch_id)
    .digest("hex")
    .slice(0, 12);
  const filePath = path.join(
    paths.issuedDir,
    `${timestamp}-${plan}-${count}-${batchSuffix}.json`,
  );
  await atomicWritePrivate(
    filePath,
    `${JSON.stringify(
      {
        batch_id: body.batch_id,
        plan,
        issued_at: body.issued_at,
        codes: body.codes,
      },
      null,
      2,
    )}\n`,
  );
  return {
    ok: true,
    status: "codes_issued",
    batch_id: body.batch_id,
    plan,
    count,
    file_path: filePath,
    message: "KING codes were written to an owner-only local file.",
  };
}

async function commandAdminLicenseAction(action, options, paths) {
  const config = await loadConfig(paths);
  if (!config) {
    throw new KingClientError(
      "configuration_required",
      "KING license server is not configured.",
    );
  }
  const licenseId = requireOption(options, "license-id");
  const routeAction = action === "revoke" ? "revoke" : "reset-device";
  const { body } = await adminRequest(
    config,
    `/v1/admin/licenses/${encodeURIComponent(licenseId)}/${routeAction}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return {
    ok: true,
    status: body?.status || (action === "revoke" ? "revoked" : "awaiting_rebind"),
    license_id: licenseId,
    message:
      action === "revoke"
        ? "KING license was revoked."
        : "KING device binding was reset without extending the license term.",
  };
}

function renderResult(result, jsonMode) {
  if (jsonMode) return `${JSON.stringify(result)}\n`;
  const lines = [result.message || result.status || "KING command completed."];
  if (result.file_path) lines.push(`File: ${result.file_path}`);
  return `${lines.join("\n")}\n`;
}

function safeErrorResult(error) {
  if (error instanceof KingClientError) {
    return {
      ok: false,
      status: error.code,
      message: error.message,
      ...(error.status ? { http_status: error.status } : {}),
    };
  }
  return {
    ok: false,
    status: "unexpected_error",
    message: "KING encountered an unexpected local error.",
  };
}

export async function runCli(argv = process.argv.slice(2), paths = resolvePaths()) {
  const { positional, options } = parseOptions(argv);
  const [command, subcommand] = positional;
  switch (command) {
    case "dependencies":
      return commandDependencies();
    case "configure":
      return commandConfigure(options, paths);
    case "status":
      return getLicenseStatus({ paths });
    case "activate":
      return commandActivate(options, paths);
    case "poll":
      return commandPoll(paths);
    case "admin":
      if (subcommand === "set-token") return commandAdminSetToken(paths);
      if (subcommand === "open") return commandAdminOpen(paths);
      if (subcommand === "issue") return commandAdminIssue(options, paths);
      if (subcommand === "revoke") {
        return commandAdminLicenseAction("revoke", options, paths);
      }
      if (subcommand === "reset-device") {
        return commandAdminLicenseAction("reset-device", options, paths);
      }
      throw new KingClientError("unknown_command", "Unknown KING administrator command.");
    default:
      throw new KingClientError(
        "unknown_command",
        "Usage: king-license <dependencies|configure|status|activate|poll|admin> [options]",
      );
  }
}

async function main() {
  const jsonMode = process.argv.includes("--json");
  try {
    const result = await runCli();
    process.stdout.write(renderResult(result, jsonMode));
    process.exitCode = result.ok === false ? 2 : 0;
  } catch (error) {
    const result = safeErrorResult(error);
    process.stdout.write(renderResult(result, jsonMode));
    process.exitCode = 1;
  }
}

export async function isMainScript(candidatePath = process.argv[1]) {
  if (!candidatePath) return false;
  try {
    return (await realpath(candidatePath)) === (await realpath(SCRIPT_PATH));
  } catch {
    return path.resolve(candidatePath) === path.resolve(SCRIPT_PATH);
  }
}

if (await isMainScript()) {
  await main();
}
