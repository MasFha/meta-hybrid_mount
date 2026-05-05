import { AppError } from "./api/core/error";
import { hasExecBridge, shouldUseMock } from "./api/core/bridge";
import { shellEscapeDoubleQuoted } from "./api/core/shell";
import {
  getStorageUsage,
  getSystemInfo,
  getVersion,
  openLink,
  reboot,
} from "./api/services/systemService";
import {
  loadConfigFromFile,
  createDefaultConfig,
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
  loadConfig: loadConfigFromFile,
  saveConfig: saveConfigToFile,
  resetConfig: async () => {
    await saveConfigToFile(await createDefaultConfig());
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
  setKasumiDebug: kasumiService.setKasumiDebug,
  getOriginalKernelUname: kasumiService.getOriginalKernelUname,
  setKasumiUnameMode: kasumiService.setKasumiUnameMode,
  setKasumiUname: kasumiService.setKasumiUname,
  applyKasumiUname: kasumiService.applyKasumiUname,
  clearKasumiUname: kasumiService.clearKasumiUname,
  restoreKasumiUnameGlobal: kasumiService.restoreKasumiUnameGlobal,
  setKasumiCmdline: kasumiService.setKasumiCmdline,
  clearKasumiCmdline: kasumiService.clearKasumiCmdline,
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

export { AppError, hasExecBridge, shellEscapeDoubleQuoted };
export type { AppAPI } from "./api/contracts";
export const API: AppAPI = shouldUseMock
  ? (MockAPI as unknown as AppAPI)
  : RealAPI;
