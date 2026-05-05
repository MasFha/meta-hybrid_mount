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

use std::{collections::HashSet, fs, path::Path};

use anyhow::{Context, Result};

use crate::{
    conf::config,
    core::{
        inventory::Module,
        recovery::{FailureStage, ModuleStageFailure},
    },
    partitions,
    sys::fs::{prune_empty_dirs, set_overlay_opaque, sync_dir},
};

pub fn perform_sync(modules: &[Module], target_base: &Path, config: &config::Config) -> Result<()> {
    crate::scoped_log!(info, "sync", "start: target={}", target_base.display());
    let managed_partitions = partitions::managed_partition_names(&config.partitions);

    prune_orphaned_modules(modules, target_base)?;

    for module in modules {
        let dst = target_base.join(&module.id);
        let dst_backup = target_base.join(format!(".backup_{}", module.id));

        if !has_managed_mount_root(module, &managed_partitions) {
            crate::scoped_log!(
                debug,
                "sync",
                "module skip: id={}, reason=no_managed_partition_root",
                module.id
            );
            continue;
        }

        crate::scoped_log!(info, "sync", "module start: id={}", module.id);

        let tmp_dst = target_base.join(format!(".tmp_{}", module.id));

        if tmp_dst.exists() {
            let _ = fs::remove_dir_all(&tmp_dst);
        }

        let sync_stats = match sync_dir(&module.source_path, &tmp_dst, &managed_partitions) {
            Ok(stats) => stats,
            Err(e) => {
                crate::scoped_log!(
                    error,
                    "sync",
                    "module sync failed: id={}, error={}",
                    module.id,
                    e
                );
                let _ = fs::remove_dir_all(&tmp_dst);
                return Err(ModuleStageFailure::new(
                    FailureStage::Sync,
                    vec![module.id.clone()],
                    e,
                ))
                .with_context(|| format!("Failed to sync module {}", module.id));
            }
        };

        if !sync_stats.has_mount_content {
            crate::scoped_log!(
                debug,
                "sync",
                "module skip: id={}, reason=no_mount_content_after_sync",
                module.id
            );
            let _ = fs::remove_dir_all(&tmp_dst);
            continue;
        }

        if let Err(e) = prune_empty_dirs(&tmp_dst) {
            crate::scoped_log!(
                warn,
                "sync",
                "prune empty dirs failed: id={}, error={}",
                module.id,
                e
            );
        }

        for opaque_dir in sync_stats.opaque_dirs {
            if let Err(e) = set_overlay_opaque(&opaque_dir) {
                crate::scoped_log!(
                    warn,
                    "sync",
                    "apply overlay opaque failed: id={}, path={}, error={}",
                    module.id,
                    opaque_dir.display(),
                    e
                );
            } else {
                crate::scoped_log!(
                    debug,
                    "sync",
                    "set overlay opaque: id={}, path={}",
                    module.id,
                    opaque_dir.display()
                );
            }
        }

        let mut backup_created = false;
        if dst.exists() {
            if let Err(e) = fs::rename(&dst, &dst_backup) {
                crate::scoped_log!(
                    error,
                    "sync",
                    "backup existing failed: id={}, error={}",
                    module.id,
                    e
                );
                let _ = fs::remove_dir_all(&tmp_dst);
                return Err(ModuleStageFailure::new(
                    FailureStage::Sync,
                    vec![module.id.clone()],
                    e.into(),
                ))
                .with_context(|| format!("Failed to back up module {}", module.id));
            }
            backup_created = true;
        }

        if let Err(e) = fs::rename(&tmp_dst, &dst) {
            crate::scoped_log!(
                error,
                "sync",
                "atomic rename failed: id={}, error={}",
                module.id,
                e
            );
            if backup_created {
                let _ = fs::rename(&dst_backup, &dst);
            }
            let _ = fs::remove_dir_all(&tmp_dst);
            return Err(ModuleStageFailure::new(
                FailureStage::Sync,
                vec![module.id.clone()],
                e.into(),
            ))
            .with_context(|| format!("Failed to commit synced module {}", module.id));
        }

        if backup_created && let Err(e) = fs::remove_dir_all(&dst_backup) {
            crate::scoped_log!(
                warn,
                "sync",
                "cleanup backup failed: id={}, error={}",
                module.id,
                e
            );
        }
    }

    Ok(())
}

fn prune_orphaned_modules(modules: &[Module], target_base: &Path) -> Result<()> {
    if !target_base.exists() {
        return Ok(());
    }

    let active_ids: HashSet<&str> = modules.iter().map(|m| m.id.as_str()).collect();

    for entry in target_base.read_dir()?.flatten() {
        let path = entry.path();

        let name_os = entry.file_name();

        let name = name_os.to_string_lossy();

        if name != "lost+found"
            && name != "hybrid_mount"
            && !name.starts_with('.')
            && !active_ids.contains(name.as_ref())
        {
            crate::scoped_log!(info, "sync", "prune orphan: name={}", name);

            if path.is_dir() {
                if let Err(e) = fs::remove_dir_all(&path) {
                    crate::scoped_log!(
                        warn,
                        "sync",
                        "remove orphan dir failed: name={}, error={}",
                        name,
                        e
                    );
                }
            } else if let Err(e) = fs::remove_file(&path) {
                crate::scoped_log!(
                    warn,
                    "sync",
                    "remove orphan file failed: name={}, error={}",
                    name,
                    e
                );
            }
        }
    }

    Ok(())
}

fn has_managed_mount_root(module: &Module, managed_partitions: &[String]) -> bool {
    managed_partitions
        .iter()
        .any(|partition| module.source_path.join(partition).is_dir())
}
