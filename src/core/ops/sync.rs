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

use std::path::Path;

use anyhow::{Context, Result};

use crate::{
    conf::config,
    core::{
        inventory::Module,
        recovery::{FailureStage, ModuleStageFailure},
    },
    partitions,
    sys::fs::{
        commit_prepared_dir, finalize_copied_tree, prune_orphaned_children, remove_path, sync_dir,
    },
};

pub fn perform_sync(
    modules: &[Module],
    target_base: &Path,
    _config: &config::Config,
) -> Result<()> {
    crate::scoped_log!(info, "sync", "start: target={}", target_base.display());
    let managed_partitions = partitions::managed_partition_names();

    prune_orphaned_children(
        target_base,
        modules.iter().map(|module| module.id.as_str()),
        &["lost+found", "hybrid_mount"],
        "sync",
    )?;

    for module in modules {
        let dst = target_base.join(&module.id);

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

        let _ = remove_path(&tmp_dst);

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
                let _ = remove_path(&tmp_dst);
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
            let _ = remove_path(&tmp_dst);
            continue;
        }

        finalize_copied_tree(&module.id, &tmp_dst, &sync_stats.opaque_dirs);
        if let Err(e) = commit_prepared_dir(&module.id, &tmp_dst, &dst) {
            crate::scoped_log!(
                error,
                "sync",
                "commit prepared module failed: id={}, error={}",
                module.id,
                e
            );
            let _ = remove_path(&tmp_dst);
            return Err(ModuleStageFailure::new(
                FailureStage::Sync,
                vec![module.id.clone()],
                e.into(),
            ))
            .with_context(|| format!("Failed to commit synced module {}", module.id));
        }
    }

    Ok(())
}

fn has_managed_mount_root(module: &Module, managed_partitions: &[String]) -> bool {
    managed_partitions
        .iter()
        .any(|partition| module.source_path.join(partition).is_dir())
}
