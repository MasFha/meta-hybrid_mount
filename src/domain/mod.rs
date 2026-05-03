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

use std::{collections::HashMap, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DefaultMode {
    #[default]
    Overlay,
    Magic,
    Kasumi,
}

impl DefaultMode {
    pub fn as_mount_mode(&self) -> MountMode {
        match self {
            Self::Overlay => MountMode::Overlay,
            Self::Magic => MountMode::Magic,
            Self::Kasumi => MountMode::Kasumi,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MountMode {
    #[default]
    Overlay,
    Magic,
    Kasumi,
    Ignore,
}

impl MountMode {
    pub fn as_strategy(&self) -> &'static str {
        match self {
            Self::Overlay => "overlay",
            Self::Magic => "magic",
            Self::Kasumi => "kasumi",
            Self::Ignore => "ignore",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModuleRules {
    #[serde(default)]
    pub default_mode: MountMode,
    #[serde(default)]
    pub paths: HashMap<String, MountMode>,
}

impl ModuleRules {
    pub fn get_mode(&self, relative_path: &str) -> MountMode {
        let mut best_match = None;
        let mut best_len = 0usize;

        for (path, mode) in &self.paths {
            let is_exact = relative_path == path;
            let is_prefix = relative_path.len() > path.len()
                && relative_path.starts_with(path)
                && relative_path.as_bytes().get(path.len()) == Some(&b'/');

            if (is_exact || is_prefix) && path.len() >= best_len {
                best_match = Some(*mode);
                best_len = path.len();
            }
        }

        if let Some(mode) = best_match {
            return mode;
        }

        self.default_mode
    }

    pub fn effective_mode(&self, relative_path: &Path, use_kasumi: bool) -> MountMode {
        let mode = self.get_mode(relative_path.to_string_lossy().as_ref());
        if matches!(mode, MountMode::Kasumi) && !use_kasumi {
            MountMode::Ignore
        } else {
            mode
        }
    }

    pub fn has_descendant_rule(&self, relative_path: &Path) -> bool {
        let relative = relative_path.to_string_lossy();
        let prefix = format!("{relative}/");
        self.paths.keys().any(|path| path.starts_with(&prefix))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rules(default_mode: MountMode, paths: &[(&str, MountMode)]) -> ModuleRules {
        ModuleRules {
            default_mode,
            paths: paths.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    #[test]
    fn exact_match_wins() {
        let rules = make_rules(MountMode::Overlay, &[("system", MountMode::Magic)]);
        assert_eq!(rules.get_mode("system"), MountMode::Magic);
    }

    #[test]
    fn prefix_match_wins() {
        let rules = make_rules(MountMode::Overlay, &[("system", MountMode::Magic)]);
        assert_eq!(rules.get_mode("system/app"), MountMode::Magic);
    }

    #[test]
    fn prefix_not_partial_word() {
        let rules = make_rules(MountMode::Overlay, &[("sys", MountMode::Magic)]);
        // "system" starts with "sys" but "sys" is not a path component prefix
        assert_eq!(rules.get_mode("system"), MountMode::Overlay);
    }

    #[test]
    fn longest_match_wins() {
        let rules = make_rules(
            MountMode::Overlay,
            &[
                ("system", MountMode::Magic),
                ("system/app", MountMode::Kasumi),
            ],
        );
        assert_eq!(rules.get_mode("system/app/foo"), MountMode::Kasumi);
        assert_eq!(rules.get_mode("system/priv-app"), MountMode::Magic);
    }

    #[test]
    fn default_mode_fallback() {
        let rules = make_rules(MountMode::Ignore, &[]);
        assert_eq!(rules.get_mode("any/path"), MountMode::Ignore);
    }

    #[test]
    fn empty_rules_returns_default() {
        let rules = make_rules(MountMode::Kasumi, &[]);
        assert_eq!(rules.get_mode("system"), MountMode::Kasumi);
    }

    #[test]
    fn exact_and_prefix_same_len_exact_wins() {
        let rules = make_rules(
            MountMode::Overlay,
            &[
                ("sys", MountMode::Magic),
                ("sys", MountMode::Kasumi), // later entry overwrites in HashMap
            ],
        );
        assert_eq!(rules.get_mode("sys"), MountMode::Kasumi);
    }

    #[test]
    fn root_slash_path_not_matched_as_prefix() {
        let rules = make_rules(MountMode::Overlay, &[("system/", MountMode::Magic)]);
        // "system" is not a prefix match for key "system/" because there's no trailing slash
        assert_eq!(rules.get_mode("system"), MountMode::Overlay);
    }
}
