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
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::Path,
};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::{
    conf::{cli::Cli, config::Config, store::ConfigSession},
    core::runtime_state::RuntimeState,
    mount::kasumi as kasumi_mount,
};

pub(super) fn load_effective_config(cli: &Cli) -> Result<Config> {
    ConfigSession::load_persisted(cli)
}

pub(super) fn require_live_kasumi(config: &Config, description: &str) -> Result<()> {
    kasumi_mount::require_live(config, description)
}

pub(super) fn with_live_kasumi<T>(
    cli: &Cli,
    description: &str,
    op: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let config = load_effective_config(cli)?;
    require_live_kasumi(&config, description)?;
    op()
}

pub(super) fn load_runtime_state_or_default() -> RuntimeState {
    RuntimeState::load().unwrap_or_default()
}

pub(super) fn print_json<T: Serialize>(payload: &T, description: &str) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(payload)
            .with_context(|| format!("Failed to serialize {description}"))?
    );
    Ok(())
}

pub(super) fn detect_rule_file_type(path: &Path) -> Result<i32> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to read source metadata for {}", path.display()))?;
    let file_type = metadata.file_type();

    if file_type.is_char_device() && metadata.rdev() == 0 {
        bail!(
            "source {} is a whiteout node; use `kasumi rule hide` instead",
            path.display()
        );
    }

    if file_type.is_file() {
        Ok(libc::DT_REG as i32)
    } else if file_type.is_symlink() {
        Ok(libc::DT_LNK as i32)
    } else {
        bail!(
            "unsupported source type for rule add: {} (use `merge` or `add-dir` for directories)",
            path.display()
        )
    }
}
