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

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::{
    conf::config::Config,
    core::{inventory, runtime_state::RuntimeState},
    defs,
    domain::{ModuleRules, MountMode},
};

#[derive(Debug, Clone, Serialize)]
pub struct ModuleListEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub mode: MountMode,
    pub is_mounted: bool,
    pub enabled: bool,
    pub source_path: PathBuf,
    pub rules: ModuleRules,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleApplyEntry {
    pub id: String,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub source_path: Option<PathBuf>,
    #[serde(default)]
    pub rules: ModuleRules,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModulesApplyPayload {
    pub updated: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionPayload {
    pub version: String,
}

#[derive(Debug, Clone)]
struct ModuleMetadata {
    name: String,
    version: String,
    author: String,
    description: String,
}

pub fn build_modules_payload(
    config: &Config,
    state: &RuntimeState,
    path: Option<&Path>,
) -> Result<Vec<ModuleListEntry>> {
    let source_dir = path.unwrap_or(config.moduledir.as_path());
    if !source_dir.exists() {
        return Ok(Vec::new());
    }

    let mut modules = Vec::new();
    for entry in fs::read_dir(source_dir)
        .with_context(|| format!("failed to read module directory {}", source_dir.display()))?
    {
        let entry = entry.with_context(|| {
            format!(
                "failed to enumerate module directory {}",
                source_dir.display()
            )
        })?;
        let module_path = entry.path();
        if !module_path.is_dir() {
            continue;
        }

        let id = entry.file_name().to_string_lossy().into_owned();
        if inventory::is_reserved_module_dir(&id) {
            continue;
        }

        let metadata = read_module_metadata(&module_path, &id);
        let rules = load_module_rules(config, &id);
        let enabled = !inventory::has_mount_block_marker(&module_path);
        let runtime_mode = enabled.then(|| module_runtime_mode(&id, state)).flatten();
        let mode = runtime_mode.unwrap_or(rules.default_mode);

        modules.push(ModuleListEntry {
            id,
            name: metadata.name,
            version: metadata.version,
            author: metadata.author,
            description: metadata.description,
            mode,
            is_mounted: runtime_mode.is_some(),
            enabled,
            source_path: module_path,
            rules,
        });
    }

    modules.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(modules)
}

pub fn apply_modules_payload(
    config_path: &Path,
    modules: &[ModuleApplyEntry],
) -> Result<ModulesApplyPayload> {
    let mut config = Config::load_optional_from_file(config_path)?;

    for module in modules {
        let module_path = module
            .source_path
            .clone()
            .unwrap_or_else(|| config.moduledir.join(&module.id));
        let disable_path = module_path.join(defs::DISABLE_FILE_NAME);

        if module.enabled == Some(false) {
            fs::write(&disable_path, b"").with_context(|| {
                format!("failed to create disable marker {}", disable_path.display())
            })?;
        } else if module.enabled == Some(true) {
            match fs::remove_file(&disable_path) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(err).with_context(|| {
                        format!("failed to remove disable marker {}", disable_path.display())
                    });
                }
            }
        }

        config.rules.insert(module.id.clone(), module.rules.clone());
    }

    config.save_to_file(config_path)?;
    Ok(ModulesApplyPayload {
        updated: modules.len(),
    })
}

pub fn build_version_payload() -> VersionPayload {
    let metadata = read_module_metadata(Path::new(defs::HYBRID_MOUNT_MODULE_DIR), "hybrid_mount");
    VersionPayload {
        version: if metadata.version == "unknown" {
            env!("CARGO_PKG_VERSION").to_string()
        } else {
            metadata.version
        },
    }
}

fn load_module_rules(config: &Config, module_id: &str) -> ModuleRules {
    let mut rules = ModuleRules {
        default_mode: config.default_mode.as_mount_mode(),
        ..Default::default()
    };

    if let Some(global_rules) = config.rules.get(module_id) {
        rules.default_mode = global_rules.default_mode;
        rules.paths.extend(global_rules.paths.clone());
    }

    rules
}

fn module_runtime_mode(module_id: &str, state: &RuntimeState) -> Option<MountMode> {
    if state.overlay_modules.iter().any(|id| id == module_id) {
        return Some(MountMode::Overlay);
    }
    if state.magic_modules.iter().any(|id| id == module_id) {
        return Some(MountMode::Magic);
    }
    if state.kasumi_modules.iter().any(|id| id == module_id) {
        return Some(MountMode::Kasumi);
    }
    None
}

fn read_module_metadata(module_path: &Path, module_id: &str) -> ModuleMetadata {
    let prop_path = module_path.join("module.prop");
    let Some(raw) = fs::read_to_string(&prop_path).ok() else {
        return default_module_metadata(module_id);
    };

    let mut metadata = default_module_metadata(module_id);
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "name" if !value.is_empty() => metadata.name = value.to_string(),
            "version" if !value.is_empty() => metadata.version = value.to_string(),
            "author" if !value.is_empty() => metadata.author = value.to_string(),
            "description" if !value.is_empty() => metadata.description = value.to_string(),
            _ => {}
        }
    }

    metadata
}

fn default_module_metadata(module_id: &str) -> ModuleMetadata {
    ModuleMetadata {
        name: module_id.to_string(),
        version: "unknown".to_string(),
        author: "unknown".to_string(),
        description: "No description".to_string(),
    }
}
