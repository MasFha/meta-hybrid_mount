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
    collections::{BTreeSet, HashSet},
    fs,
    io::{self, Read},
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

const MAX_MODULE_PROP_BYTES: u64 = 64 * 1024;

pub fn build_modules_payload(
    config: &Config,
    state: &RuntimeState,
    path: Option<&Path>,
) -> Result<Vec<ModuleListEntry>> {
    if let Some(source_dir) = path {
        return build_scanned_modules_payload(config, state, source_dir);
    }

    Ok(build_runtime_modules_payload(config, state))
}

fn build_scanned_modules_payload(
    config: &Config,
    state: &RuntimeState,
    source_dir: &Path,
) -> Result<Vec<ModuleListEntry>> {
    if !source_dir.exists() {
        return Ok(Vec::new());
    }

    let runtime_index = RuntimeModuleIndex::new(state);
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
        let file_type = entry.file_type().with_context(|| {
            format!(
                "failed to read module entry type {}",
                entry.path().display()
            )
        })?;
        if !file_type.is_dir() {
            continue;
        }

        let module_path = entry.path();
        let id = entry.file_name().to_string_lossy().into_owned();
        if inventory::is_reserved_module_dir(&id) {
            continue;
        }

        let rules = inventory::load_module_rules(config, &id);
        let enabled = !inventory::has_mount_block_marker(&module_path);
        let runtime_mode = enabled.then(|| runtime_index.mode(&id)).flatten();
        let mode = runtime_mode.unwrap_or(rules.default_mode);
        let metadata = read_module_metadata(&module_path, &id);

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

fn build_runtime_modules_payload(config: &Config, state: &RuntimeState) -> Vec<ModuleListEntry> {
    let runtime_index = RuntimeModuleIndex::new(state);
    let mut ids = BTreeSet::new();
    ids.extend(state.overlay_modules.iter().cloned());
    ids.extend(state.magic_modules.iter().cloned());
    ids.extend(state.kasumi_modules.iter().cloned());
    ids.extend(state.skip_mount_modules.iter().cloned());
    ids.extend(state.mount_error_modules.iter().cloned());
    ids.extend(config.rules.keys().cloned());

    ids.into_iter()
        .filter(|id| !inventory::is_reserved_module_dir(id))
        .map(|id| {
            let source_path = config.moduledir.join(&id);
            let rules = inventory::load_module_rules(config, &id);
            let runtime_mode = runtime_index.mode(&id);
            let mode = runtime_mode.unwrap_or(rules.default_mode);
            let enabled = runtime_index.enabled(&id);
            let metadata = read_module_metadata(&source_path, &id);

            ModuleListEntry {
                id,
                name: metadata.name,
                version: metadata.version,
                author: metadata.author,
                description: metadata.description,
                mode,
                is_mounted: runtime_mode.is_some(),
                enabled,
                source_path,
                rules,
            }
        })
        .collect()
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

struct RuntimeModuleIndex<'a> {
    overlay: HashSet<&'a str>,
    magic: HashSet<&'a str>,
    kasumi: HashSet<&'a str>,
    skipped: HashSet<&'a str>,
}

impl<'a> RuntimeModuleIndex<'a> {
    fn new(state: &'a RuntimeState) -> Self {
        Self {
            overlay: state.overlay_modules.iter().map(String::as_str).collect(),
            magic: state.magic_modules.iter().map(String::as_str).collect(),
            kasumi: state.kasumi_modules.iter().map(String::as_str).collect(),
            skipped: state
                .skip_mount_modules
                .iter()
                .map(String::as_str)
                .collect(),
        }
    }

    fn mode(&self, module_id: &str) -> Option<MountMode> {
        if self.overlay.contains(module_id) {
            return Some(MountMode::Overlay);
        }
        if self.magic.contains(module_id) {
            return Some(MountMode::Magic);
        }
        if self.kasumi.contains(module_id) {
            return Some(MountMode::Kasumi);
        }
        None
    }

    fn enabled(&self, module_id: &str) -> bool {
        !self.skipped.contains(module_id)
    }
}

fn read_module_metadata(module_path: &Path, module_id: &str) -> ModuleMetadata {
    let prop_path = module_path.join("module.prop");
    let Ok(metadata) = fs::symlink_metadata(&prop_path) else {
        return default_module_metadata(module_id);
    };
    if !metadata.file_type().is_file() {
        return default_module_metadata(module_id);
    }
    if metadata.len() > MAX_MODULE_PROP_BYTES {
        crate::scoped_log!(
            warn,
            "api:modules",
            "metadata fallback: module={}, path={}, reason=module_prop_too_large, bytes={}, max_bytes={}",
            module_id,
            prop_path.display(),
            metadata.len(),
            MAX_MODULE_PROP_BYTES
        );
        return default_module_metadata(module_id);
    }

    let raw = match read_module_prop_limited(&prop_path) {
        Ok(raw) => raw,
        Err(err) => {
            crate::scoped_log!(
                warn,
                "api:modules",
                "metadata fallback: module={}, path={}, reason=read_failed, error={}",
                module_id,
                prop_path.display(),
                err
            );
            return default_module_metadata(module_id);
        }
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

fn read_module_prop_limited(prop_path: &Path) -> io::Result<String> {
    let file = fs::File::open(prop_path)?;
    let mut reader = file.take(MAX_MODULE_PROP_BYTES + 1);
    let mut raw = String::new();
    reader.read_to_string(&mut raw)?;
    if raw.len() as u64 > MAX_MODULE_PROP_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "module.prop is too large",
        ));
    }
    Ok(raw)
}

