use std::{fs, io::Write};

use anyhow::Result;

#[path = "xtask/src/build_meta_shared.rs"]
mod build_meta_shared;

fn load_cargo_config() -> Result<build_meta_shared::CargoConfig> {
    let toml = fs::read_to_string("Cargo.toml")?;
    Ok(toml::from_str(&toml)?)
}

fn main() -> Result<()> {
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=.git");
    println!("cargo:rerun-if-changed=xtask/src/build_meta_shared.rs");
    println!("cargo:rerun-if-changed=src/defs.rs");

    let data = load_cargo_config()?;

    gen_module_prop(&data)?;

    Ok(())
}

fn gen_module_prop(data: &build_meta_shared::CargoConfig) -> Result<()> {
    let package = &data.package;
    let id = package.name.replace('-', "_");
    let version_code = build_meta_shared::calculate_version_code(&package.version)?;
    let author = package.authors.join(" & ");
    let version = format!(
        "{}-{}",
        package.version,
        build_meta_shared::git_commit_count()?
    );
    let rendered_version = format!("v{}", version.trim());
    let content = build_meta_shared::render_module_prop(&build_meta_shared::ModulePropData {
        id: &id,
        name: &package.metadata.hybrid_mount.name,
        version: &rendered_version,
        version_code: &version_code,
        author: &author,
        description: &package.description,
        update_json: &package.metadata.hybrid_mount.update,
    });

    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open("module/module.prop")?;

    file.write_all(content.as_bytes())?;
    Ok(())
}
