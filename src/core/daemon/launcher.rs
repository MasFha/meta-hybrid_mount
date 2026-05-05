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
    env, fs,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};

use super::client;
use crate::{conf::cli::Cli, defs, sys, utils};

const READY_TIMEOUT: Duration = Duration::from_secs(5);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub fn launch(cli: &Cli) -> Result<()> {
    sys::fs::ensure_dir_exists(defs::RUN_DIR)
        .with_context(|| format!("Failed to create run directory: {}", defs::RUN_DIR))?;

    cleanup_runtime_files()?;
    let mut child = spawn_serve_process(cli)?;

    match wait_until_ready(cli, &mut child, READY_TIMEOUT, READY_POLL_INTERVAL) {
        Ok(()) => {
            notify_module_mounted_if_available();
            Ok(())
        }
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = cleanup_runtime_files();
            Err(err)
        }
    }
}

fn cleanup_runtime_files() -> Result<()> {
    remove_runtime_file(defs::PID_FILE)?;
    remove_runtime_file(defs::SOCKET_FILE)?;
    Ok(())
}

fn remove_runtime_file(path: &str) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("Failed to remove runtime file {}", path)),
    }
}

fn spawn_serve_process(cli: &Cli) -> Result<Child> {
    let current_exe = env::current_exe().context("Failed to resolve current executable")?;
    let mut command = Command::new(current_exe);

    if let Some(config_path) = &cli.config {
        command.arg("--config").arg(config_path);
    }

    command.arg("daemon").arg("serve");

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    command
        .spawn()
        .context("Failed to spawn daemon serve process")
}

fn wait_until_ready(
    cli: &Cli,
    child: &mut Child,
    timeout: Duration,
    interval: Duration,
) -> Result<()> {
    let deadline = Instant::now() + timeout;

    loop {
        if let Some(status) = child
            .try_wait()
            .context("Failed to poll daemon serve process")?
        {
            bail!("daemon serve exited before ready: status={status}");
        }

        if client::ping(cli).is_ok() {
            return Ok(());
        }

        if Instant::now() >= deadline {
            let socket_exists = Path::new(defs::SOCKET_FILE).exists();
            return Err(anyhow!(
                "daemon did not become ready in time: socket_exists={socket_exists}"
            ));
        }

        thread::sleep(interval);
    }
}

fn notify_module_mounted_if_available() {
    if !utils::KSU.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }

    let candidates = ["/data/adb/ksud", "ksud"];
    let mut last_failure = None;

    for candidate in candidates {
        match Command::new(candidate)
            .arg("kernel")
            .arg("notify-module-mounted")
            .output()
        {
            Ok(output) if output.status.success() => return,
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let detail = if !stderr.is_empty() { stderr } else { stdout };
                last_failure = Some(format!(
                    "{} kernel notify-module-mounted failed with status {}{}",
                    candidate,
                    output.status,
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!(": {detail}")
                    }
                ));
            }
            Err(err) => {
                last_failure = Some(format!("failed to execute {}: {}", candidate, err));
            }
        }
    }

    if let Some(err) = last_failure {
        crate::scoped_log!(
            warn,
            "daemon",
            "notify-module-mounted skipped: error={}",
            err
        );
    }
}
