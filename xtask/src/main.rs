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
    env,
    ffi::OsStr,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use fs_extra::{dir, file};
use hybrid_mount_notify::{NotifyRequest, maybe_send_output_dir_notification};
use zip::{CompressionMethod, write::FileOptions};

#[path = "build_meta_shared.rs"]
mod build_meta_shared;
mod zip_ext;
use crate::zip_ext::zip_create_from_directory_with_options;

const KASUMI_LKM_STAGE_DIR: &str = "kasumi_lkm";

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq)]
enum Arch {
    #[value(name = "arm64")]
    Arm64,
}

impl Arch {
    fn target(&self) -> &'static str {
        match self {
            Arch::Arm64 => "arm64-v8a",
        }
    }
    fn android_abi(&self) -> &'static str {
        match self {
            Arch::Arm64 => "aarch64-linux-android",
        }
    }
}

#[derive(Parser)]
#[command(name = "xtask")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Build {
        #[arg(long)]
        release: bool,
        #[arg(long)]
        skip_webui: bool,
        #[arg(long, value_enum)]
        arch: Option<Arch>,
        #[arg(long)]
        ci: bool,
        #[arg(long)]
        tag: Option<String>,
    },
    Lint,
}

struct VersionInfo {
    clean_version: String,
    full_version: String,
    version_code: String,
}

#[derive(Debug, Clone)]
struct NotifyPlan {
    topic_id: Option<i64>,
    event_label: String,
}

fn load_cargo_config() -> Result<build_meta_shared::CargoConfig> {
    let toml = fs::read_to_string("Cargo.toml")?;
    Ok(toml::from_str(&toml)?)
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Build {
            release,
            skip_webui,
            arch,
            ci,
            tag,
        } => {
            let (cargo_release, webui_release, target_archs) = if ci {
                (true, false, vec![Arch::Arm64])
            } else {
                let archs = if let Some(selected) = arch {
                    vec![selected]
                } else {
                    vec![Arch::Arm64]
                };
                (release, release, archs)
            };

            let version_info = if let Some(tag_name) = tag.as_deref() {
                resolve_release_version(tag_name)?
            } else {
                resolve_local_or_ci_version()?
            };

            let notify_plan = resolve_notify_plan(ci, tag.as_deref(), &version_info)?;

            build_full(
                cargo_release,
                webui_release,
                skip_webui,
                target_archs,
                &version_info,
                notify_plan.as_ref(),
            )?;
        }
        Commands::Lint => {
            run_clippy()?;
        }
    }
    Ok(())
}

fn run_clippy() -> Result<()> {
    let cargo = env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let status = Command::new(cargo)
        .args([
            "clippy",
            "--workspace",
            "--all-targets",
            "--all-features",
            "--",
            "-D",
            "warnings",
        ])
        .status()
        .context("Failed to run cargo clippy")?;

    if !status.success() {
        anyhow::bail!("Clippy found issues! Please fix them before committing.");
    }
    Ok(())
}

fn build_full(
    cargo_release: bool,
    webui_release: bool,
    skip_webui: bool,
    target_archs: Vec<Arch>,
    version_info: &VersionInfo,
    notify_plan: Option<&NotifyPlan>,
) -> Result<()> {
    let output_dir = Path::new("output");
    let stage_dir = output_dir.join("staging");
    if output_dir.exists() {
        fs::remove_dir_all(output_dir)?;
    }
    fs::create_dir_all(&stage_dir)?;

    if !skip_webui {
        build_webui(&version_info.clean_version, webui_release)?;
    }

    for arch in target_archs {
        compile_core(cargo_release, arch)?;
        let bin_name = "hybrid-mount";
        let profile = if cargo_release { "release" } else { "debug" };
        let src_bin = Path::new("target")
            .join(arch.android_abi())
            .join(profile)
            .join(bin_name);
        let stage_bin_dir = stage_dir.join("binaries").join(arch.target());
        fs::create_dir_all(&stage_bin_dir)?;
        if src_bin.exists() {
            file::copy(
                &src_bin,
                stage_bin_dir.join(bin_name),
                &file::CopyOptions::new().overwrite(true),
            )?;
        }
    }

    let module_src = Path::new("module");
    let options = dir::CopyOptions::new().overwrite(true).content_only(true);
    dir::copy(module_src, &stage_dir, &options)?;
    stage_kasumi_lkm_assets(&stage_dir)?;

    generate_module_prop(&stage_dir, version_info)?;

    let gitignore = stage_dir.join(".gitignore");
    if gitignore.exists() {
        fs::remove_file(gitignore)?;
    }

    let zip_file = output_dir.join(format!("Hybrid-Mount-{}.zip", version_info.full_version));
    let zip_options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(9));
    zip_create_from_directory_with_options(&zip_file, &stage_dir, |_| zip_options)?;

    maybe_notify_build(output_dir, notify_plan)?;

    Ok(())
}

