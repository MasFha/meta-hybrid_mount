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

use std::{collections::HashMap, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    defs,
    domain::{DefaultMode, ModuleRules},
};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum OverlayMode {
    Tmpfs,
    #[default]
    Ext4,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KasumiMapsRuleConfig {
    #[serde(default)]
    pub target_ino: u64,
    #[serde(default)]
    pub target_dev: u64,
    #[serde(default)]
    pub spoofed_ino: u64,
    #[serde(default)]
    pub spoofed_dev: u64,
    #[serde(default)]
    pub spoofed_pathname: PathBuf,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct KasumiKstatRuleConfig {
    #[serde(default)]
    pub target_ino: u64,
    #[serde(default)]
    pub target_pathname: PathBuf,
    #[serde(default)]
    pub spoofed_ino: u64,
    #[serde(default)]
    pub spoofed_dev: u64,
    #[serde(default)]
    pub spoofed_nlink: u32,
    #[serde(default)]
    pub spoofed_size: i64,
    #[serde(default)]
    pub spoofed_atime_sec: i64,
    #[serde(default)]
    pub spoofed_atime_nsec: i64,
    #[serde(default)]
    pub spoofed_mtime_sec: i64,
    #[serde(default)]
    pub spoofed_mtime_nsec: i64,
    #[serde(default)]
    pub spoofed_ctime_sec: i64,
    #[serde(default)]
    pub spoofed_ctime_nsec: i64,
    #[serde(default)]
    pub spoofed_blksize: u64,
    #[serde(default)]
    pub spoofed_blocks: u64,
    #[serde(default)]
    pub is_static: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct KasumiUnameConfig {
    #[serde(default)]
    pub sysname: String,
    #[serde(default)]
    pub nodename: String,
    #[serde(default)]
    pub release: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub machine: String,
    #[serde(default)]
    pub domainname: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum KasumiUnameMode {
    #[default]
    Scoped,
    Global,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct KasumiMountHideConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub path_pattern: PathBuf,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct KasumiStatfsSpoofConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub path: PathBuf,
    #[serde(default)]
    pub spoof_f_type: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KasumiConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub lkm_autoload: bool,
    #[serde(default = "default_kasumi_lkm_dir")]
    pub lkm_dir: PathBuf,
    #[serde(default)]
    pub lkm_kmi_override: String,
    #[serde(default = "default_kasumi_mirror_path")]
    pub mirror_path: PathBuf,
    #[serde(default)]
    pub enable_kernel_debug: bool,
    #[serde(default)]
    pub enable_stealth: bool,
    #[serde(default)]
    pub enable_hidexattr: bool,
    #[serde(default)]
    pub enable_mount_hide: bool,
    #[serde(default)]
    pub enable_maps_spoof: bool,
    #[serde(default)]
    pub enable_statfs_spoof: bool,
    #[serde(default)]
    pub enable_selinux_fix: bool,
    #[serde(default)]
    pub mount_hide: KasumiMountHideConfig,
    #[serde(default)]
    pub statfs_spoof: KasumiStatfsSpoofConfig,
    #[serde(default)]
    pub hide_uids: Vec<u32>,
    #[serde(default)]
    pub uname_mode: KasumiUnameMode,
    #[serde(default)]
    pub uname: KasumiUnameConfig,
    #[serde(default)]
    pub cmdline_value: String,
    #[serde(default)]
    pub kstat_rules: Vec<KasumiKstatRuleConfig>,
    #[serde(default)]
    pub maps_rules: Vec<KasumiMapsRuleConfig>,
}

impl Default for KasumiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            lkm_autoload: default_true(),
            lkm_dir: default_kasumi_lkm_dir(),
            lkm_kmi_override: String::new(),
            mirror_path: default_kasumi_mirror_path(),
            enable_kernel_debug: false,
            enable_stealth: false,
            enable_hidexattr: false,
            enable_mount_hide: false,
            enable_maps_spoof: false,
            enable_statfs_spoof: false,
            enable_selinux_fix: false,
            mount_hide: KasumiMountHideConfig::default(),
            statfs_spoof: KasumiStatfsSpoofConfig::default(),
            hide_uids: Vec::new(),
            uname_mode: KasumiUnameMode::Scoped,
            uname: KasumiUnameConfig::default(),
            cmdline_value: String::new(),
            kstat_rules: Vec::new(),
            maps_rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum DaemonStartupMode {
    #[default]
    OnDemand,
    Persistent,
}

impl std::fmt::Display for DaemonStartupMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OnDemand => write!(f, "on-demand"),
            Self::Persistent => write!(f, "persistent"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    #[serde(default = "default_moduledir")]
    pub moduledir: PathBuf,
    #[serde(default = "default_mountsource")]
    pub mountsource: String,
    #[serde(default)]
    pub overlay_mode: OverlayMode,
    #[serde(default)]
    pub disable_umount: bool,
    #[serde(default)]
    pub enable_overlay_fallback: bool,
    #[serde(default)]
    pub default_mode: DefaultMode,
    #[serde(default)]
    pub kasumi: KasumiConfig,
    #[serde(default)]
    pub rules: HashMap<String, ModuleRules>,
    #[serde(default)]
    pub daemon_startup_mode: DaemonStartupMode,
}

fn default_moduledir() -> PathBuf {
    PathBuf::from(defs::MODULES_DIR)
}

fn default_mountsource() -> String {
    crate::sys::mount::detect_mount_source()
}

fn default_kasumi_mirror_path() -> PathBuf {
    PathBuf::from(defs::KASUMI_MIRROR_DIR)
}

fn default_kasumi_lkm_dir() -> PathBuf {
    PathBuf::from(defs::KASUMI_LKM_DIR)
}

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            moduledir: default_moduledir(),
            mountsource: default_mountsource(),
            overlay_mode: OverlayMode::default(),
            disable_umount: false,
            enable_overlay_fallback: false,
            default_mode: DefaultMode::default(),
            kasumi: KasumiConfig::default(),
            rules: HashMap::new(),
            daemon_startup_mode: DaemonStartupMode::default(),
        }
    }
}
