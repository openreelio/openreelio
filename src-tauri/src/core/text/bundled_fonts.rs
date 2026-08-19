//! Fonts compiled into the binary so text burn-in never depends on the host.
//!
//! Export renders text through libass, which silently substitutes a fallback
//! face when the requested family is missing. On a machine without the family
//! the caption still renders, just in the wrong typeface, and nothing in the
//! output says so. Compiling a curated set in removes that failure mode for the
//! families the caption presets actually use.
//!
//! The bytes are embedded rather than shipped as resources because both
//! consumers need them: the Tauri app has a resource resolver, the
//! npm-distributed CLI does not.
//!
//! Every face here has to be reachable by the name the ASS `Style` line puts in
//! its `Fontname` column, and libass is strict about where that name may live:
//! it matches `name` ID 1 (family) and `name` ID 4 (full name) and nothing
//! else, and it reads boldness from the `OS/2` `fsSelection` and `head`
//! `macStyle` bits rather than from the subfamily string. Two of the families
//! ship upstream only as variable fonts, whose default instancing leaves the
//! family in `name` ID 16 - which looks right and is invisible to libass. The
//! statics under `src-tauri/fonts/` are therefore rebuilt by
//! `scripts/instance-bundled-fonts.py`, which pins the design location and then
//! rewrites exactly those fields. `bundled_faces_are_reachable_by_the_family_
//! name_the_emitter_writes` is the guard that keeps them that way.
//!
//! Every family here is licensed under the SIL Open Font License 1.1, except
//! Luckiest Guy which is Apache-2.0. See `THIRD_PARTY_NOTICES.md` at the
//! repository root for the copyright notices and full license texts.

use std::{collections::HashMap, sync::OnceLock};

/// A font compiled into the binary.
#[derive(Clone, Copy, Debug)]
pub struct BundledFont {
    /// Family name as an editor or caption preset refers to it.
    pub family: &'static str,
    /// Name used for the font inside an ASS `[Fonts]` section.
    pub file_name: &'static str,
    /// The font file itself.
    pub bytes: &'static [u8],
}

/// Family substituted for a request that resolves to no font at all.
///
/// Picking one explicitly keeps the output deterministic: libass would
/// otherwise fall back to whatever the host font provider ranks first.
pub const DEFAULT_BUNDLED_FAMILY: &str = "TikTok Sans";

macro_rules! bundled_font {
    ($family:literal, $file:literal, $path:literal) => {
        BundledFont {
            family: $family,
            file_name: $file,
            bytes: include_bytes!(concat!("../../../fonts/", $path)),
        }
    };
}

/// Fonts compiled into the binary, in a stable order.
///
/// The order is load-bearing: the embed size guard drops fonts from the tail
/// once the cap is reached, so a script that exceeds the cap still embeds the
/// same fonts on every machine.
static BUNDLED_FONTS: &[BundledFont] = &[
    bundled_font!(
        "TikTok Sans",
        "TikTokSans-Regular",
        "tiktok-sans/TikTokSans-Regular.ttf"
    ),
    bundled_font!(
        "TikTok Sans",
        "TikTokSans-Bold",
        "tiktok-sans/TikTokSans-Bold.ttf"
    ),
    bundled_font!(
        "Montserrat",
        "Montserrat-Regular",
        "montserrat/Montserrat-Regular.ttf"
    ),
    bundled_font!(
        "Montserrat",
        "Montserrat-Bold",
        "montserrat/Montserrat-Bold.ttf"
    ),
    bundled_font!("Anton", "Anton-Regular", "anton/Anton-Regular.ttf"),
    bundled_font!(
        "Archivo Black",
        "ArchivoBlack-Regular",
        "archivo-black/ArchivoBlack-Regular.ttf"
    ),
    bundled_font!(
        "Bebas Neue",
        "BebasNeue-Regular",
        "bebas-neue/BebasNeue-Regular.ttf"
    ),
    bundled_font!("Poppins", "Poppins-Regular", "poppins/Poppins-Regular.ttf"),
    bundled_font!("Poppins", "Poppins-Bold", "poppins/Poppins-Bold.ttf"),
    bundled_font!("Bangers", "Bangers-Regular", "bangers/Bangers-Regular.ttf"),
    bundled_font!(
        "Luckiest Guy",
        "LuckiestGuy-Regular",
        "luckiest-guy/LuckiestGuy-Regular.ttf"
    ),
];

/// Lookup key for a family name.
///
/// Editors, caption presets and imported projects disagree about casing and
/// spacing ("Bebas Neue", "bebasneue", "BEBAS  NEUE"), so the key drops both.
fn lookup_key(family: &str) -> String {
    family
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Every name a bundled font answers to, mapped to its index in
/// [`BUNDLED_FONTS`].
///
/// Seeded from the declared family names, then widened with the family names in
/// each font's own `name` table, so a project that stored a typographic family
/// name ("Archivo Black Regular") still resolves.
fn lookup_table() -> &'static HashMap<String, usize> {
    static TABLE: OnceLock<HashMap<String, usize>> = OnceLock::new();

    TABLE.get_or_init(|| {
        let mut table = HashMap::new();

        for (index, font) in BUNDLED_FONTS.iter().enumerate() {
            // The declared family wins over a name-table alias, and the first
            // font of a family wins over later weights, so "Poppins" resolves
            // to Poppins Regular rather than Poppins Bold.
            table.entry(lookup_key(font.family)).or_insert(index);
        }

        for (index, font) in BUNDLED_FONTS.iter().enumerate() {
            for family in super::fonts::font_family_names(font.bytes) {
                table.entry(lookup_key(&family)).or_insert(index);
            }
        }

        table
    })
}

