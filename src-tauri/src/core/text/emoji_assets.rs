//! The bundled colour-emoji picture pack, and how a cluster finds its image.
//!
//! libass rasterizes outlines. It reads no `CBDT`, `COLR` or `SVG` table, so no
//! subtitle burn-in can ever put a colour emoji on the frame - the bundled Noto
//! Emoji face draws the right *picture*, in one colour, and that is the ceiling
//! of the text layer. Colour therefore has to arrive as a second layer: a PNG
//! composited over the burned-in text at the exact rectangle libass left for it.
//!
//! This module owns the first half of that - which file draws which sequence -
//! and knows nothing about measurement or filtergraphs.
//!
//! # Why a manifest rather than probing the directory
//!
//! The export has to decide *before* it writes the ASS script whether a cluster
//! gets a transparent spacer (colour overlay to follow) or the monochrome glyph
//! it has always had, because the two produce different scripts. A directory
//! probe answers that question one `stat` at a time, on the render thread, for
//! every emoji in the project. A manifest read once answers it from a map, and
//! makes "this pack does not carry that emoji" a plan-time fact the QC report
//! can name instead of a render-time surprise.
//!
//! # The resolution ladder
//!
//! A pack cannot carry every sequence Unicode defines, and it does not have to:
//! most misses have a *correct* less specific picture one step away. See
//! [`resolution_candidates`] for the four steps and what each one costs.
//!
//! # What is deliberately not here
//!
//! Rasterization. The pack ships pre-rasterized PNG, and FFmpeg's own `scale`
//! does the downscale to the size a caption needs, which is why this feature
//! adds no image-decoding dependency to the tree. [`EmojiRasterSource`] is the
//! seam an SVG-plus-`resvg` pack would replace later without any caller
//! learning that the pictures stopped being files on disk.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};

/// Environment variable naming the directory the emoji pack was unpacked to.
///
/// Highest priority, exactly like [`crate::core::ffmpeg::resolver::FFMPEG_PATH_ENV`]:
/// a distribution that lays the pack out somewhere this resolver would not
/// think to look has one thing to set, and a developer can point a build at a
/// pack they generated without moving it into the tree.
pub const EMOJI_PACK_DIR_ENV: &str = "OPENREELIO_EMOJI_PACK_DIR";

/// File the pack's index lives in, inside the pack directory.
pub const MANIFEST_FILE_NAME: &str = "manifest.json";

/// Directory the pictures live in, relative to the pack directory.
pub const IMAGE_DIR_NAME: &str = "png";

/// The `manifest.json` schema version this build understands.
///
/// A pack declaring anything else is refused rather than read optimistically:
/// a future version may re-key `entries`, and quietly drawing the wrong picture
/// is worse than drawing the monochrome glyph.
pub const SUPPORTED_MANIFEST_VERSION: u32 = 1;

/// Fitzpatrick skin-tone modifiers, as [`sequence_key`] spells them.
///
/// [`sequence_key`]: super::emoji::sequence_key
const SKIN_TONE_KEYS: [&str; 5] = ["1f3fb", "1f3fc", "1f3fd", "1f3fe", "1f3ff"];

/// Zero width joiner, as a sequence-key component.
const ZWJ_KEY: &str = "200d";

/// The variation selectors, as sequence-key components.
///
/// `fe0f` is already dropped by [`super::emoji::sequence_key`]; it is listed
/// here so a key assembled by some other caller is still normalized the same
/// way rather than silently missing the pack.
const VARIATION_SELECTOR_KEYS: [&str; 2] = ["fe0f", "fe0e"];

/// Which step of the ladder found a picture, worst-specificity last.
///
/// Carried out of the lookup so the caller can log the substitution and the QC
/// report can say the frame shows a *related* emoji rather than the one the
/// author typed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmojiAssetStep {
    /// The pack carries this exact sequence. Nothing was substituted.
    Exact,
    /// The skin-tone modifiers were dropped: the neutral form of the same
    /// emoji, which is the picture every pack draws for the unmodified
    /// sequence.
    SkinToneStripped,
    /// Everything from the first zero width joiner on was dropped: the first
    /// base emoji of a sequence the pack never shipped, so a "woman
    /// technologist" draws as "woman".
    ZwjBase,
    /// A variation selector was dropped. Cosmetic - it never changes which
    /// emoji a sequence is - and reachable only from a key some other caller
    /// assembled without normalizing.
    VariationStripped,
}

