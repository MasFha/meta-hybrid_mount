import { APP_VERSION } from "../../constants_gen";
import { AppError } from "./error";
import { shellEscapeDoubleQuoted } from "./shell";

interface KsuExecResult {
  errno: number;
  stdout: string;
  stderr: string;
}

interface KsuModule {
  exec: (cmd: string, options?: unknown) => Promise<KsuExecResult>;
}

interface WebuiSession {
  base_url: string;
  token: string;
}

// Discriminated union matching Rust DaemonCommand #[serde(tag = "type", rename_all = "kebab-case")]
export type DaemonCommandPayload =
  | { type: "ping" }
  | { type: "webui-start" }
  | { type: "shutdown" }
  | { type: "status" }
  | { type: "api-storage" }
  | { type: "api-mount-stats" }
  | { type: "api-mount-topology" }
  | { type: "api-partitions" }
  | { type: "api-system-info" }
  | { type: "api-version" }
  | { type: "api-config-get" }
  | { type: "api-config-set"; config: unknown }
  | { type: "api-config-patch"; patch: unknown; apply_runtime?: boolean }
  | { type: "api-config-reset" }
  | { type: "api-modules-list"; path?: string | null }
  | { type: "api-modules-apply"; modules: unknown[] }
  | { type: "api-lkm" }
  | { type: "api-hooks" }
  | { type: "api-kernel-uname" }
  | { type: "api-open-url"; url: string }
  | { type: "api-reboot" }
  | { type: "api-kasumi-maps-add"; rule: unknown }
  | { type: "api-kasumi-maps-clear" }
  | { type: "kasumi-status" }
  | { type: "kasumi-list" }
  | { type: "kasumi-version" }
  | { type: "kasumi-features" }
  | { type: "kasumi-hooks" }
  | { type: "kasumi-apply-config-runtime" }
  | { type: "kasumi-clear" }
  | { type: "kasumi-release-connection" }
  | { type: "kasumi-invalidate-cache" }
  | { type: "kasumi-fix-mounts" }
  | { type: "kasumi-restore-uname-global" }
  | { type: "kasumi-set-uname"; mode: string; release: string; version: string }
  | { type: "kasumi-clear-uname"; mode: string }
  | { type: "kasumi-rule-add"; target: string; source: string; file_type?: number }
  | { type: "kasumi-rule-merge"; target: string; source: string }
  | { type: "kasumi-rule-hide"; path: string }
  | { type: "kasumi-rule-delete"; path: string }
  | { type: "kasumi-rule-add-dir"; target_base: string; source_dir: string }
  | { type: "kasumi-rule-remove-dir"; target_base: string; source_dir: string }
  | { type: "hide-list" }
  | { type: "hide-add"; path: string }
  | { type: "hide-remove"; path: string }
  | { type: "hide-apply" }
  | { type: "lkm-status" }
  | { type: "lkm-load" }
  | { type: "lkm-unload" };

let ksuExec: KsuModule["exec"] | null = null;

interface MockModeEnv {
  MODE?: string;
  DEV?: boolean;
  VITE_USE_MOCK?: string;
}

function hasKsuBridge(): boolean {
  const bridge = (globalThis as { ksu?: unknown }).ksu;
  return typeof bridge === "object" && bridge !== null && "exec" in bridge;
}

if (hasKsuBridge()) {
  try {
    const ksu = await import("kernelsu").catch(() => null);
    ksuExec = ksu ? ksu.exec : null;
  } catch {}
}

export function resolveShouldUseMock(env: MockModeEnv): boolean {
  const override = env.VITE_USE_MOCK?.trim().toLowerCase();
  if (override === "false" || override === "0" || override === "off") {
    return false;
  }
  if (override === "true" || override === "1" || override === "on") {
    return true;
  }
  return Boolean(env.DEV) || env.MODE === "test";
}

export const shouldUseMock = resolveShouldUseMock(import.meta.env);
export const defaultVersion = APP_VERSION;
export const hasExecBridge = Boolean(ksuExec);
const DAEMON_WAKE_TIMEOUT_MS = 5000;
const DAEMON_HTTP_TIMEOUT_MS = 30000;
const DAEMON_MODULES_TIMEOUT_MS = 15000;

let daemonReady: Promise<void> | null = null;
let webuiSession: WebuiSession | null = null;