/// Returns the bundled font a family name resolves to, if any.
pub fn resolve_bundled(family: &str) -> Option<&'static BundledFont> {
    let trimmed = family.trim();
    if trimmed.is_empty() {
        return None;
    }

    lookup_table()
        .get(&lookup_key(trimmed))
        .map(|index| &BUNDLED_FONTS[*index])
}

/// Returns every bundled font whose declared family matches `family`.
///
/// A family ships as several weights and libass picks between them, so an ASS
/// script has to embed all of them rather than just the one `resolve_bundled`
/// returns.
pub fn bundled_family_faces(family: &str) -> Vec<&'static BundledFont> {
    let Some(resolved) = resolve_bundled(family) else {
        return Vec::new();
    };

    BUNDLED_FONTS
        .iter()
        .filter(|font| font.family == resolved.family)
        .collect()
}

/// Returns the distinct family names compiled into the binary.
pub fn bundled_font_families() -> Vec<&'static str> {
    let mut families: Vec<&'static str> = Vec::new();

    for font in BUNDLED_FONTS {
        if !families.contains(&font.family) {
            families.push(font.family);
        }
    }

    families
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_font_carries_bytes_that_parse_as_a_font() {
        for font in BUNDLED_FONTS {
            assert!(
                font.bytes.len() > 1024,
                "{} looks truncated at {} bytes",
                font.file_name,
                font.bytes.len()
            );
            assert!(
                !super::super::fonts::font_family_names(font.bytes).is_empty(),
                "{} has no readable family name",
                font.file_name
            );
        }
    }

    #[test]
    fn resolve_bundled_ignores_case_and_spacing() {
        for family in bundled_font_families() {
            assert!(
                resolve_bundled(family).is_some(),
                "declared family {family} must resolve"
            );
        }

        let spaced = resolve_bundled("  bebas   neue ").expect("spacing-insensitive lookup");
        assert_eq!(spaced.family, "Bebas Neue");
        assert_eq!(
            resolve_bundled("BEBASNEUE").map(|font| font.family),
            Some("Bebas Neue")
        );
    }

    #[test]
    fn resolve_bundled_prefers_the_regular_weight_of_a_family() {
        assert_eq!(
            resolve_bundled("Poppins").map(|font| font.file_name),
            Some("Poppins-Regular")
        );
        assert_eq!(
            resolve_bundled("Montserrat").map(|font| font.file_name),
            Some("Montserrat-Regular")
        );
    }

    #[test]
    fn resolve_bundled_rejects_families_that_are_not_compiled_in() {
        assert!(resolve_bundled("Comic Sans MS").is_none());
        assert!(resolve_bundled("").is_none());
        assert!(resolve_bundled("   ").is_none());
    }

    #[test]
    fn bundled_family_faces_returns_every_weight_of_a_family() {
        let faces: Vec<&str> = bundled_family_faces("Poppins")
            .iter()
            .map(|font| font.file_name)
            .collect();
        assert_eq!(faces, vec!["Poppins-Regular", "Poppins-Bold"]);

        assert_eq!(bundled_family_faces("Anton").len(), 1);
        assert!(bundled_family_faces("Comic Sans MS").is_empty());
    }

    #[test]
    fn the_substitution_default_is_itself_bundled() {
        assert!(resolve_bundled(DEFAULT_BUNDLED_FAMILY).is_some());
    }

    #[test]
    fn bundled_faces_are_reachable_by_the_family_name_the_emitter_writes() {
        // The ASS `Style` line names `BundledFont::family`, and libass resolves
        // that string against `name` ID 1 and `name` ID 4 only. A face whose
        // family lives in `name` ID 16 - which is what an unedited variable-font
        // instancing run produces - renders in a host fallback while every
        // structural check still passes.
        for font in BUNDLED_FONTS {
            let info = super::super::fonts::font_face_info(font.bytes);

            assert!(
                info.matches_family(font.family),
                "{} declares family {:?} but answers only to ID 1 {:?} / ID 4 {:?} (ID 16 {:?} is invisible to libass)",
                font.file_name,
                font.family,
                info.family_names,
                info.full_names,
                info.typographic_family_names,
            );
        }
    }

    #[test]
    fn bundled_bold_faces_declare_their_weight_where_libass_reads_it() {
        // libass picks between the weights of a family by the bold bits and
        // `usWeightClass`, not by the subfamily string, so a bold face with the
        // bits unset can never win a `\b700` and the family renders faux-bold
        // off the regular outlines instead.
        for font in BUNDLED_FONTS {
            let info = super::super::fonts::font_face_info(font.bytes);
            let is_bold_face = font.file_name.ends_with("-Bold");

            assert_eq!(
                info.declares_bold(),
                is_bold_face,
                "{} must {} the OS/2 and head bold bits, got fsSelection={} macStyle={}",
                font.file_name,
                if is_bold_face { "set" } else { "clear" },
                info.fs_selection_bold,
                info.mac_style_bold,
            );
            assert_eq!(
                info.weight_class,
                Some(if is_bold_face { 700 } else { 400 }),
                "{} must declare the weight class its file name promises",
                font.file_name,
            );
        }
    }

    #[test]
    fn variable_font_instances_are_shipped_at_a_readable_weight() {
        // The upstream variable files default to their lightest instance
        // (Montserrat Thin, TikTok Sans Light). Shipping those verbatim would
        // burn hairline captions in, so the compiled bytes must be the static
        // instances instead.
        for family in ["TikTok Sans", "Montserrat"] {
            for font in bundled_family_faces(family) {
                let names = super::super::fonts::font_family_names(font.bytes);
                assert!(
                    !names.iter().any(|name| name.contains("Thin")
                        || name.contains("Light")
                        || name.contains("Variable")),
                    "{} must not ship a light or variable instance, got {names:?}",
                    font.file_name
                );
            }
        }
    }
}
