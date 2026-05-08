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
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

use super::log_mode_decision;
use crate::{conf::config, core::inventory::Module, domain::MountMode, utils};

struct ProcessingItem {
    module_source: PathBuf,
    system_target: PathBuf,
    relative_path: PathBuf,
    partition_label: String,
}

#[derive(Debug, Default, Clone, Copy)]
pub(super) struct BackendPresence {
    pub(super) magic: bool,
    pub(super) kasumi: bool,
}

impl BackendPresence {
    fn merge(&mut self, other: Self) {
        self.magic |= other.magic;
        self.kasumi |= other.kasumi;
    }
}

pub(super) struct PlannerContext {
    use_kasumi: bool,
    overlay_fallback_enabled: bool,
    target_cache: HashMap<PathBuf, PathBuf>,
    overlay_groups: BTreeMap<PathBuf, (String, Vec<PathBuf>)>,
    managed_partitions: HashSet<String>,
}

impl PlannerContext {
    pub(super) fn new(
        config: &config::Config,
        use_kasumi: bool,
        managed_partitions: HashSet<String>,
    ) -> Self {
        Self {
            use_kasumi,
            overlay_fallback_enabled: config.enable_overlay_fallback,
            target_cache: HashMap::new(),
            overlay_groups: BTreeMap::new(),
            managed_partitions,
        }
    }

    fn resolve_target_cached(&mut self, system_target: &Path) -> PathBuf {
        if let Some(cached) = self.target_cache.get(system_target) {
            return cached.clone();
        }

        let resolved = utils::resolve_link_path(system_target);
        self.target_cache
            .insert(system_target.to_path_buf(), resolved.clone());
        resolved
    }

    fn should_split_overlay_target(&self, resolved_target: &Path) -> bool {
        let target_name = resolved_target
            .file_name()
            .map(|value| value.to_string_lossy())
            .unwrap_or_default();

        target_name == "system" || self.managed_partitions.contains(target_name.as_ref())
    }

    fn queue_overlay(
        &mut self,
        resolved_target: PathBuf,
        partition_label: &str,
        module_source: PathBuf,
    ) {
        crate::scoped_log!(
            debug,
            "planner",
            "queue overlay: partition={}, layer={}, target={}",
            partition_label,
            module_source.display(),
            resolved_target.display()
        );
        let (_, layers) = self
            .overlay_groups
            .entry(resolved_target)
            .or_insert_with(|| (partition_label.to_string(), Vec::new()));
        layers.push(module_source);
    }