impl EmojiAssetStep {
    /// Identifier used in logs and QC metrics.
    pub fn as_str(self) -> &'static str {
        match self {
            EmojiAssetStep::Exact => "exact",
            EmojiAssetStep::SkinToneStripped => "skinToneStripped",
            EmojiAssetStep::ZwjBase => "zwjBase",
            EmojiAssetStep::VariationStripped => "variationStripped",
        }
    }

    /// Whether the picture found is the sequence the author actually wrote.
    pub fn is_exact(self) -> bool {
        matches!(self, EmojiAssetStep::Exact)
    }

    /// Whether the picture is still *this* emoji, so a burn-in may draw it.
    ///
    /// This is the line between "colour is a strict improvement" and "colour
    /// costs the reader the emoji". Dropping a skin tone or a variation
    /// selector leaves the same object, gesture and count on the frame - and
    /// the monochrome alternative could not have shown the tone either, so
    /// nothing is lost that was ever there. Dropping everything after a zero
    /// width joiner does not: a "woman technologist" becomes a "woman", where
    /// the bundled Noto Emoji face ligates the joined sequence correctly and
    /// draws the picture the project asked for in one colour.
    ///
    /// So [`EmojiAssetStep::ZwjBase`] stays in the ladder - it is the honest
    /// answer to "what is the closest thing this pack has" - and the burn-in
    /// declines to use it. That is what lets
    /// [`EmojiRenderCapability::ColorOverlay`] mean "right picture, in colour"
    /// with no class of emoji quietly excepted.
    ///
    /// [`EmojiRenderCapability::ColorOverlay`]: crate::core::qc::EmojiRenderCapability::ColorOverlay
    pub fn preserves_sequence(self) -> bool {
        !matches!(self, EmojiAssetStep::ZwjBase)
    }
}

/// A picture the pack will draw for some sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmojiAssetMatch {
    /// The image file, absolute.
    pub path: PathBuf,
    /// The key the pack was actually keyed on, which is the requested key only
    /// when [`step`](Self::step) is [`EmojiAssetStep::Exact`].
    pub key: String,
    /// How far down the ladder the lookup had to go.
    pub step: EmojiAssetStep,
}

/// Where colour emoji pictures come from.
///
/// One implementation today - [`EmojiPack`], a directory of PNG - and the trait
/// exists so the second one does not have to be a rewrite. An SVG pack rendered
/// through `resvg` would satisfy this by rasterizing into a scratch directory
/// and handing back the paths; nothing above this seam knows the difference,
/// because the filtergraph only ever sees a file and a size.
pub trait EmojiRasterSource: std::fmt::Debug + Send + Sync {
    /// The square edge, in pixels, the pack's own images are stored at.
    ///
    /// Advisory: the export scales to the size a caption needs regardless. It
    /// is here so a caller can warn when a render would upscale.
    fn pixel_size(&self) -> u32;

    /// The picture for `sequence_key`, walking the ladder, or `None`.
    fn lookup(&self, sequence_key: &str) -> Option<EmojiAssetMatch>;
}

