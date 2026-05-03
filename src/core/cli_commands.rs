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

use crate::{
    conf::{
        cli::{
            ApiCommands, Cli, Commands, HideCommands, KasumiCommands, KasumiRuleCommands,
            LkmCommands,
        },
        cli_handlers,
    },
    core::api,
};

fn run_api_command<F>(f: F) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    match f() {
        Ok(()) => Ok(()),
        Err(err) => {
            api::print_json_error(&err);
            Ok(())
        }
    }
}

pub fn run(cli: &Cli, command: &Commands) -> Result<()> {
    let _ = crate::utils::init_logging();

    match command {
        Commands::GenConfig { output, force } => cli_handlers::handle_gen_config(output, *force),
        Commands::Logs { lines } => cli_handlers::handle_logs(*lines),
        Commands::Api { command } => run_api_command(|| match command {
            ApiCommands::Storage => cli_handlers::handle_api_storage(),
            ApiCommands::MountStats => cli_handlers::handle_api_mount_stats(),
            ApiCommands::MountTopology => cli_handlers::handle_api_mount_topology(cli),
            ApiCommands::Partitions => cli_handlers::handle_api_partitions(cli),
            ApiCommands::Lkm => cli_handlers::handle_api_lkm(cli),
            ApiCommands::Features => cli_handlers::handle_api_features(),
            ApiCommands::Hooks => cli_handlers::handle_api_hooks(cli),
        }),
        Commands::Lkm { command } => match command {
            LkmCommands::Load => cli_handlers::handle_lkm_load(cli),
            LkmCommands::Unload => cli_handlers::handle_lkm_unload(cli),
            LkmCommands::Status => cli_handlers::handle_lkm_status(cli),
        },
        Commands::Hide { command } => match command {
            HideCommands::List => cli_handlers::handle_hide_list(),
            HideCommands::Add { path } => cli_handlers::handle_hide_add(cli, path),
            HideCommands::Remove { path } => cli_handlers::handle_hide_remove(path),
            HideCommands::Apply => cli_handlers::handle_hide_apply(cli),
        },
        Commands::Kasumi { command } => match command {
            KasumiCommands::Status => cli_handlers::handle_kasumi_status(cli),
            KasumiCommands::List => cli_handlers::handle_kasumi_list(cli),
            KasumiCommands::Version => cli_handlers::handle_kasumi_version(cli),
            KasumiCommands::Features => cli_handlers::handle_kasumi_features(),
            KasumiCommands::Hooks => cli_handlers::handle_kasumi_hooks(),
            KasumiCommands::Clear => cli_handlers::handle_kasumi_clear(),
            KasumiCommands::ReleaseConnection => cli_handlers::handle_kasumi_release_connection(),
            KasumiCommands::InvalidateCache => cli_handlers::handle_kasumi_invalidate_cache(),
            KasumiCommands::FixMounts => cli_handlers::handle_kasumi_fix_mounts(),
            KasumiCommands::RestoreUnameGlobal => {
                cli_handlers::handle_kasumi_restore_uname_global()
            }
            KasumiCommands::Rule { command } => match command {
                KasumiRuleCommands::Add {
                    target,
                    source,
                    file_type,
                } => cli_handlers::handle_kasumi_rule_add(cli, target, source, *file_type),
                KasumiRuleCommands::Merge { target, source } => {
                    cli_handlers::handle_kasumi_rule_merge(cli, target, source)
                }
                KasumiRuleCommands::Hide { path } => {
                    cli_handlers::handle_kasumi_rule_hide(cli, path)
                }
                KasumiRuleCommands::Delete { path } => {
                    cli_handlers::handle_kasumi_rule_delete(cli, path)
                }
                KasumiRuleCommands::AddDir {
                    target_base,
                    source_dir,
                } => cli_handlers::handle_kasumi_rule_add_dir(cli, target_base, source_dir),
                KasumiRuleCommands::RemoveDir {
                    target_base,
                    source_dir,
                } => cli_handlers::handle_kasumi_rule_remove_dir(cli, target_base, source_dir),
            },
        },
    }
}