    fn plan_subtree(&mut self, module: &Module, start: ProcessingItem) -> BackendPresence {
        let mut presence = BackendPresence::default();
        let mut queue = VecDeque::from([start]);

        while let Some(item) = queue.pop_front() {
            let ProcessingItem {
                module_source,
                system_target,
                relative_path,
                partition_label,
            } = item;

            let relative_key = relative_path.to_string_lossy();
            let requested_mode = module.rules.get_mode(relative_key.as_ref());
            let effective_mode = if matches!(requested_mode, MountMode::Kasumi) && !self.use_kasumi
            {
                MountMode::Ignore
            } else {
                requested_mode
            };
            log_mode_decision(module, &relative_path, &requested_mode, &effective_mode);

            let has_descendant_rules = module.rules.has_descendant_rule(&relative_path);

            let mut child_dirs = Vec::new();
            let mut direct_non_dir_entries = false;
            match fs::read_dir(&module_source) {
                Ok(entries) => {
                    for sub_entry_result in entries {
                        let sub_entry = match sub_entry_result {
                            Ok(sub_entry) => sub_entry,
                            Err(err) => {
                                crate::scoped_log!(
                                    warn,
                                    "planner",
                                    "enumerate subtree failed: module={}, path={}, error={}",
                                    module.id,
                                    module_source.display(),
                                    err
                                );
                                continue;
                            }
                        };

                        let sub_path = sub_entry.path();
                        match sub_entry.file_type() {
                            Ok(file_type) if file_type.is_symlink() => {
                                direct_non_dir_entries = true;
                            }
                            Ok(file_type) if file_type.is_dir() => {
                                child_dirs.push((sub_entry.file_name(), sub_path));
                            }
                            Ok(_) => {
                                direct_non_dir_entries = true;
                            }
                            Err(err) => {
                                crate::scoped_log!(
                                    warn,
                                    "planner",
                                    "subtree file type failed: module={}, path={}, error={}",
                                    module.id,
                                    sub_path.display(),
                                    err
                                );
                            }
                        }
                    }
                }
                Err(err) => {
                    crate::scoped_log!(
                        warn,
                        "planner",
                        "read subtree failed: module={}, path={}, error={}",
                        module.id,
                        module_source.display(),
                        err
                    );
                    continue;
                }
            }

            if matches!(effective_mode, MountMode::Magic)
                && (direct_non_dir_entries || !child_dirs.is_empty())
            {
                presence.magic = true;
            }
            if matches!(effective_mode, MountMode::Overlay)
                && direct_non_dir_entries
                && has_descendant_rules
                && self.overlay_fallback_enabled
            {
                presence.magic = true;
            }
            if matches!(effective_mode, MountMode::Kasumi)
                && (direct_non_dir_entries || !child_dirs.is_empty())
            {
                presence.kasumi = true;
            }

            if matches!(effective_mode, MountMode::Overlay)
                && direct_non_dir_entries
                && has_descendant_rules
            {
                crate::scoped_log!(
                    warn,
                    "planner",
                    "mixed overlay subtree requires split: module={}, relative={}, behavior={}",
                    module.id,
                    relative_path.display(),
                    if self.overlay_fallback_enabled {
                        "direct_files_magic_fallback"
                    } else {
                        "direct_files_unhandled_overlay_fallback_disabled"
                    }
                );
            }

            if !has_descendant_rules {
                match effective_mode {
                    MountMode::Magic | MountMode::Ignore | MountMode::Kasumi => continue,
                    MountMode::Overlay => {
                        if !system_target.exists() {
                            crate::scoped_log!(
                                debug,
                                "planner",
                                "target skip: module={}, reason=missing_target, path={}",
                                module.id,
                                system_target.display()
                            );
                            continue;
                        }

                        let resolved_target = self.resolve_target_cached(&system_target);
                        if !self.should_split_overlay_target(&resolved_target) {
                            self.queue_overlay(resolved_target, &partition_label, module_source);
                            continue;
                        }
                    }
                }
            }

            let resolved_target = if system_target.exists() {
                self.resolve_target_cached(&system_target)
            } else {
                system_target.clone()
            };
            let target_name = resolved_target
                .file_name()
                .map(|value| value.to_string_lossy())
                .unwrap_or_default();
            let next_partition_label = if target_name.is_empty() {
                partition_label.clone()
            } else {
                target_name.to_string()
            };

            for (sub_name, sub_path) in child_dirs {
                if sub_name.as_encoded_bytes().is_empty()
                    || sub_name.as_encoded_bytes().contains(&b'/')
                    || sub_name == ".."
                    || sub_name == "."
                {
                    crate::scoped_log!(
                        warn,
                        "planner",
                        "skip suspicious child dir name: module={}, path={:?}",
                        module.id,
                        sub_name
                    );
                    continue;
                }
                queue.push_back(ProcessingItem {
                    module_source: sub_path,
                    system_target: resolved_target.join(&sub_name),
                    relative_path: relative_path.join(&sub_name),
                    partition_label: next_partition_label.clone(),
                });
            }
        }

        presence
    }

    pub(super) fn into_overlay_groups(self) -> BTreeMap<PathBuf, (String, Vec<PathBuf>)> {
        self.overlay_groups
    }
}

pub(super) fn plan_module_roots(
    module: &Module,
    content_path: &Path,
    system_root: &Path,
    managed_partitions: &HashSet<String>,
    planner: &mut PlannerContext,
) -> BackendPresence {
    let mut presence = BackendPresence::default();

    match fs::read_dir(content_path) {
        Ok(entries) => {
            for entry_result in entries {
                let entry = match entry_result {
                    Ok(entry) => entry,
                    Err(err) => {
                        crate::scoped_log!(
                            warn,
                            "planner",
                            "enumerate content failed: module={}, path={}, error={}",
                            module.id,
                            content_path.display(),
                            err
                        );
                        continue;
                    }
                };

                let path = entry.path();
                match entry.file_type() {
                    Ok(file_type) if file_type.is_symlink() || !file_type.is_dir() => continue,
                    Ok(_) => {}
                    Err(err) => {
                        crate::scoped_log!(
                            warn,
                            "planner",
                            "file type failed: module={}, path={}, error={}",
                            module.id,
                            path.display(),
                            err
                        );
                        continue;
                    }
                }

                let dir_name = entry.file_name();
                let Some(dir_name) = dir_name.to_str() else {
                    crate::scoped_log!(
                        warn,
                        "planner",
                        "skip: module={}, reason=non_utf8_partition_dir, path={:?}",
                        module.id,
                        path
                    );
                    continue;
                };

                if !managed_partitions.contains(dir_name) {
                    continue;
                }

                presence.merge(planner.plan_subtree(
                    module,
                    ProcessingItem {
                        module_source: path.clone(),
                        system_target: system_root.join(dir_name),
                        relative_path: PathBuf::from(dir_name),
                        partition_label: dir_name.to_string(),
                    },
                ));
            }
        }
        Err(err) => {
            crate::scoped_log!(
                warn,
                "planner",
                "read content root failed: module={}, path={}, error={}",
                module.id,
                content_path.display(),
                err
            );
        }
    }

    presence
}