/// The keys to try for `sequence_key`, most specific first.
///
/// Pure, and deliberately independent of any pack: the ladder is a property of
/// how emoji sequences degrade, not of what happens to be on disk, so it is
/// testable without a pack and identical on every machine.
///
/// The four steps, and what each one costs the frame:
///
/// 1. **Exact.** Nothing is lost.
/// 2. **Skin tone dropped.** `👍🏽` draws as `👍`. The gesture, the object and the
///    count are all right; the tone is not. Every pack that ships a base emoji
///    ships this, so it is the step that rescues the most sequences.
/// 3. **ZWJ base.** `👩‍💻` draws as `👩`. This is the lossiest step - a joined
///    sequence really is a different picture from its first member - and it is
///    still better than a monochrome tofu-adjacent fallback, because the
///    alternative is not "the right emoji" but "the same emoji in one colour".
/// 4. **Variation selector dropped.** Cosmetic; see
///    [`EmojiAssetStep::VariationStripped`].
///
/// Duplicates are removed while keeping the first occurrence, so a key that is
/// already neutral does not probe the same file four times, and an empty
/// candidate (a key made only of modifiers) is never produced.
pub fn resolution_candidates(sequence_key: &str) -> Vec<(String, EmojiAssetStep)> {
    let mut candidates: Vec<(String, EmojiAssetStep)> = Vec::with_capacity(4);
    let mut push = |key: String, step: EmojiAssetStep| {
        if key.is_empty() || candidates.iter().any(|(existing, _)| *existing == key) {
            return;
        }
        candidates.push((key, step));
    };

    let components: Vec<&str> = sequence_key.split('-').filter(|c| !c.is_empty()).collect();

    push(components.join("-"), EmojiAssetStep::Exact);

    let without_tones: Vec<&str> = components
        .iter()
        .copied()
        .filter(|component| !SKIN_TONE_KEYS.contains(component))
        .collect();
    push(without_tones.join("-"), EmojiAssetStep::SkinToneStripped);

    let base: Vec<&str> = without_tones
        .iter()
        .copied()
        .take_while(|component| *component != ZWJ_KEY)
        .collect();
    push(base.join("-"), EmojiAssetStep::ZwjBase);

    // Derived from `without_tones`, not from `base`. `base` has already had
    // everything from the first zero width joiner cut off it, so stripping a
    // selector from *that* produces a key that is a ZWJ base wearing a
    // `VariationStripped` label - and `preserves_sequence` lets that label
    // through. A pack carrying `1f3f3` would then draw a plain white flag for
    // `1f3f3-fe0f-200d-1f308`, the rainbow flag, in colour, having refused the
    // monochrome face that ligates it correctly. Every rung has to describe
    // what was actually dropped to reach it.
    let without_selectors: Vec<&str> = without_tones
        .iter()
        .copied()
        .filter(|component| !VARIATION_SELECTOR_KEYS.contains(component))
        .collect();
    push(
        without_selectors.join("-"),
        EmojiAssetStep::VariationStripped,
    );

    candidates
}

/// A directory of pre-rasterized PNG, indexed by `manifest.json`.
#[derive(Debug)]
pub struct EmojiPack {
    /// Directory holding `manifest.json` and `png/`.
    root: PathBuf,
    /// Square edge the images are stored at.
    pixel_size: u32,
    /// `sequence_key` to file name inside `png/`.
    entries: HashMap<String, String>,
}

impl EmojiPack {
    /// Reads the pack rooted at `root`, or explains why it cannot be used.
    ///
    /// Nothing here touches the image files: the manifest is the index, and a
    /// `stat` per entry would turn startup into thousands of syscalls for an
    /// answer the generator already asserted.
    pub fn load(root: &Path) -> Result<Self, String> {
        let manifest_path = root.join(MANIFEST_FILE_NAME);
        let bytes = std::fs::read(&manifest_path)
            .map_err(|error| format!("{}: {error}", manifest_path.display()))?;
        let manifest: EmojiPackManifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("{}: {error}", manifest_path.display()))?;

        if manifest.version != SUPPORTED_MANIFEST_VERSION {
            return Err(format!(
                "{} declares manifest version {}, but this build understands {}",
                manifest_path.display(),
                manifest.version,
                SUPPORTED_MANIFEST_VERSION
            ));
        }

        if manifest.entries.is_empty() {
            return Err(format!("{} carries no entries", manifest_path.display()));
        }

        Ok(Self {
            root: root.to_path_buf(),
            pixel_size: manifest.pixel_size,
            entries: manifest.entries,
        })
    }

    /// How many sequences the pack carries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the pack carries nothing. Never true for a loaded pack.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The directory the pack was read from.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl EmojiRasterSource for EmojiPack {
    fn pixel_size(&self) -> u32 {
        self.pixel_size
    }

    fn lookup(&self, sequence_key: &str) -> Option<EmojiAssetMatch> {
        for (key, step) in resolution_candidates(sequence_key) {
            if let Some(file_name) = self.entries.get(&key) {
                return Some(EmojiAssetMatch {
                    path: self.root.join(IMAGE_DIR_NAME).join(file_name),
                    key,
                    step,
                });
            }
        }

        None
    }
}

/// `manifest.json` as it is written by `scripts/generate-emoji-pack.mjs`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmojiPackManifest {
    version: u32,
    pixel_size: u32,
    entries: HashMap<String, String>,
}

