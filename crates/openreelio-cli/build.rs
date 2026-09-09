//! Puts the bundled colour emoji pack where the CLI binary can find it.
//!
//! The GUI ships the pack as a Tauri resource and registers the resource
//! directory at startup. The CLI has no resource resolver: it is distributed as
//! a bare executable through npm, and its pack has to sit next to the binary,
//! which is exactly the layout `core::text::emoji_assets` looks for.
//!
//! The pack is *not* compiled into the binary. It is several megabytes of PNG
//! that every emoji-free render would otherwise pay for in resident memory and
//! in link time, and a directory of files is what the packager needs to stage
//! anyway.
//!
//! Nothing here fails a build. A checkout with no pack generated yet, or a
//! target directory that cannot be written to, leaves the CLI rendering the
//! monochrome emoji it rendered before the pack existed.

use std::{
    fs,
    path::{Path, PathBuf},
};

/// Pack directory in the checkout, relative to this crate.
const PACK_SOURCE: &str = "../../src-tauri/emoji";

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source = manifest_dir.join(PACK_SOURCE);

    println!(
        "cargo:rerun-if-changed={}",
        source.join("manifest.json").display()
    );

    if !source.join("manifest.json").is_file() {
        println!(
            "cargo:warning=No colour emoji pack at {}; the CLI will render emoji in monochrome",
            source.display()
        );
        return;
    }

    let Some(destination) = profile_dir().map(|dir| dir.join("emoji")) else {
        return;
    };

    if let Err(error) = stage_pack(&source, &destination) {
        println!(
            "cargo:warning=Could not stage the colour emoji pack into {}: {error}",
            destination.display()
        );
    }
}

/// The directory the built binary lands in, derived from `OUT_DIR`.
///
/// `OUT_DIR` is `<target>/<profile>/build/<crate>-<hash>/out`, so the profile
/// directory - where Cargo puts the executable - is four levels up. Cargo
/// exposes no variable for it, and this is the derivation the ecosystem uses.
fn profile_dir() -> Option<PathBuf> {
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR")?);
    out_dir.ancestors().nth(3).map(std::path::Path::to_path_buf)
}

/// Copies the pack, skipping the work when the staged copy is already current.
fn stage_pack(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source_manifest = fs::read(source.join("manifest.json"))?;
    let destination_manifest = destination.join("manifest.json");

    // The manifest names every file in the pack, so an identical manifest means
    // an identical pack. Without this, a fifteen-hundred-file copy would run on
    // every incremental build of the CLI.
    if fs::read(&destination_manifest).is_ok_and(|existing| existing == source_manifest) {
        return Ok(());
    }

    fs::create_dir_all(destination.join("png"))?;

    // The manifest is written last, and that ordering is the whole atomicity
    // story here. The freshness check above reads the destination manifest and
    // concludes the pack is complete; if the manifest landed first and the copy
    // then failed - a full disk, an interrupted build, a locked file - every
    // later build would read a complete manifest over a half-copied `png/` and
    // skip the repair. The resolver would load a pack whose entries point at
    // files that are not there, and the export would hand FFmpeg a missing
    // input. With the manifest last, an interrupted stage leaves no manifest,
    // the pack does not load at all, and the next build copies it again.
    for entry in fs::read_dir(source.join("png"))? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            fs::copy(
                entry.path(),
                destination.join("png").join(entry.file_name()),
            )?;
        }
    }

    let license = source.join("LICENSE");
    if license.is_file() {
        fs::copy(license, destination.join("LICENSE"))?;
    }

    fs::copy(
        source.join("manifest.json"),
        destination.join("manifest.json"),
    )?;

    Ok(())
}
