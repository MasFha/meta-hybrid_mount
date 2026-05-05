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
            ApiCommands, Cli, Commands, DaemonCommands, HideCommands, KasumiCommands,
            KasumiRuleCommands, LkmCommands,
        },
        cli_handlers, loader,
    },
    core::{
        api,
        daemon::{self, DaemonCommand, dispatch},
        startup,
    },
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
            ApiCommands::Storage => dispatch(cli, DaemonCommand::ApiStorage),
            ApiCommands::MountStats => dispatch(cli, DaemonCommand::ApiMountStats),
            ApiCommands::MountTopology => dispatch(cli, DaemonCommand::ApiMountTopology),
            ApiCommands::Partitions => cli_handlers::handle_api_partitions(cli),
            ApiCommands::Lkm => dispatch(cli, DaemonCommand::ApiLkm),
            ApiCommands::Features => cli_handlers::handle_api_features(),
            ApiCommands::Hooks => dispatch(cli, DaemonCommand::ApiHooks),
        }),
        Commands::Daemon { command } => match command {
            DaemonCommands::Launch => startup::run(cli),
            DaemonCommands::Serve => {
                let config = loader::load_config(cli)?;
                daemon::serve(config)
            }
            DaemonCommands::Ping => run_api_command(|| dispatch(cli, DaemonCommand::Ping)),
            DaemonCommands::Status => run_api_command(|| dispatch(cli, DaemonCommand::Status)),
        },
        Commands::Lkm { command } => match command {
            LkmCommands::Load => dispatch(cli, DaemonCommand::LkmLoad),
            LkmCommands::Unload => dispatch(cli, DaemonCommand::LkmUnload),
            LkmCommands::Status => dispatch(cli, DaemonCommand::LkmStatus),
        },
        Commands::Hide { command } => match command {
            HideCommands::List => dispatch(cli, DaemonCommand::HideList),
            HideCommands::Add { path } => {
                dispatch(cli, DaemonCommand::HideAdd { path: path.clone() })
            }
            HideCommands::Remove { path } => {
                dispatch(cli, DaemonCommand::HideRemove { path: path.clone() })
            }
            HideCommands::Apply => dispatch(cli, DaemonCommand::HideApply),
        },
        Commands::Kasumi { command } => match command {
            KasumiCommands::Status => dispatch(cli, DaemonCommand::KasumiStatus),
            KasumiCommands::List => dispatch(cli, DaemonCommand::KasumiList),
            KasumiCommands::Version => dispatch(cli, DaemonCommand::KasumiVersion),
            KasumiCommands::Features => dispatch(cli, DaemonCommand::KasumiFeatures),
            KasumiCommands::Hooks => dispatch(cli, DaemonCommand::KasumiHooks),
            KasumiCommands::Clear => dispatch(cli, DaemonCommand::KasumiClear),
            KasumiCommands::ReleaseConnection => {
                dispatch(cli, DaemonCommand::KasumiReleaseConnection)
            }
            KasumiCommands::InvalidateCache => dispatch(cli, DaemonCommand::KasumiInvalidateCache),
            KasumiCommands::FixMounts => dispatch(cli, DaemonCommand::KasumiFixMounts),
            KasumiCommands::RestoreUnameGlobal => {
                dispatch(cli, DaemonCommand::KasumiRestoreUnameGlobal)
            }
            KasumiCommands::SetUname {
                mode,
                release,
                version,
            } => dispatch(
                cli,
                DaemonCommand::KasumiSetUname {
                    mode: mode.clone(),
                    release: release.clone(),
                    version: version.clone(),
                },
            ),
            KasumiCommands::ClearUname { mode } => {
                dispatch(cli, DaemonCommand::KasumiClearUname { mode: mode.clone() })
            }
            KasumiCommands::Rule { command } => match command {
                KasumiRuleCommands::Add {
                    target,
                    source,
                    file_type,
                } => dispatch(
                    cli,
                    DaemonCommand::KasumiRuleAdd {
                        target: target.clone(),
                        source: source.clone(),
                        file_type: *file_type,
                    },
                ),
                KasumiRuleCommands::Merge { target, source } => dispatch(
                    cli,
                    DaemonCommand::KasumiRuleMerge {
                        target: target.clone(),
                        source: source.clone(),
                    },
                ),
                KasumiRuleCommands::Hide { path } => {
                    dispatch(cli, DaemonCommand::KasumiRuleHide { path: path.clone() })
                }
                KasumiRuleCommands::Delete { path } => {
                    dispatch(cli, DaemonCommand::KasumiRuleDelete { path: path.clone() })
                }
                KasumiRuleCommands::AddDir {
                    target_base,
                    source_dir,
                } => dispatch(
                    cli,
                    DaemonCommand::KasumiRuleAddDir {
                        target_base: target_base.clone(),
                        source_dir: source_dir.clone(),
                    },
                ),
                KasumiRuleCommands::RemoveDir {
                    target_base,
                    source_dir,
                } => dispatch(
                    cli,
                    DaemonCommand::KasumiRuleRemoveDir {
                        target_base: target_base.clone(),
                        source_dir: source_dir.clone(),
                    },
                ),
            },
        },
    }
}