/// A directory the host has told us to read the pack from.
///
/// The GUI registers Tauri's resource directory here at startup; the CLI has no
/// resource resolver and falls through to the executable-relative candidates
/// below. Mirrors [`crate::core::ffmpeg::resolver::set_resolved_paths`] rather
/// than inventing a second registration idiom.
static REGISTERED_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn registered_root() -> &'static RwLock<Option<PathBuf>> {
    REGISTERED_ROOT.get_or_init(|| RwLock::new(None))
}

/// Publishes the directory the pack was installed to, process-wide.
///
/// Has to be called before the first [`discover`], which caches its answer for
/// the life of the process - the host registers it at startup, long before any
/// render. A test wanting a different pack builds one with [`EmojiPack::load`]
/// or sets [`EMOJI_PACK_DIR_ENV`] rather than racing this.
pub fn set_emoji_pack_dir(root: PathBuf) {
    if let Ok(mut slot) = registered_root().write() {
        *slot = Some(root);
    }
}

/// The pack this process should use, or `None` when none is installed.
///
/// Resolved once. A miss is cached exactly like a hit: a build with no pack
/// must not pay a directory walk per caption, and the answer cannot change
/// under a running render.
pub fn discover() -> Option<&'static EmojiPack> {
    DISCOVERED
        .get_or_init(|| {
            let mut attempted: Vec<String> = Vec::new();

            for root in candidate_roots() {
                if !root.join(MANIFEST_FILE_NAME).is_file() {
                    attempted.push(root.display().to_string());
                    continue;
                }

                match EmojiPack::load(&root) {
                    Ok(pack) => {
                        tracing::info!(
                            "Colour emoji pack loaded from {} ({} sequences at {}px)",
                            root.display(),
                            pack.len(),
                            pack.pixel_size()
                        );
                        return Some(pack);
                    }
                    Err(error) => {
                        tracing::warn!("Ignoring unreadable colour emoji pack: {error}");
                        attempted.push(root.display().to_string());
                    }
                }
            }

            tracing::debug!(
                "No colour emoji pack found; captions keep the bundled monochrome face. Looked in: {}",
                attempted.join(", ")
            );
            None
        })
        .as_ref()
}

/// Cached answer to [`discover`], including the negative one.
static DISCOVERED: OnceLock<Option<EmojiPack>> = OnceLock::new();

/// The picture a burn-in may actually composite for `sequence_key`.
///
/// [`EmojiRasterSource::lookup`] answers "what is the nearest thing in this
/// pack"; this answers "may the render use it", which is the narrower question
/// and the only one the burn-in and the QC rule are allowed to disagree about -
/// so they both come through here. See [`EmojiAssetStep::preserves_sequence`].
pub fn drawable_match(pack: &dyn EmojiRasterSource, sequence_key: &str) -> Option<EmojiAssetMatch> {
    pack.lookup(sequence_key)
        .filter(|found| found.step.preserves_sequence())
}

/// Whether the installed pack can draw `sequence_key` in colour.
///
/// The question QC asks, and the reason it is a free function: a structural
/// rule must not have to own a pack handle to answer it.
pub fn color_asset_available(sequence_key: &str) -> bool {
    discover().is_some_and(|pack| drawable_match(pack, sequence_key).is_some())
}

