import { runCommandExpectOk, runHybridMountJson } from "../core/bridge";
import { shellEscapeDoubleQuoted } from "../core/shell";
import { PATHS } from "../../constants";
import type {
  KernelUnameValues,
  KasumiStatus,
  KasumiUnameConfig,
} from "../../types";
import { loadConfigFromFile, mutateConfig } from "../repos/configRepo";
import { loadRuntimeState } from "../repos/runtimeRepo";
import {
  buildKasumiStatusFromPayload,
  buildKasumiStatusFromRuntimeState,
} from "../codec/runtimeCodec";
import { AppError } from "../core/error";

const KASUMI_MODULE_NAME = "kasumi_lkm";

async function applyKasumiRuntimeConfig(): Promise<void> {
  await runHybridMountJson("kasumi apply-config-runtime", PATHS.BINARY);
}

async function updateKasumiConfig(
  mutator: (config: Awaited<ReturnType<typeof loadConfigFromFile>>) => void,
  options: { applyRuntime?: boolean } = {},
): Promise<void> {
  await mutateConfig(mutator);
  if (options.applyRuntime !== false) {
    await applyKasumiRuntimeConfig();
  }
}

export async function getKasumiStatus(): Promise<KasumiStatus> {
  const [config, state] = await Promise.all([
    loadConfigFromFile(),
    loadRuntimeState(),
  ]);
  const payload = await runHybridMountJson("kasumi status", PATHS.BINARY);
  return (
    buildKasumiStatusFromPayload(payload, config.kasumi, state) ??
    buildKasumiStatusFromRuntimeState(config.kasumi, state, KASUMI_MODULE_NAME)
  );
}

export async function setKasumiEnabled(enabled: boolean): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.enabled = enabled;
  });
}

export async function setKasumiStealth(enabled: boolean): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.enable_stealth = enabled;
  });
}

export async function setKasumiHidexattr(enabled: boolean): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.enable_hidexattr = enabled;
  });
}

export async function setKasumiDebug(enabled: boolean): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.enable_kernel_debug = enabled;
  });
}

export async function getOriginalKernelUname(): Promise<KernelUnameValues> {
  const payload = await runHybridMountJson("daemon status", PATHS.BINARY);
  if (payload && typeof payload === "object") {
    const release = await runCommandExpectOk("cat /proc/sys/kernel/osrelease");
    const version = await runCommandExpectOk("cat /proc/sys/kernel/version");
    return { release: release.trim(), version: version.trim() };
  }
  throw new AppError("Failed to read original kernel uname values");
}

export async function setKasumiUnameMode(
  mode: "scoped" | "global",
): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.uname_mode = mode === "global" ? "global" : "scoped";
  });
}

export async function setKasumiUname(
  uname: Partial<KasumiUnameConfig>,
): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.uname = {
      ...config.kasumi.uname,
      ...uname,
    };
    config.kasumi.uname_release = config.kasumi.uname.release;
    config.kasumi.uname_version = config.kasumi.uname.version;
  });
}

export async function applyKasumiUname(
  mode: "scoped" | "global",
  uname: Pick<KasumiUnameConfig, "release" | "version">,
): Promise<void> {
  const release = uname.release.trim();
  const version = uname.version.trim();
  if (!release || !version) {
    throw new AppError("uname release and version must both be non-empty");
  }
  await runCommandExpectOk(
    `${PATHS.BINARY} kasumi set-uname --mode ${
      mode === "global" ? "global" : "scoped"
    } "${shellEscapeDoubleQuoted(release)}" "${shellEscapeDoubleQuoted(version)}"`,
  );
}

export async function clearKasumiUname(): Promise<void> {
  const previousConfig = await loadConfigFromFile();
  await updateKasumiConfig(
    (config) => {
      config.kasumi.uname = {
        sysname: "",
        nodename: "",
        release: "",
        version: "",
        machine: "",
        domainname: "",
      };
      config.kasumi.uname_release = "";
      config.kasumi.uname_version = "";
    },
    { applyRuntime: false },
  );
  await runCommandExpectOk(
    `${PATHS.BINARY} kasumi clear-uname --mode ${
      previousConfig.kasumi.uname_mode === "global" ? "global" : "scoped"
    }`,
  );
}

