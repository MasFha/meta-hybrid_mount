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

use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::{
    conf::config::{Config, OverlayMode},
    core::{
        backend_capabilities::BackendCapabilities,
        inventory::Module,
        ops::{plan::MountPlan, sync},
        storage,
    },
    defs,
    domain::MountMode,
    mount::kasumi,
};

#[derive(Debug, Clone, Copy)]
pub struct KasumiPlanningState {
    pub requested: bool,
    pub available: bool,
}

pub struct KasumiCoordinator<'a> {
    config: &'a Config,
}

impl<'a> KasumiCoordinator<'a> {
    pub fn new(config: &'a Config) -> Self {
        Self { config }
    }

    pub fn module_requests_kasumi(module: &Module) -> bool {
        matches!(module.rules.default_mode, MountMode::Kasumi)
            || module
                .rules
                .paths
                .values()
                .any(|mode| matches!(mode, MountMode::Kasumi))
    }

    pub fn requested_by_modules(modules: &[Module]) -> bool {
        modules.iter().any(Self::module_requests_kasumi)
    }

    pub fn requested_module_ids(modules: &[Module]) -> Vec<String> {
        modules
            .iter()
            .filter(|module| Self::module_requests_kasumi(module))
            .map(|module| module.id.clone())
            .collect()
    }

    pub fn planning_state(
        &self,
        capabilities: &BackendCapabilities,
        modules: &[Module],
    ) -> KasumiPlanningState {
        KasumiPlanningState {
            requested: Self::requested_by_modules(modules),
            available: capabilities.can_use_kasumi(),
        }
    }

    pub fn backend_requested(
        &self,
        capabilities: &BackendCapabilities,
        modules: &[Module],
    ) -> bool {
        let planning = self.planning_state(capabilities, modules);
        planning.requested && planning.available
    }

    pub fn kasumi_modules<'m>(&self, modules: &'m [Module]) -> Vec<&'m Module> {
        modules
            .iter()
            .filter(|module| Self::module_requests_kasumi(module))
            .collect()
    }

    pub fn prepare_mirror_storage(
        &self,
        capabilities: &BackendCapabilities,
        modules: &[Module],
    ) -> Result<()> {
        if !self.backend_requested(capabilities, modules) {
            return Ok(());
        }

        let kasumi_modules = self.kasumi_modules(modules);
        let kasumi_sources = kasumi_modules
            .iter()
            .map(|module| module.source_path.clone())
            .collect::<Vec<PathBuf>>();

        crate::scoped_log!(
            info,
            "kasumi:coordinator",
            "mirror storage start: target={}, modules={}",
            self.config.kasumi.mirror_path.display(),
            kasumi_modules.len()
        );

        let kasumi_storage = storage::setup_with_sources(
            &self.config.kasumi.mirror_path,
            &kasumi_sources,
            matches!(self.config.overlay_mode, OverlayMode::Ext4),
            &self.config.mountsource,
            true,
            Path::new(defs::KASUMI_IMG_FILE),
        )?;

        let kasumi_modules = kasumi_modules.into_iter().cloned().collect::<Vec<_>>();
        sync::perform_sync(&kasumi_modules, kasumi_storage.mount_point(), self.config)?;

        crate::scoped_log!(
            info,
            "kasumi:coordinator",
            "mirror storage complete: mode={}, target={}",
            kasumi_storage.mode().as_str(),
            self.config.kasumi.mirror_path.display()
        );

        Ok(())
    }

    pub fn reset_runtime(&self) -> Result<bool> {
        kasumi::reset_runtime(self.config)
    }

    pub fn apply_runtime(&self, plan: &mut MountPlan, modules: &[Module]) -> Result<bool> {
        kasumi::apply(plan, modules, self.config)
    }

    pub fn hide_overlay_xattrs(&self, target: &Path) {
        if !self.config.kasumi.enabled
            || !self.config.kasumi.enable_hidexattr
            || !kasumi::can_operate(self.config)
        {
            return;
        }

        if let Err(err) = crate::sys::kasumi::hide_overlay_xattrs(target) {
            crate::scoped_log!(
                warn,
                "kasumi:coordinator",
                "hide overlay xattrs failed: target={}, error={:#}",
                target.display(),
                err
            );
        }
    }
}