fn maybe_notify_build(output_dir: &Path, notify_plan: Option<&NotifyPlan>) -> Result<()> {
    let Some(notify_plan) = notify_plan else {
        return Ok(());
    };

    let sent = maybe_send_output_dir_notification(
        &NotifyRequest::new(output_dir, notify_plan.event_label.clone())
            .with_topic_id(notify_plan.topic_id),
    )?;

    if !sent {
        eprintln!("info: Telegram secrets not set, skipping notification");
    }

    Ok(())
}

fn resolve_notify_plan(
    ci: bool,
    tag: Option<&str>,
    version_info: &VersionInfo,
) -> Result<Option<NotifyPlan>> {
    let notify_enabled = env_truthy("HYBRID_MOUNT_NOTIFY").unwrap_or(false);
    let topic_override = env::var("HYBRID_MOUNT_NOTIFY_TOPIC_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            value
                .parse::<i64>()
                .with_context(|| format!("invalid HYBRID_MOUNT_NOTIFY_TOPIC_ID: {value}"))
        })
        .transpose()?;
    let label_override = env::var("HYBRID_MOUNT_NOTIFY_LABEL")
        .ok()
        .filter(|value| !value.trim().is_empty());

    if !notify_enabled && topic_override.is_none() && label_override.is_none() {
        return Ok(None);
    }

    let default_label = if let Some(tag) = tag {
        format!("丰收 (Harvest) - {tag}")
    } else if ci {
        format!(
            "日常耕作 🌱 (Daily Tilling) - {}",
            version_info.full_version
        )
    } else {
        format!("新产物 (New Yield) - {}", version_info.full_version)
    };

    let default_topic_id = if tag.is_some() {
        Some(6)
    } else if ci {
        Some(37)
    } else {
        None
    };

    Ok(Some(NotifyPlan {
        topic_id: topic_override.or(default_topic_id),
        event_label: label_override.unwrap_or(default_label),
    }))
}

fn stage_kasumi_lkm_assets(stage_dir: &Path) -> Result<()> {
    let Some(source_dir) = env::var_os("HYBRID_MOUNT_KASUMI_LKM_DIR").map(PathBuf::from) else {
        return Ok(());
    };

    if !source_dir.is_dir() {
        bail!(
            "HYBRID_MOUNT_KASUMI_LKM_DIR must point to a directory containing .ko files: {}",
            source_dir.display()
        );
    }

    let artifacts = collect_kasumi_lkm_artifacts(&source_dir)?;
    if artifacts.is_empty() {
        bail!(
            "No .ko files were found under HYBRID_MOUNT_KASUMI_LKM_DIR={}",
            source_dir.display()
        );
    }

    let lkm_stage_dir = stage_dir.join(KASUMI_LKM_STAGE_DIR);
    fs::create_dir_all(&lkm_stage_dir)?;

    for artifact in artifacts {
        let Some(file_name) = artifact.file_name() else {
            continue;
        };
        file::copy(
            &artifact,
            lkm_stage_dir.join(file_name),
            &file::CopyOptions::new().overwrite(true),
        )?;
    }

    Ok(())
}

fn collect_kasumi_lkm_artifacts(source_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut stack = vec![source_dir.to_path_buf()];
    let mut artifacts = Vec::new();

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension() == Some(OsStr::new("ko")) {
                artifacts.push(path);
            }
        }
    }

    artifacts.sort();
    Ok(artifacts)
}

