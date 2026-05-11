import { AppError } from "./api/core/error";
import { PATHS } from "./constants";
import {
  ensureDaemonAwake,
  hasExecBridge,
  runDaemonCommand,
  shouldUseMock,
} from "./api/core/bridge";
import {
  getStorageUsage,
  getSystemInfo,
  getVersion,
  init,
  openLink,
  reboot,
} from "./api/services/systemService";
import {
  loadConfigFromFile,
  resetConfigFile,
  saveConfigToFile,
} from "./api/repos/configRepo";
import {
  scanModules,
  saveModules,
  saveModuleRules,
  saveAllModuleRules,
} from "./api/services/moduleService";
import * as kasumiService from "./api/services/kasumiService";
import { MockAPI } from "./api.mock";
import type { AppAPI } from "./api/contracts";

const RealAPI: AppAPI = {
  wakeDaemon: () => ensureDaemonAwake(PATHS.BINARY),
  init,
  loadConfig: loadConfigFromFile,
  saveConfig: saveConfigToFile,
  resetConfig: async () => {
    await resetConfigFile();
  },
  scanModules,
  saveModules,
  saveModuleRules,
  saveAllModuleRules,
  getStorageUsage,
  getSystemInfo,
  getVersion,
  getKasumiStatus: kasumiService.getKasumiStatus,
  setKasumiEnabled: kasumiService.setKasumiEnabled,
  setKasumiStealth: kasumiService.setKasumiStealth,
  setKasumiHidexattr: kasumiService.setKasumiHidexattr,
  setKasumiSelinuxFix: kasumiService.setKasumiSelinuxFix,
  setKasumiDebug: kasumiService.setKasumiDebug,
  getOriginalKernelUname: kasumiService.getOriginalKernelUname,
  setKasumiUnameMode: kasumiService.setKasumiUnameMode,
  setKasumiUname: kasumiService.setKasumiUname,
  applyKasumiUname: kasumiService.applyKasumiUname,
  clearKasumiUname: kasumiService.clearKasumiUname,
  restoreKasumiUnameGlobal: kasumiService.restoreKasumiUnameGlobal,
  setKasumiCmdline: kasumiService.setKasumiCmdline,
  clearKasumiCmdline: kasumiService.clearKasumiCmdline,
  clearMountErrors: () =>
    runDaemonCommand(
      { type: "clear-mount-errors" },
      PATHS.BINARY,
    ) as Promise<void>,
  addKasumiMapsRule: kasumiService.addKasumiMapsRule,
  clearKasumiMapsRules: kasumiService.clearKasumiMapsRules,
  getUserHideRules: kasumiService.getUserHideRules,
  addUserHideRule: kasumiService.addUserHideRule,
  removeUserHideRule: kasumiService.removeUserHideRule,
  applyUserHideRules: kasumiService.applyUserHideRules,
  loadKasumiLkm: kasumiService.loadKasumiLkm,
  unloadKasumiLkm: kasumiService.unloadKasumiLkm,
  setKasumiLkmAutoload: kasumiService.setKasumiLkmAutoload,
  setKasumiLkmKmi: kasumiService.setKasumiLkmKmi,
  clearKasumiLkmKmi: kasumiService.clearKasumiLkmKmi,
  fixKasumiMounts: kasumiService.fixKasumiMounts,
  clearKasumiRules: kasumiService.clearKasumiRules,
  releaseKasumiConnection: kasumiService.releaseKasumiConnection,
  invalidateKasumiCache: kasumiService.invalidateKasumiCache,
  openLink,
  reboot,
};

export { AppError, hasExecBridge, runDaemonCommand };
export type { AppAPI } from "./api/contracts";
export type { DaemonCommandPayload } from "./api/core/bridge";
export const API: AppAPI = shouldUseMock
  ? (MockAPI as unknown as AppAPI)
  : RealAPI;
