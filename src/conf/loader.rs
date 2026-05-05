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
    conf::{cli::Cli, config::Config},
    defs,
};

fn load_default_config() -> Result<Config> {
    let default_path = Path::new(defs::CONFIG_FILE);
    crate::scoped_log!(
        debug,
        "conf:loader",
        "start: mode=default, path={}",
        default_path.display()
    );
    if !default_path.exists() {
        crate::scoped_log!(
            debug,
            "conf:loader",
            "fallback: mode=default, reason=config_missing, path={}",
            default_path.display()
        );
        return Ok(Config::default());
    }

    let config = Config::load_optional_from_file(default_path).with_context(|| {
        format!(
            "Failed to load config from default path: {}",
            default_path.display()
        )
    })?;

    crate::scoped_log!(
        debug,
        "conf:loader",
        "complete: mode=default, path={}",
        default_path.display()
    );

    Ok(config)
}

pub fn load_config(cli: &Cli) -> Result<Config> {
    if let Some(config_path) = &cli.config {
        crate::scoped_log!(
            debug,
            "conf:loader",
            "start: mode=custom, path={}",
            config_path.display()
        );

        let config = Config::load_optional_from_file(config_path).with_context(|| {
            format!(
                "Failed to load config from custom path: {}",
                config_path.display()
            )
        })?;

        crate::scoped_log!(
            debug,
            "conf:loader",
            "complete: mode=custom, path={}",
            config_path.display()
        );

        return Ok(config);
    }

    load_default_config()
}
