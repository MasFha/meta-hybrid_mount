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
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    process::Command,
    thread,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use super::protocol::{DaemonCommand, DaemonRequest, DaemonResponse};
use crate::{conf::cli::Cli, defs};

pub fn dispatch(cli: &Cli, command: DaemonCommand) -> Result<()> {
    let response = send_request(cli, command)?;
    ensure_ok(&response, "daemon request")?;

    if let Some(payload) = response.data {
        print_json(&payload).context("Failed to print daemon response")?;
    }
    Ok(())
}

fn ensure_ok(response: &DaemonResponse, context: &str) -> Result<()> {
    if !response.ok {
        if let Some(error) = &response.error {
            bail!(error.clone());
        }
        bail!("{context} failed without error message");
    }
    Ok(())
}

fn send_request(cli: &Cli, command: DaemonCommand) -> Result<DaemonResponse> {
    let mut stream = match connect_socket() {
        Ok(stream) => stream,
        Err(first_err) => {
            if should_wake_daemon(&first_err) {
                wake_daemon(cli).context("Failed to wake daemon")?;
                connect_socket().with_context(|| {
                    format!(
                        "Failed to connect to daemon socket {} after wake attempt",
                        defs::SOCKET_FILE
                    )
                })?
            } else {
                return Err(first_err).with_context(|| {
                    format!("Failed to connect to daemon socket {}", defs::SOCKET_FILE)
                });
            }
        }
    };

    let request = DaemonRequest {
        command,
        config_path: cli.config.clone(),
    };
    let serialized =
        serde_json::to_string(&request).context("Failed to serialize daemon request")?;
    stream
        .write_all(serialized.as_bytes())
        .context("Failed to write daemon request")?;
    stream
        .write_all(b"\n")
        .context("Failed to terminate daemon request")?;
    stream.flush().context("Failed to flush daemon request")?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let bytes = reader
        .read_line(&mut line)
        .context("Failed to read daemon response")?;
    if bytes == 0 {
        bail!("daemon closed the connection without a response");
    }

    serde_json::from_str(line.trim_end()).context("Failed to parse daemon response")
}

fn connect_socket() -> Result<UnixStream> {
    UnixStream::connect(defs::SOCKET_FILE)
        .with_context(|| format!("Failed to connect to daemon socket {}", defs::SOCKET_FILE))
}

fn should_wake_daemon(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}");
    text.contains("No such file or directory") || text.contains("Connection refused")
}

fn wake_daemon(cli: &Cli) -> Result<()> {
    let current_exe = std::env::current_exe().context("Failed to locate current binary")?;
    let mut command = Command::new(current_exe);
    if let Some(config) = &cli.config {
        command.arg("--config").arg(config);
    }
    command.arg("daemon").arg("launch");
    let status = command.status().context("Failed to spawn daemon launch")?;
    if !status.success() {
        bail!("daemon launch exited with status {status}");
    }
    thread::sleep(Duration::from_millis(300));
    Ok(())
}

fn print_json<T: Serialize>(payload: &T) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(payload).context("Failed to serialize daemon payload")?
    );
    Ok(())
}