/// Every directory the pack may live in, in priority order.
///
/// Mirrors the FFmpeg binary ladder deliberately: an explicit environment
/// override, then what the host registered, then the executable's own
/// directory in each of the layouts the installers produce, then the checkout.
///
/// # Why the working directory is not here
///
/// The CLI is routinely launched as an MCP server with an agent's project
/// directory as its working directory, so that directory is untrusted. It is a
/// weaker boundary than the FFmpeg one - a PNG is decoded, not executed - but
/// letting a checked-out repository silently change what a render draws is not
/// a property worth having either.
fn candidate_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |root: PathBuf| {
        if !roots.contains(&root) {
            roots.push(root);
        }
    };

    if let Some(from_env) = std::env::var_os(EMOJI_PACK_DIR_ENV) {
        if !from_env.is_empty() {
            push(PathBuf::from(from_env));
        }
    }

    if let Some(registered) = registered_root().read().ok().and_then(|slot| slot.clone()) {
        push(registered.join("emoji"));
        push(registered);
    }

    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
    {
        // Windows and Linux installers lay resources out beside the binary; the
        // macOS bundle puts them one level up in `Resources`. `cargo test` and
        // `cargo run` land on the first form through the `build.rs` copy.
        push(exe_dir.join("emoji"));
        // The npm platform packages put the binary in `bin/` and the pack
        // beside it, so the CLI installed with `npm i openreelio-cli` finds
        // the pack one level up. The GUI-bundled CLI on Linux reaches its
        // resource copy the same way when the sidecar sits in a `bin/`.
        push(exe_dir.join("../emoji"));
        push(exe_dir.join("../Resources/emoji"));
        push(exe_dir.join("../lib/openreelio/emoji"));
    }

    // The checkout, so a developer build and the test suite find the pack that
    // is committed next to the source without any install step.
    push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("emoji"));

    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exact_key_is_the_first_candidate() {
        let candidates = resolution_candidates("1f600");

        assert_eq!(
            candidates.first().map(|(key, _)| key.as_str()),
            Some("1f600")
        );
        assert_eq!(
            candidates.first().map(|(_, step)| *step),
            Some(EmojiAssetStep::Exact)
        );
    }

    #[test]
    fn a_skin_toned_emoji_falls_back_to_its_neutral_form() {
        let candidates = resolution_candidates("1f44d-1f3fd");

        assert_eq!(
            candidates,
            vec![
                ("1f44d-1f3fd".to_string(), EmojiAssetStep::Exact),
                ("1f44d".to_string(), EmojiAssetStep::SkinToneStripped),
            ]
        );
    }

    #[test]
    fn a_toned_zwj_sequence_drops_the_tone_before_it_drops_the_join() {
        let candidates = resolution_candidates("1f469-1f3fd-200d-1f4bb");

        assert_eq!(
            candidates,
            vec![
                ("1f469-1f3fd-200d-1f4bb".to_string(), EmojiAssetStep::Exact),
                (
                    "1f469-200d-1f4bb".to_string(),
                    EmojiAssetStep::SkinToneStripped
                ),
                ("1f469".to_string(), EmojiAssetStep::ZwjBase),
            ]
        );
    }

    /// Feature: colour emoji resolution
    /// Scenario: a joined sequence never degrades to its base under a
    /// selector-stripped label
    ///
    /// The rainbow flag is `1f3f3-fe0f-200d-1f308`. Dropping the selector
    /// leaves the joined sequence; dropping the join leaves a plain white
    /// flag, which is a different picture and which
    /// [`EmojiAssetStep::preserves_sequence`] exists to keep a burn-in away
    /// from. Deriving the selector rung from an already-truncated key labelled
    /// that white flag `VariationStripped` and let it straight through.
    #[test]
    fn stripping_a_selector_never_relabels_a_zwj_base() {
        let candidates = resolution_candidates("1f3f3-fe0f-200d-1f308");

        assert_eq!(
            candidates,
            vec![
                ("1f3f3-fe0f-200d-1f308".to_string(), EmojiAssetStep::Exact),
                ("1f3f3-fe0f".to_string(), EmojiAssetStep::ZwjBase),
                (
                    "1f3f3-200d-1f308".to_string(),
                    EmojiAssetStep::VariationStripped
                ),
            ]
        );
        assert!(
            candidates
                .iter()
                .all(|(key, step)| key != "1f3f3" || !step.preserves_sequence()),
            "the bare flag is not this emoji, whatever rung it is found on"
        );
    }

    #[test]
    fn a_variation_selector_is_dropped_last() {
        let candidates = resolution_candidates("2764-fe0f");

        assert_eq!(
            candidates,
            vec![
                ("2764-fe0f".to_string(), EmojiAssetStep::Exact),
                ("2764".to_string(), EmojiAssetStep::VariationStripped),
            ]
        );
    }

    #[test]
    fn a_key_made_only_of_modifiers_produces_no_empty_candidate() {
        let candidates = resolution_candidates("1f3fd");

        assert!(candidates.iter().all(|(key, _)| !key.is_empty()));
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn a_keycap_is_never_degraded_past_itself() {
        // No skin tone, no ZWJ, no selector left after `sequence_key` ran, so
        // the ladder has exactly one rung and a pack without keycaps reports a
        // clean miss instead of drawing a bare digit.
        assert_eq!(
            resolution_candidates("31-20e3"),
            vec![("31-20e3".to_string(), EmojiAssetStep::Exact)]
        );
    }

    /// Feature: colour emoji distribution
    /// Scenario: the resolver looks in every layout a build is installed as
    ///
    /// The pack is a directory beside the binary, and "beside" means something
    /// different in each layout the CLI ships in: the standalone archive and
    /// the Windows installer put it next to the executable, an npm platform
    /// package puts the executable in `bin/` and the pack at the package root,
    /// the macOS bundle keeps resources in `Contents/Resources`, and a Linux
    /// package splits `bin` from `lib`. Missing a rung is not a crash - it is
    /// a CLI that quietly renders every emoji in monochrome while the desktop
    /// app renders the same project in colour.
    #[test]
    fn the_resolver_looks_beside_the_binary_in_every_installed_layout() {
        let roots = candidate_roots();
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(PathBuf::from))
            .expect("a test binary has a directory");

        for expected in [
            exe_dir.join("emoji"),
            exe_dir.join("../emoji"),
            exe_dir.join("../Resources/emoji"),
            exe_dir.join("../lib/openreelio/emoji"),
        ] {
            assert!(
                roots.contains(&expected),
                "{} is not searched; roots were {roots:?}",
                expected.display()
            );
        }

        // And the checkout, which is how `cargo test` and `cargo run` find the
        // pack with no install step at all.
        assert!(roots.contains(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("emoji")));
    }

    #[test]
    fn a_pack_resolves_through_the_ladder_and_reports_the_step() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join(MANIFEST_FILE_NAME),
            r#"{"version":1,"pixelSize":128,"entries":{"1f44d":"1f44d.png"}}"#,
        )
        .expect("write manifest");

        let pack = EmojiPack::load(dir.path()).expect("pack loads");
        let found = pack.lookup("1f44d-1f3fd").expect("neutral form found");

        assert_eq!(found.key, "1f44d");
        assert_eq!(found.step, EmojiAssetStep::SkinToneStripped);
        assert_eq!(
            found.path,
            dir.path().join(IMAGE_DIR_NAME).join("1f44d.png")
        );
        assert_eq!(pack.pixel_size(), 128);
    }

    #[test]
    fn a_burn_in_declines_the_first_member_of_a_zwj_sequence() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join(MANIFEST_FILE_NAME),
            r#"{"version":1,"pixelSize":128,"entries":{"1f469":"1f469.png"}}"#,
        )
        .expect("write manifest");

        let pack = EmojiPack::load(dir.path()).expect("pack loads");

        // The ladder still finds it, because "the nearest thing in this pack"
        // is a real answer...
        assert_eq!(
            pack.lookup("1f469-200d-1f4bb").map(|found| found.step),
            Some(EmojiAssetStep::ZwjBase)
        );
        // ...and the burn-in still refuses it, because the bundled monochrome
        // face draws the joined sequence correctly and this would not.
        assert!(drawable_match(&pack, "1f469-200d-1f4bb").is_none());
    }

    #[test]
    fn a_burn_in_accepts_a_neutral_form_for_a_skin_toned_emoji() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join(MANIFEST_FILE_NAME),
            r#"{"version":1,"pixelSize":128,"entries":{"1f44d":"1f44d.png"}}"#,
        )
        .expect("write manifest");

        let pack = EmojiPack::load(dir.path()).expect("pack loads");

        assert_eq!(
            drawable_match(&pack, "1f44d-1f3fd").map(|found| found.step),
            Some(EmojiAssetStep::SkinToneStripped)
        );
    }

    #[test]
    fn a_sequence_the_pack_never_shipped_reports_a_miss() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join(MANIFEST_FILE_NAME),
            r#"{"version":1,"pixelSize":128,"entries":{"1f44d":"1f44d.png"}}"#,
        )
        .expect("write manifest");

        let pack = EmojiPack::load(dir.path()).expect("pack loads");

        assert!(pack.lookup("1f1f0-1f1f7").is_none());
    }

    #[test]
    fn a_manifest_from_a_future_schema_is_refused_rather_than_guessed_at() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join(MANIFEST_FILE_NAME),
            r#"{"version":99,"pixelSize":128,"entries":{"1f44d":"1f44d.png"}}"#,
        )
        .expect("write manifest");

        assert!(EmojiPack::load(dir.path()).is_err());
    }
}
