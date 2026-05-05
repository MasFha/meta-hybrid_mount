import { APP_VERSION } from "../../constants_gen";
import { AppError } from "./error";

interface KsuExecResult {
  errno: number;
  stdout: string;
  stderr: string;
}

interface KsuModule {
  exec: (cmd: string, options?: unknown) => Promise<KsuExecResult>;
}

let ksuExec: KsuModule["exec"] | null = null;

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

export const shouldUseMock = import.meta.env.DEV && !ksuExec;
export const defaultVersion = APP_VERSION;
export const hasExecBridge = Boolean(ksuExec);

function requireExec(): KsuModule["exec"] {
  if (!ksuExec) throw new AppError("No KSU environment");
  return ksuExec;
}

export async function runCommand(command: string): Promise<KsuExecResult> {
  const exec = requireExec();
  return exec(command);
}

export async function runCommandExpectOk(command: string): Promise<string> {
  const { errno, stdout, stderr } = await runCommand(command);
  if (errno === 0) return stdout;
  throw new AppError(stderr || `command failed: ${command}`, errno);
}

export async function runHybridMountJson(
  args: string,
  binaryPath: string,
): Promise<unknown> {
  const raw = await runCommandExpectOk(`${binaryPath} ${args}`);
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `Failed to parse hybrid-mount JSON output: ${error.message}`
        : "Failed to parse hybrid-mount JSON output",
    );
  }
}
