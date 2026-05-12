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

mod fallback;
mod magic;
mod overlay;

use std::{collections::BTreeSet, path::Path};

use anyhow::{Result, bail};

#[cfg(feature = "kasumi")]
use crate::core::kasumi_coordinator::KasumiCoordinator;
#[cfg(any(target_os = "linux", target_os = "android"))]
use crate::mount::umount_mgr;
use crate::{
    conf::config,
    core::{
        inventory::Module,
        ops::plan::MountPlan,
        recovery::{FailureStage, ModuleStageFailure},
        runtime_state::MountStatistics,
    },
};

pub struct ExecutionResult {
    pub overlay_module_ids: Vec<String>,
    pub overlay_partitions: Vec<String>,
    pub magic_module_ids: Vec<String>,
    pub kasumi_module_ids: Vec<String>,
    pub kasumi_runtime_enabled: bool,
    pub mount_stats: MountStatistics,
}

pub struct Executor;

impl Executor {
    pub fn execute<P>(
        plan: &mut MountPlan,
        modules: &[Module],
        config: &config::Config,
        tempdir: P,
    ) -> Result<ExecutionResult>
    where
        P: AsRef<Path>,
    {
        crate::scoped_log!(
            info,
            "executor",
            "start: overlay_ops={}, preselected_magic_modules={}, preselected_kasumi_modules={}",
            plan.overlay_ops.len(),
            plan.magic_module_ids.len(),
            plan.kasumi_module_ids.len()
        );
        let mut final_magic_ids: BTreeSet<String> = plan.magic_module_ids.iter().cloned().collect();
        let mut final_overlay_ids: BTreeSet<String> = BTreeSet::new();
        let mut final_overlay_partitions: BTreeSet<String> = BTreeSet::new();
        let planned_kasumi_ids = plan.kasumi_module_ids.clone();
        let mut mount_stats = MountStatistics::default();
        #[cfg(feature = "kasumi")]
        let kasumi = KasumiCoordinator::new(config);

        #[cfg(feature = "kasumi")]
        let kasumi_available = if config.kasumi.enabled {
            kasumi.reset_runtime().map_err(|err| {
                ModuleStageFailure::new(
                    FailureStage::Execute,
                    planned_kasumi_ids.clone(),
                    anyhow::anyhow!("Failed to reset Kasumi runtime: {:#}", err),
                )
            })?
        } else {
            crate::scoped_log!(
                debug,
                "executor",
                "kasumi disabled: skip_runtime_reset=true"
            );
            false
        };
        #[cfg(not(feature = "kasumi"))]
        let kasumi_available = false;
        if !kasumi_available && !planned_kasumi_ids.is_empty() {
            return Err(ModuleStageFailure::new(
                FailureStage::Execute,
                planned_kasumi_ids.clone(),
                anyhow::anyhow!("Kasumi became unavailable before execution"),
            )
            .into());
        }

        if Self::is_supported()? {
            crate::scoped_log!(info, "executor", "overlayfs: supported=true");
            for op in &plan.overlay_ops {
                crate::scoped_log!(
                    info,
                    "executor",
                    "overlay apply: partition={}, target={}, layers={}",
                    op.partition_name,
                    op.target,
                    op.lowerdirs.len()
                );
                #[cfg(feature = "kasumi")]
                let overlay_result = overlay::mount_overlay(op, config, &kasumi);
                #[cfg(not(feature = "kasumi"))]
                let overlay_result = overlay::mount_overlay(op, config);

                match overlay_result {
                    Ok(ids) => {
                        crate::scoped_log!(
                            info,
                            "executor",
                            "overlay success: target={}, modules={}",
                            op.target,
                            ids.len()
                        );
                        final_overlay_partitions.insert(op.partition_name.clone());
                        final_overlay_ids.extend(ids);
                        mount_stats.record_overlay_mount();
                    }
                    Err(err) => {
                        let involved_modules = fallback::collect_involved_modules(op);
                        let is_symlink_loop = fallback::is_symlink_loop_mount_error(&err);
                        if is_symlink_loop {
                            if !fallback::overlay_fallback_allowed(config) {
                                crate::scoped_log!(
                                    error,
                                    "executor",
                                    "overlay fallback denied: target={}, reason=symlink_loop, enable_overlay_fallback=false",
                                    op.target
                                );
                            } else if involved_modules.is_empty() {
                                crate::scoped_log!(
                                    error,
                                    "executor",
                                    "overlay fallback denied: target={}, reason=symlink_loop_no_modules",
                                    op.target
                                );
                            } else {
                                crate::scoped_log!(
                                    warn,
                                    "executor",
                                    "overlay fallback: target={}, reason=symlink_loop, modules={}",
                                    op.target,
                                    involved_modules.join(", ")
                                );
                                mount_stats.record_failed();
                                final_magic_ids.extend(involved_modules);
                                continue;
                            }
                        } else {
                            crate::scoped_log!(
                                error,
                                "executor",
                                "overlay failed: target={}, reason=non_symlink_loop",
                                op.target
                            );
                        }
                        return Err(ModuleStageFailure::new(
                            FailureStage::Execute,
                            involved_modules,
                            anyhow::anyhow!("Overlay mount failed for {}: {:#}", op.target, err),
                        )
                        .into());
                    }
                }
            }
        } else {
            if !plan.overlay_ops.is_empty() {
                if fallback::overlay_fallback_allowed(config) {
                    let fallback_ids = fallback::collect_overlay_modules_for_magic_fallback(plan);
                    if fallback_ids.is_empty() {
                        bail!(
                            "[executor] overlayfs unsupported and no modules could be inferred for magic fallback"
                        );
                    }
                    crate::scoped_log!(
                        warn,
                        "executor",
                        "overlayfs fallback: supported=false, switched_modules={}",
                        fallback_ids.len()
                    );
                    final_magic_ids.extend(fallback_ids);
                } else {
                    bail!("[executor] overlayfs unsupported and overlay operations are pending");
                }
            }
            crate::scoped_log!(
                info,
                "executor",
                "overlayfs: supported=false, pending_overlay_ops=0"
            );
        }

        plan.kasumi_add_rules.clear();
        plan.kasumi_merge_rules.clear();
        plan.kasumi_hide_rules.clear();
        let final_kasumi_ids = plan.kasumi_module_ids.clone();

        let magic_need_list: Vec<String> = final_magic_ids.iter().cloned().collect();

        if !magic_need_list.is_empty() {
            crate::scoped_log!(
                info,
                "executor",
                "magic apply: modules={}",
                magic_need_list.join(", ")
            );
            let (mounted_ids, magic_stats) = magic::mount_magic(
                modules,
                &magic_need_list,
                config,
                tempdir.as_ref(),
                kasumi_available,
            )
            .map_err(|err| {
                let failed_module_ids =
                    fallback::resolve_magic_failure_modules(&err, &magic_need_list);
                ModuleStageFailure::new(
                    FailureStage::Execute,
                    failed_module_ids.clone(),
                    anyhow::anyhow!(
                        "Failed to mount Magic Mount modules [{}]: {:#}",
                        failed_module_ids.join(", "),
                        err
                    ),
                )
            })?;
            mount_stats.merge(&magic_stats);
            let mounted_ids: BTreeSet<String> = mounted_ids.into_iter().collect();
            final_magic_ids.retain(|id| mounted_ids.contains(id));
            crate::scoped_log!(
                info,
                "executor",
                "magic complete: mounted_modules={}",
                mounted_ids.len()
            );
        }

        #[cfg(feature = "kasumi")]
        let kasumi_runtime_enabled = if config.kasumi.enabled {
            kasumi.apply_runtime(plan, modules).map_err(|err| {
                ModuleStageFailure::new(
                    FailureStage::Execute,
                    final_kasumi_ids.clone(),
                    anyhow::anyhow!("Failed to apply Kasumi late rules: {:#}", err),
                )
            })?
        } else {
            crate::scoped_log!(
                debug,
                "executor",
                "kasumi disabled: skip_runtime_apply=true"
            );
            false
        };
        #[cfg(not(feature = "kasumi"))]
        let kasumi_runtime_enabled = false;

        #[cfg(any(target_os = "linux", target_os = "android"))]
        if !config.disable_umount {
            let _ = umount_mgr::commit();
        }

        let result_overlay: Vec<String> = final_overlay_ids.into_iter().collect();
        let result_magic: Vec<String> = final_magic_ids.into_iter().collect();

        crate::scoped_log!(
            info,
            "executor",
            "complete: overlay_modules={}, magic_modules={}, kasumi_modules={}",
            result_overlay.len(),
            result_magic.len(),
            final_kasumi_ids.len()
        );

        Ok(ExecutionResult {
            overlay_module_ids: result_overlay,
            overlay_partitions: final_overlay_partitions.into_iter().collect(),
            magic_module_ids: result_magic,
            kasumi_module_ids: final_kasumi_ids,
            kasumi_runtime_enabled,
            mount_stats,
        })
    }

    fn is_supported() -> Result<bool> {
        crate::mount::overlayfs::utils::is_overlay_supported()
    }
}
