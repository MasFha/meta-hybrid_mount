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

mod walk;

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use anyhow::Result;

use self::walk::{PlannerContext, plan_module_roots};
use crate::{
    conf::config,
    core::{
        backend_capabilities::BackendCapabilities,
        inventory::Module,
        kasumi_coordinator::KasumiCoordinator,
        ops::plan::{MountPlan, OverlayOperation},
    },
    domain::MountMode,
    partitions, utils,
};

fn sorted_ids(ids: HashSet<String>) -> Vec<String> {
    let mut out: Vec<String> = ids.into_iter().collect();
    out.sort();
    out
}

fn module_content_path(storage_root: &Path, module: &Module) -> Option<PathBuf> {
    let mut content_path = storage_root.join(&module.id);
    if !content_path.exists() {
        content_path = module.source_path.clone();
    }
    content_path.exists().then_some(content_path)
}

fn log_mode_decision(
    module: &Module,
    relative_path: &Path,
    requested_mode: &MountMode,
    effective_mode: &MountMode,
) {
    let relative_display = relative_path.display();
    if requested_mode != effective_mode {
        crate::scoped_log!(
            info,
            "planner",
            "mode decision: module={}, relative={}, requested={}, effective={}",
            module.id,
            relative_display,
            requested_mode.as_strategy(),
            effective_mode.as_strategy()
        );
    } else {
        crate::scoped_log!(
            debug,
            "planner",
            "mode decision: module={}, relative={}, requested={}, effective={}",
            module.id,
            relative_display,
            requested_mode.as_strategy(),
            effective_mode.as_strategy()
        );
    }
}

pub fn generate(
    config: &config::Config,
    modules: &[Module],
    storage_root: &Path,
    capabilities: &BackendCapabilities,
) -> Result<MountPlan> {
    generate_with_root(config, modules, storage_root, Path::new("/"), capabilities)
}

fn generate_with_root(
    config: &config::Config,
    modules: &[Module],
    storage_root: &Path,
    system_root: &Path,
    capabilities: &BackendCapabilities,
) -> Result<MountPlan> {
    crate::scoped_log!(
        info,
        "planner",
        "start: modules={}, storage_root={}",
        modules.len(),
        storage_root.display()
    );

    let mut plan = MountPlan::default();

    let module_rank: HashMap<&str, usize> = modules
        .iter()
        .enumerate()
        .map(|(idx, m)| (m.id.as_str(), idx))
        .collect();

    let mut magic_ids = HashSet::new();
    let mut kasumi_ids = HashSet::new();

    let managed_partitions = partitions::managed_partition_set(&config.partitions);
    let kasumi = KasumiCoordinator::new(config);
    let kasumi_planning = kasumi.planning_state(capabilities, modules);
    let mut planner = PlannerContext::new(
        config,
        kasumi_planning.available,
        managed_partitions.clone(),
    );

    if kasumi_planning.requested && !kasumi_planning.available {
        if config.kasumi.enabled {
            crate::scoped_log!(
                warn,
                "planner",
                "kasumi fallback: enabled=true, status={}, action=ignore",
                capabilities.kasumi_status()
            );
        } else {
            crate::scoped_log!(
                warn,
                "planner",
                "kasumi fallback: enabled=false, action=ignore"
            );
        }
    }

    for module in modules {
        crate::scoped_log!(debug, "planner", "module inspect: id={}", module.id);
        let Some(content_path) = module_content_path(storage_root, module) else {
            crate::scoped_log!(
                debug,
                "planner",
                "module skip: id={}, reason=content_path_missing",
                module.id,
            );
            continue;
        };

        let presence = plan_module_roots(
            module,
            &content_path,
            system_root,
            &managed_partitions,
            &mut planner,
        );
        if presence.magic {
            magic_ids.insert(module.id.clone());
        }
        if presence.kasumi {
            kasumi_ids.insert(module.id.clone());
        }
    }

    let mut overlay_ids = HashSet::new();
    for (target_path, (partition_name, mut layers)) in planner.into_overlay_groups() {
        let target_str = target_path.to_string_lossy().into_owned();

        if !target_path.is_dir() {
            continue;
        }

        layers.sort_by_cached_key(|path| {
            let module_id = utils::extract_module_id(path).filter(|id| !id.is_empty());
            (
                module_id
                    .as_deref()
                    .and_then(|id| module_rank.get(id))
                    .copied()
                    .unwrap_or(usize::MAX),
                path.clone(),
            )
        });

        crate::scoped_log!(
            info,
            "planner",
            "overlay op: partition={}, target={}, layers={}",
            partition_name,
            target_str,
            layers.len()
        );

        for layer in &layers {
            if let Some(module_id) = utils::extract_module_id(layer) {
                overlay_ids.insert(module_id);
            }
        }

        plan.overlay_ops.push(OverlayOperation {
            partition_name,
            target: target_str,
            lowerdirs: layers,
        });
    }

    plan.overlay_module_ids = sorted_ids(overlay_ids);
    plan.magic_module_ids = sorted_ids(magic_ids);
    plan.kasumi_module_ids = sorted_ids(kasumi_ids);

    crate::scoped_log!(
        info,
        "planner",
        "complete: overlay_ops={}, overlay_modules={}, magic_modules={}, kasumi_modules={}, kasumi_rule_compile=deferred",
        plan.overlay_ops.len(),
        plan.overlay_module_ids.len(),
        plan.magic_module_ids.len(),
        plan.kasumi_module_ids.len()
    );

    Ok(plan)
}
