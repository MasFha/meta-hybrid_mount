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

use std::process::Command;

use anyhow::Result;
use semver::Version;

pub struct ModulePropData<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub version: &'a str,
    pub version_code: &'a str,
    pub author: &'a str,
    pub description: &'a str,
    pub update_json: &'a str,
}

pub fn calculate_version_code(version_str: &str) -> Result<String> {
    let version = Version::parse(version_str)?;
    Ok((version.major * 100000 + version.minor * 1000 + version.patch).to_string())
}

pub fn git_commit_count() -> Result<i32> {
    Ok(String::from_utf8(
        Command::new("git")
            .args(["rev-list", "--count", "HEAD"])
            .output()?
            .stdout,
    )?
    .trim()
    .parse::<i32>()?)
}

pub fn render_module_prop(data: &ModulePropData<'_>) -> String {
    format!(
        "id={}\nname={}\nversion={}\nversionCode={}\nauthor={}\ndescription={}\nupdateJson={}\nmetamodule=1\nwebuiIcon=launcher.png\n",
        data.id,
        data.name,
        data.version,
        data.version_code,
        data.author,
        data.description,
        data.update_json,
    )
}

pub fn render_webui_constants(
    version: &str,
    is_release: bool,
    config_path: &str,
    state_path: &str,
    binary_path: &str,
) -> String {
    format!(
        "export const APP_VERSION = \"{version}\";\nexport const IS_RELEASE = {is_release};\nexport const RUST_PATHS = {{\n  CONFIG: \"{config_path}\",\n  DAEMON_STATE: \"{state_path}\",\n  BINARY: \"{binary_path}\",\n}} as const;\n"
    )
}
