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

use anyhow::{Context, Result};

use crate::{
    conf::{cli::Cli, loader},
    defs, sys, utils,
};

mod recovery;

pub fn run(cli: &Cli) -> Result<()> {
    sys::fs::ensure_dir_exists(defs::RUN_DIR)
        .with_context(|| format!("Failed to create run directory: {}", defs::RUN_DIR))?;

    utils::init_logging().context("Failed to initialize logging")?;
    crate::scoped_log!(info, "startup", "init: daemon=hybrid-mount");

    utils::check_ksu();

    let config = loader::load_startup_config(cli)?;

    if let Ok(version) = std::fs::read_to_string("/proc/sys/kernel/osrelease") {
        crate::scoped_log!(debug, "startup", "kernel: version={}", version.trim());
    }

    if config.kasumi.enabled {
        match sys::lkm::autoload_if_needed(&config.kasumi) {
            Ok(true) => {
                crate::scoped_log!(
                    info,
                    "startup",
                    "kasumi lkm autoload: loaded=true, dir={}",
                    config.kasumi.lkm_dir.display()
                );
            }
            Ok(false) => {
                crate::scoped_log!(
                    debug,
                    "startup",
                    "kasumi lkm autoload: loaded=false, reason=not_needed"
                );
            }
            Err(err) => {
                crate::scoped_log!(
                    warn,
                    "startup",
                    "kasumi lkm autoload failed: error={:#}",
                    err
                );
            }
        }
    } else {
        crate::scoped_log!(debug, "startup", "kasumi disabled: skip_lkm_autoload=true");
    }

    if config.disable_umount {
        crate::scoped_log!(warn, "startup", "config: disable_umount=true");
    }

    recovery::run(config)
}