function requireExec(): KsuModule["exec"] {
  if (!ksuExec) throw new AppError("No KSU environment");
  return ksuExec;
}

async function runCommand(command: string): Promise<KsuExecResult> {
  const exec = requireExec();
  return exec(command);
}

async function runCommandExpectOk(command: string): Promise<string> {
  const { errno, stdout, stderr } = await runCommand(command);
  if (errno === 0) return stdout;
  throw new AppError(stderr || `command failed: ${command}`, errno);
}

function hybridMountCommand(binaryPath: string, args: string): string {
  return `"${shellEscapeDoubleQuoted(binaryPath)}" ${args}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new AppError(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function readModuleProp(modulePath: string): Promise<string> {
  return runCommandExpectOk(
    `cat "${shellEscapeDoubleQuoted(modulePath)}/module.prop"`,
  );
}

export async function ensureDaemonAwake(binaryPath: string): Promise<void> {
  if (shouldUseMock || !hasExecBridge) return;
  if (!daemonReady) {
    daemonReady = (async () => {
      const raw = await withTimeout(
        runCommandExpectOk(hybridMountCommand(binaryPath, "daemon webui-start")),
        DAEMON_WAKE_TIMEOUT_MS,
        "hybrid-mount daemon wake timed out",
      );
      const payload = parseDaemonJsonOutput(raw);
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as WebuiSession).base_url !== "string" ||
        typeof (payload as WebuiSession).token !== "string"
      ) {
        throw new AppError("hybrid-mount daemon returned invalid WebUI session");
      }
      webuiSession = payload as WebuiSession;
    })().catch((error) => {
      daemonReady = null;
      webuiSession = null;
      throw error;
    });
  }
  return daemonReady;
}

function getStructuredError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  if (record.type === "error" && typeof record.error === "string") {
    return record.error;
  }
  if (record.ok === false && typeof record.error === "string") {
    return record.error;
  }
  return null;
}

export function parseDaemonJsonOutput(raw: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `Failed to parse hybrid-mount JSON output: ${error.message}`
        : "Failed to parse hybrid-mount JSON output",
    );
  }

  const structuredError = getStructuredError(payload);
  if (structuredError) {
    throw new AppError(structuredError);
  }

  return payload;
}

async function runDaemonHttp(
  session: WebuiSession,
  command: DaemonCommandPayload,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs =
    command.type === "api-modules-list"
      ? DAEMON_MODULES_TIMEOUT_MS
      : DAEMON_HTTP_TIMEOUT_MS;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let text: string;

  try {
    response = await fetch(`${session.base_url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ command }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(`daemon HTTP request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }

  const payload = parseDaemonJsonOutput(text);
  if (!response.ok) {
    throw new AppError(
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `daemon HTTP request failed: ${response.status}`,
    );
  }
  if (
    payload &&
    typeof payload === "object" &&
    "ok" in payload &&
    (payload as { ok?: unknown }).ok === true
  ) {
    return (payload as { data?: unknown }).data;
  }
  return payload;
}

function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function jsonArg(value: string | undefined, context: string): unknown {
  if (value === undefined) {
    throw new AppError(`${context} payload is missing`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `Failed to parse ${context} JSON: ${error.message}`
        : `Failed to parse ${context} JSON`,
    );
  }
}

function daemonCommandFromArgs(args: string): DaemonCommandPayload {
  const tokens = shellSplit(args);
  const [group, command] = tokens;

  if (group === "daemon") {
    if (command === "ping") return { type: "ping" };
    if (command === "status") return { type: "status" };
    if (command === "stop") return { type: "shutdown" };
  }

  if (group === "api") {
    switch (command) {
      case "storage":
        return { type: "api-storage" };
      case "mount-stats":
        return { type: "api-mount-stats" };
      case "mount-topology":
        return { type: "api-mount-topology" };
      case "partitions":
        return { type: "api-partitions" };
      case "system-info":
        return { type: "api-system-info" };
      case "version":
        return { type: "api-version" };
      case "config-get":
        return { type: "api-config-get" };
      case "config-set":
        return { type: "api-config-set", config: jsonArg(tokens[2], "config") };
      case "config-patch": {
        const applyRuntime = tokens[2] === "--apply-runtime";
        const payloadIndex = applyRuntime ? 3 : 2;
        return {
          type: "api-config-patch",
          patch: jsonArg(tokens[payloadIndex], "config patch"),
          apply_runtime: applyRuntime,
        };
      }
      case "config-reset":
        return { type: "api-config-reset" };
      case "modules-list": {
        const pathFlag = tokens.indexOf("--path");
        return {
          type: "api-modules-list",
          path: pathFlag >= 0 ? tokens[pathFlag + 1] : null,
        };
      }
      case "modules-apply":
        return {
          type: "api-modules-apply",
          modules: jsonArg(tokens[2], "modules"),
        };
      case "lkm":
        return { type: "api-lkm" };
      case "hooks":
        return { type: "api-hooks" };
      case "kernel-uname":
        return { type: "api-kernel-uname" };
      case "open-url":
        return { type: "api-open-url", url: tokens[2] ?? "" };
      case "reboot":
        return { type: "api-reboot" };
      case "kasumi-maps-add":
        return {
          type: "api-kasumi-maps-add",
          rule: jsonArg(tokens[2], "Kasumi maps rule"),
        };
      case "kasumi-maps-clear":
        return { type: "api-kasumi-maps-clear" };
    }
  }

  if (group === "kasumi") {
    switch (command) {
      case "status":
        return { type: "kasumi-status" };
      case "list":
        return { type: "kasumi-list" };
      case "version":
        return { type: "kasumi-version" };
      case "features":
        return { type: "kasumi-features" };
      case "hooks":
        return { type: "kasumi-hooks" };
      case "apply-config-runtime":
        return { type: "kasumi-apply-config-runtime" };
      case "clear":
        return { type: "kasumi-clear" };
      case "release-connection":
        return { type: "kasumi-release-connection" };
      case "invalidate-cache":
        return { type: "kasumi-invalidate-cache" };
      case "fix-mounts":
        return { type: "kasumi-fix-mounts" };
      case "restore-uname-global":
        return { type: "kasumi-restore-uname-global" };
      case "set-uname": {
        const modeFlag = tokens.indexOf("--mode");
        const mode = modeFlag >= 0 ? tokens[modeFlag + 1] : "scoped";
        const firstValue = modeFlag >= 0 ? modeFlag + 2 : 2;
        return {
          type: "kasumi-set-uname",
          mode,
          release: tokens[firstValue] ?? "",
          version: tokens[firstValue + 1] ?? "",
        };
      }
      case "clear-uname": {
        const modeFlag = tokens.indexOf("--mode");
        return {
          type: "kasumi-clear-uname",
          mode: modeFlag >= 0 ? (tokens[modeFlag + 1] ?? "scoped") : "scoped",
        };
      }
    }
  }

  if (group === "hide") {
    if (command === "list") return { type: "hide-list" };
    if (command === "add") return { type: "hide-add", path: tokens[2] ?? "" };
    if (command === "remove")
      return { type: "hide-remove", path: tokens[2] ?? "" };
    if (command === "apply") return { type: "hide-apply" };
  }

  if (group === "lkm") {
    if (command === "load") return { type: "lkm-load" };
    if (command === "unload") return { type: "lkm-unload" };
    if (command === "status") return { type: "lkm-status" };
  }

  throw new AppError(`Unsupported daemon bridge command: ${args}`);
}

export async function runHybridMountJson(
  args: string,
  binaryPath: string,
): Promise<unknown> {
  const command = daemonCommandFromArgs(args);
  return runDaemonCommand(command, binaryPath);
}

export async function runDaemonCommand(
  command: DaemonCommandPayload,
  binaryPath: string,
): Promise<unknown> {
  await ensureDaemonAwake(binaryPath);
  let lastError: unknown = null;
  let firstError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = webuiSession;
    if (!session) break;

    try {
      return await runDaemonHttp(session, command);
    } catch (error) {
      lastError = error;
      if (attempt === 0) firstError = error;
      if (
        error instanceof AppError &&
        error.message.includes("daemon HTTP request timed out")
      ) {
        throw error;
      }
      console.debug("daemon HTTP bridge request failed", error);
      daemonReady = null;
      webuiSession = null;

      if (attempt === 0) {
        await ensureDaemonAwake(binaryPath);
        continue;
      }
    }
  }

  if (lastError) {
    if (firstError && firstError !== lastError) {
      console.debug("original daemon error (retry also failed)", firstError);
    }
    throw lastError;
  }
  throw new AppError("hybrid-mount daemon WebUI session is unavailable");
}
