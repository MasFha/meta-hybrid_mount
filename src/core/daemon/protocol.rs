// Copyright (C) 2026 YuzakiKokuban <heibanbaize@gmail.com>
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonRequest {
    pub command: DaemonCommand,
    #[serde(default)]
    pub config_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum DaemonCommand {
    Ping,
    WebuiStart,
    Shutdown,
    Init,
    Status,
    ApiStorage,
    ApiMountStats,
    ApiMountTopology,
    ApiPartitions,
    ApiSystemInfo,
    ApiVersion,
    ApiConfigGet,
    ApiConfigSet {
        config: serde_json::Value,
    },
    ApiConfigPatch {
        patch: serde_json::Value,
        #[serde(default)]
        apply_runtime: bool,
    },
    ApiConfigReset,
    ApiModulesList {
        path: Option<PathBuf>,
    },
    ApiModulesApply {
        modules: Vec<crate::core::api::ModuleApplyEntry>,
    },
    ApiLkm,
    ApiHooks,
    ApiKernelUname,
    ApiOpenUrl {
        url: String,
    },
    ApiReboot,
    ApiKasumiMapsAdd {
        rule: serde_json::Value,
    },
    ApiKasumiMapsClear,
    KasumiStatus,
    KasumiList,
    KasumiVersion,
    KasumiFeatures,
    KasumiHooks,
    KasumiApplyConfigRuntime,
    HideList,
    HideAdd {
        path: PathBuf,
    },
    HideRemove {
        path: PathBuf,
    },
    HideApply,
    LkmStatus,
    LkmLoad,
    LkmUnload,
    KasumiClear,
    KasumiReleaseConnection,
    KasumiInvalidateCache,
    KasumiFixMounts,
    KasumiRestoreUnameGlobal,
    KasumiSetUname {
        mode: String,
        release: String,
        version: String,
    },
    KasumiClearUname {
        mode: String,
    },
    KasumiRuleAdd {
        target: PathBuf,
        source: PathBuf,
        file_type: Option<i32>,
    },
    KasumiRuleMerge {
        target: PathBuf,
        source: PathBuf,
    },
    KasumiRuleHide {
        path: PathBuf,
    },
    KasumiRuleDelete {
        path: PathBuf,
    },
    KasumiRuleAddDir {
        target_base: PathBuf,
        source_dir: PathBuf,
    },
    KasumiRuleRemoveDir {
        target_base: PathBuf,
        source_dir: PathBuf,
    },
    Batch {
        commands: Vec<DaemonCommand>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DaemonResponse {
    pub fn success(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(message.into()),
        }
    }
}