export async function restoreKasumiUnameGlobal(): Promise<void> {
  await runCommandExpectOk(`${PATHS.BINARY} kasumi restore-uname-global`);
}

export async function setKasumiCmdline(value: string): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.cmdline_value = value;
  });
}

export async function clearKasumiCmdline(): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.cmdline_value = "";
  });
}

export async function addKasumiMapsRule(rule: {
  target_ino: number;
  target_dev: number;
  spoofed_ino: number;
  spoofed_dev: number;
  spoofed_pathname: string;
}): Promise<void> {
  await updateKasumiConfig((config) => {
    const nextRule = {
      target_ino: Math.max(0, Math.trunc(Number(rule.target_ino) || 0)),
      target_dev: Math.max(0, Math.trunc(Number(rule.target_dev) || 0)),
      spoofed_ino: Math.max(0, Math.trunc(Number(rule.spoofed_ino) || 0)),
      spoofed_dev: Math.max(0, Math.trunc(Number(rule.spoofed_dev) || 0)),
      spoofed_pathname: rule.spoofed_pathname || "",
    };
    const nextRules = config.kasumi.maps_rules.filter(
      (item) =>
        !(
          item.target_ino === nextRule.target_ino &&
          item.target_dev === nextRule.target_dev
        ),
    );
    nextRules.push(nextRule);
    config.kasumi.maps_rules = nextRules;
  });
}

export async function clearKasumiMapsRules(): Promise<void> {
  await updateKasumiConfig((config) => {
    config.kasumi.maps_rules = [];
  });
}

export async function getUserHideRules(): Promise<string[]> {
  const payload = await runHybridMountJson("hide list", PATHS.BINARY);
  if (
    Array.isArray(payload) &&
    payload.every((item) => typeof item === "string")
  ) {
    return payload;
  }
  throw new AppError("hide list returned invalid payload");
}

export async function addUserHideRule(path: string): Promise<void> {
  await runCommandExpectOk(
    `${PATHS.BINARY} hide add "${shellEscapeDoubleQuoted(path)}"`,
  );
}

export async function removeUserHideRule(path: string): Promise<void> {
  await runCommandExpectOk(
    `${PATHS.BINARY} hide remove "${shellEscapeDoubleQuoted(path)}"`,
  );
}

export async function applyUserHideRules(): Promise<void> {
  await runCommandExpectOk(`${PATHS.BINARY} hide apply`);
}

export async function loadKasumiLkm(): Promise<void> {
  await runCommandExpectOk(`${PATHS.BINARY} lkm load`);
}

export async function unloadKasumiLkm(): Promise<void> {
  await runCommandExpectOk(`${PATHS.BINARY} lkm unload`);
}

export async function setKasumiLkmAutoload(enabled: boolean): Promise<void> {
  await updateKasumiConfig(
    (config) => {
      config.kasumi.lkm_autoload = enabled;
    },
    { applyRuntime: false },
  );
}

export async function setKasumiLkmKmi(value: string): Promise<void> {
  await updateKasumiConfig(
    (config) => {
      config.kasumi.lkm_kmi_override = value;
    },
    { applyRuntime: false },
  );
}

export async function clearKasumiLkmKmi(): Promise<void> {
  await updateKasumiConfig(
    (config) => {
      config.kasumi.lkm_kmi_override = "";
    },
    { applyRuntime: false },
  );
}

export async function fixKasumiMounts(): Promise<void> {
  await runCommandExpectOk(`${PATHS.BINARY} kasumi fix-mounts`);
}

export async function clearKasumiRules(): Promise<void> {
  await runCommandExpectOk(`${PATHS.BINARY} kasumi clear`);
}

export async function releaseKasumiConnection(): Promise<void> {
  await runCommandExpectOk(`${PATHS.BINARY} kasumi release-connection`);
}

export async function invalidateKasumiCache(): Promise<void> {
  await runCommandExpectOk(`${PATHS.BINARY} kasumi invalidate-cache`);
}

export async function applyKasumiConfigRuntime(): Promise<void> {
  await applyKasumiRuntimeConfig();
}