fn default_module_metadata(module_id: &str) -> ModuleMetadata {
    ModuleMetadata {
        name: module_id.to_string(),
        version: "unknown".to_string(),
        author: "unknown".to_string(),
        description: "No description".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::{
        conf::schema::Config,
        core::runtime_state::RuntimeState,
        domain::{DefaultMode, MountMode},
    };

    #[test]
    fn runtime_modules_payload_keeps_runtime_rules_and_default_metadata() {
        let mut config = Config {
            moduledir: PathBuf::from("/modules"),
            default_mode: DefaultMode::Magic,
            ..Default::default()
        };
        config.rules.insert(
            "alpha".to_string(),
            ModuleRules {
                default_mode: MountMode::Overlay,
                ..Default::default()
            },
        );

        let mut state = RuntimeState::default();
        state.overlay_modules = vec!["alpha".to_string()];

        let modules = build_runtime_modules_payload(&config, &state);
        assert_eq!(modules.len(), 1);

        let module = &modules[0];
        assert_eq!(module.id, "alpha");
        assert_eq!(module.name, "alpha");
        assert_eq!(module.version, "unknown");
        assert_eq!(module.author, "unknown");
        assert_eq!(module.description, "No description");
        assert_eq!(module.mode, MountMode::Overlay);
        assert!(module.is_mounted);
        assert!(module.enabled);
        assert_eq!(module.source_path, PathBuf::from("/modules/alpha"));
        assert_eq!(module.rules.default_mode, MountMode::Overlay);
    }

    #[test]
    fn scanned_modules_payload_includes_module_prop_metadata() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let module_dir = temp.path().join("alpha");
        std::fs::create_dir(&module_dir)?;
        std::fs::write(
            module_dir.join("module.prop"),
            "name=Alpha Module\nversion=1.2.3\nauthor=Alice\ndescription=Fast path\n",
        )?;

        let config = Config {
            moduledir: temp.path().to_path_buf(),
            ..Default::default()
        };
        let state = RuntimeState::default();

        let modules = build_scanned_modules_payload(&config, &state, temp.path())?;
        assert_eq!(modules.len(), 1);

        let module = &modules[0];
        assert_eq!(module.id, "alpha");
        assert_eq!(module.name, "Alpha Module");
        assert_eq!(module.version, "1.2.3");
        assert_eq!(module.author, "Alice");
        assert_eq!(module.description, "Fast path");
        Ok(())
    }
}
