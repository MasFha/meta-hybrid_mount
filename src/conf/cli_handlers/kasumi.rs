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

use anyhow::Result;
use serde::Serialize;

use super::shared::{
    detect_rule_file_type, load_effective_config, load_runtime_state_or_default, print_json,
    with_live_kasumi,
};
use crate::{
    conf::{cli::Cli, schema::KasumiConfig},
    core::{
        api::{self, LkmPayload},
        runtime_state::KasumiRuntimeInfo,
    },
    mount::kasumi as kasumi_mount,
    sys::kasumi,
};

#[derive(Debug, Clone, Serialize)]
struct KasumiStatusPayload {
    pub status: String,
    pub available: bool,
    pub protocol_version: Option<i32>,
    pub feature_bits: Option<i32>,
    pub feature_names: Vec<String>,
    pub hooks: Vec<String>,
    pub rule_count: usize,
    pub user_hide_rule_count: usize,
    pub mirror_path: std::path::PathBuf,
    pub lkm: LkmPayload,
    pub config: KasumiConfig,
    pub runtime: KasumiStatusRuntime,
}

#[derive(Debug, Clone, Serialize)]
struct KasumiStatusRuntime {
    pub snapshot: KasumiRuntimeInfo,
    pub kasumi_modules: Vec<String>,
    pub active_mounts: Vec<String>,
}

pub fn handle_kasumi_status(cli: &Cli) -> Result<()> {
    let config = load_effective_config(cli)?;
    let runtime_state = load_runtime_state_or_default();
    let kasumi_info = kasumi_mount::collect_runtime_info(&config);

    let output = KasumiStatusPayload {
        status: kasumi_info.status,
        available: kasumi_info.available,
        protocol_version: kasumi_info.protocol_version,
        feature_bits: kasumi_info.feature_bits,
        feature_names: kasumi_info.feature_names,
        hooks: kasumi_info.hooks,
        rule_count: kasumi_info.rule_count,
        user_hide_rule_count: kasumi_info.user_hide_rule_count,
        mirror_path: kasumi_info.mirror_path,
        lkm: api::build_lkm_payload(&config),
        config: config.kasumi.clone(),
        runtime: KasumiStatusRuntime {
            snapshot: runtime_state.kasumi.clone(),
            kasumi_modules: runtime_state.kasumi_modules.clone(),
            active_mounts: runtime_state.active_mounts.clone(),
        },
    };

    print_json(&output, "Kasumi status")
}

pub fn handle_kasumi_list(cli: &Cli) -> Result<()> {
    let config = load_effective_config(cli)?;
    let payload = if kasumi_mount::can_operate(&config) {
        api::parse_kasumi_rule_listing(&kasumi::get_active_rules()?)
    } else {
        Vec::new()
    };
    print_json(&payload, "Kasumi rules")
}

pub fn handle_kasumi_version(cli: &Cli) -> Result<()> {
    let config = load_effective_config(cli)?;
    let state = load_runtime_state_or_default();
    let payload = api::build_kasumi_version_payload(&config, &state);
    print_json(&payload, "Kasumi version")
}

pub fn handle_kasumi_features() -> Result<()> {
    let output = api::build_features_payload();
    print_json(&output, "Kasumi features")
}

pub fn handle_kasumi_hooks() -> Result<()> {
    println!("{}", kasumi_mount::hook_lines()?.join("\n"));
    Ok(())
}

pub fn handle_kasumi_clear() -> Result<()> {
    crate::scoped_log!(info, "cli:kasumi:clear", "start");
    kasumi::clear_rules()?;
    crate::scoped_log!(info, "cli:kasumi:clear", "complete");
    println!("Kasumi rules cleared.");
    Ok(())
}

pub fn handle_kasumi_release_connection() -> Result<()> {
    kasumi::release_connection();
    println!("Released cached Kasumi client connection.");
    Ok(())
}

pub fn handle_kasumi_invalidate_cache() -> Result<()> {
    kasumi::invalidate_status_cache();
    println!("Invalidated cached Kasumi status.");
    Ok(())
}

pub fn handle_kasumi_fix_mounts() -> Result<()> {
    crate::scoped_log!(info, "cli:kasumi:fix_mounts", "start");
    kasumi::fix_mounts()?;
    crate::scoped_log!(info, "cli:kasumi:fix_mounts", "complete");
    println!("Kasumi mount ordering fixed.");
    Ok(())
}

pub fn handle_kasumi_rule_add(
    cli: &Cli,
    target: &Path,
    source: &Path,
    file_type: Option<i32>,
) -> Result<()> {
    let file_type = match file_type {
        Some(value) => value,
        None => detect_rule_file_type(source)?,
    };
    with_live_kasumi(cli, "add Kasumi rule", || {
        kasumi::add_rule(target, source, file_type)?;
        println!(
            "Kasumi ADD rule applied: target={}, source={}, file_type={}",
            target.display(),
            source.display(),
            file_type
        );
        Ok(())
    })
}

pub fn handle_kasumi_rule_merge(cli: &Cli, target: &Path, source: &Path) -> Result<()> {
    with_live_kasumi(cli, "add Kasumi merge rule", || {
        kasumi::add_merge_rule(target, source)?;
        println!(
            "Kasumi MERGE rule applied: target={}, source={}",
            target.display(),
            source.display()
        );
        Ok(())
    })
}

pub fn handle_kasumi_rule_hide(cli: &Cli, path: &Path) -> Result<()> {
    with_live_kasumi(cli, "add Kasumi hide rule", || {
        kasumi::hide_path(path)?;
        println!("Kasumi HIDE rule applied: {}", path.display());
        Ok(())
    })
}

pub fn handle_kasumi_rule_delete(cli: &Cli, path: &Path) -> Result<()> {
    with_live_kasumi(cli, "delete Kasumi rule", || {
        kasumi::delete_rule(path)?;
        println!("Kasumi rule deleted: {}", path.display());
        Ok(())
    })
}

pub fn handle_kasumi_rule_add_dir(cli: &Cli, target_base: &Path, source_dir: &Path) -> Result<()> {
    with_live_kasumi(cli, "add Kasumi rules from directory", || {
        kasumi::add_rules_from_directory(target_base, source_dir)?;
        println!(
            "Kasumi directory rules applied: target_base={}, source_dir={}",
            target_base.display(),
            source_dir.display()
        );
        Ok(())
    })
}

pub fn handle_kasumi_rule_remove_dir(
    cli: &Cli,
    target_base: &Path,
    source_dir: &Path,
) -> Result<()> {
    with_live_kasumi(cli, "remove Kasumi rules from directory", || {
        kasumi::remove_rules_from_directory(target_base, source_dir)?;
        println!(
            "Kasumi directory rules removed: target_base={}, source_dir={}",
            target_base.display(),
            source_dir.display()
        );
        Ok(())
    })
}
