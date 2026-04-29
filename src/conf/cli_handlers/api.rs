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

use anyhow::Result;

use super::shared::{
    load_effective_config, load_runtime_state_or_default, print_json, require_live_kasumi,
};
use crate::{conf::cli::Cli, core::api, mount::kasumi as kasumi_mount};

pub fn handle_api_storage() -> Result<()> {
    let state = load_runtime_state_or_default();
    let payload = api::build_storage_payload(&state);
    print_json(&payload, "storage payload")
}

pub fn handle_api_mount_stats() -> Result<()> {
    let state = load_runtime_state_or_default();
    let payload = api::build_mount_stats_payload(&state);
    print_json(&payload, "mount stats payload")
}

pub fn handle_api_mount_topology(cli: &Cli) -> Result<()> {
    let config = load_effective_config(cli)?;
    let state = load_runtime_state_or_default();
    let payload = api::build_mount_topology_payload(&config, &state);
    print_json(&payload, "mount topology payload")
}

pub fn handle_api_partitions(cli: &Cli) -> Result<()> {
    let config = load_effective_config(cli)?;
    let payload = api::build_partitions_payload(&config);
    print_json(&payload, "partitions payload")
}

pub fn handle_api_lkm(cli: &Cli) -> Result<()> {
    let config = load_effective_config(cli)?;
    let payload = api::build_lkm_payload(&config);
    print_json(&payload, "LKM payload")
}

pub fn handle_api_features() -> Result<()> {
    let payload = api::build_features_payload();
    print_json(&payload, "features payload")
}

pub fn handle_api_hooks(cli: &Cli) -> Result<()> {
    let config = load_effective_config(cli)?;
    require_live_kasumi(&config, "read Kasumi hooks")?;
    println!("{}", kasumi_mount::hook_lines()?.join("\n"));
    Ok(())
}