fn env_truthy(name: &str) -> Option<bool> {
    let value = env::var(name).ok()?;
    let normalized = value.trim().to_ascii_lowercase();
    Some(!matches!(
        normalized.as_str(),
        "" | "0" | "false" | "no" | "off"
    ))
}

fn generate_module_prop(stage_dir: &Path, info: &VersionInfo) -> Result<()> {
    let config = load_cargo_config()?;

    let meta = config.package.metadata.hybrid_mount;
    let prop_content = build_meta_shared::render_module_prop(&build_meta_shared::ModulePropData {
        id: "hybrid_mount",
        name: &meta.name,
        version: &info.full_version,
        version_code: &info.version_code,
        author: "Hybrid Mount Developers",
        description: &config.package.description,
        update_json: &meta.update,
    });

    let prop_path = stage_dir.join("module.prop");
    let mut file = fs::File::create(prop_path)?;
    file.write_all(prop_content.as_bytes())?;

    Ok(())
}

fn build_webui(version: &str, is_release: bool) -> Result<()> {
    generate_webui_constants(version, is_release)?;
    let webui_dir = Path::new("webui");
    let pnpm = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };
    let status = Command::new(pnpm)
        .current_dir(webui_dir)
        .arg("install")
        .status()?;
    if !status.success() {
        anyhow::bail!("pnpm install failed");
    }
    let status = Command::new(pnpm)
        .current_dir(webui_dir)
        .args(["run", "build"])
        .status()?;
    if !status.success() {
        anyhow::bail!("pnpm run build failed");
    }
    Ok(())
}

fn generate_webui_constants(version: &str, is_release: bool) -> Result<()> {
    let path = Path::new("webui/src/lib/constants_gen.ts");
    let content = build_meta_shared::render_webui_constants(
        version,
        is_release,
        build_meta_shared::defs::CONFIG_FILE,
        build_meta_shared::defs::STATE_FILE,
        &format!(
            "{}/hybrid-mount",
            build_meta_shared::defs::HYBRID_MOUNT_MODULE_DIR
        ),
    );
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

fn compile_core(release: bool, arch: Arch) -> Result<()> {
    let mut cmd = Command::new("cargo");
    cmd.args([
        "+nightly",
        "ndk",
        "-Z",
        "build-std=std,core,panic_abort",
        "-Z",
        "build-std-features=optimize_for_size",
        "-Z",
        "trim-paths",
        "--platform",
        "26",
        "-t",
        arch.target(),
        "build",
    ])
    .env("RUSTFLAGS", "-C default-linker-libraries");
    if release {
        cmd.arg("-r");
    }
    let mut ret = cmd.spawn()?;
    let status = ret.wait()?;
    if !status.success() {
        anyhow::bail!("Compilation failed for {}", arch.target());
    }
    Ok(())
}

fn resolve_release_version(tag: &str) -> Result<VersionInfo> {
    let clean_version = tag.trim_start_matches('v');
    update_cargo_toml_version(clean_version)?;

    let commit_count = build_meta_shared::git_commit_count()?;
    let full_version = format!("{}-{}", clean_version, commit_count);
    let version_code = build_meta_shared::calculate_version_code(clean_version)?;

    Ok(VersionInfo {
        clean_version: clean_version.to_string(),
        full_version,
        version_code,
    })
}

fn resolve_local_or_ci_version() -> Result<VersionInfo> {
    let data = load_cargo_config()?;
    let clean_version = data.package.version;
    let commit_count = build_meta_shared::git_commit_count()?;

    let full_version = format!("{}-{}", clean_version, commit_count);
    let version_code = build_meta_shared::calculate_version_code(&clean_version)?;

    Ok(VersionInfo {
        clean_version,
        full_version,
        version_code,
    })
}

fn update_cargo_toml_version(version: &str) -> Result<()> {
    let content = fs::read_to_string("Cargo.toml")?;
    let mut new_lines = Vec::new();
    let mut replaced = false;

    for line in content.lines() {
        if !replaced && line.starts_with("version =") {
            new_lines.push(format!("version = \"{}\"", version));
            replaced = true;
        } else {
            new_lines.push(line.to_string());
        }
    }

    let mut file = fs::File::create("Cargo.toml")?;
    for line in new_lines {
        writeln!(file, "{}", line)?;
    }
    Ok(())
}
