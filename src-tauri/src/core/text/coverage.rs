//! Which characters a bundled face can actually draw.
//!
//! libass never reports a missing glyph: a face that has no outline for a
//! character draws a notdef box, or nothing at all, and every structural check
//! downstream still passes. Answering "can this face draw this character?"
//! before the burn-in runs is what lets a caller pick a different face instead
//! of shipping a row of boxes.
//!
//! The answer comes from the face's own `cmap`, read once per face and kept as
//! a sorted list of inclusive codepoint ranges. Ranges rather than a
//! `HashSet<char>` because `cmap` coverage is overwhelmingly contiguous: a
//! Latin face collapses to a few hundred ranges, and a CJK face that maps tens
//! of thousands of codepoints collapses just as hard, where a set would hold an
//! entry - and a hash - for every one of them. A binary search over a few
//! hundred pairs costs less than the hash it replaces.
//!
//! # What this module does not answer
//!
//! [`face_covers`] reports *per-codepoint* `cmap` coverage and nothing more. It
//! does not say whether an emoji grapheme will actually render: a ZWJ sequence,
//! a skin-tone modifier, or a VS16 presentation selector is a cluster of
//! several codepoints whose appearance depends on cluster decomposition and on
//! the variation and substitution lookups (`GSUB`, `cmap` format 14) that this
//! primitive deliberately does not read. A face can cover every codepoint of a
//! ZWJ family and still draw four separate people. Callers reasoning about
//! emoji must treat a `true` here as necessary, never sufficient.

use std::{cmp::Ordering, collections::HashMap, sync::OnceLock};

use ttf_parser::Face;

use super::bundled_fonts::{bundled_faces, BundledFont};

/// Inclusive codepoint ranges a face covers, sorted and disjoint.
type CoverageRanges = Box<[(u32, u32)]>;

/// Identity of the font bytes a cached coverage list was built from.
///
/// Address and length together, rather than [`BundledFont::file_name`]: a
/// `BundledFont` assembled outside the registry may carry any file name it
/// likes, and keying on the name would hand it another font's coverage. Only
/// the compiled-in faces are ever cached, and their bytes live in the binary's
/// read-only data for the life of the process, so no later allocation can take
/// an entry's address back and collide with it.
type FaceKey = (usize, usize);

/// True if `font`'s cmap maps `ch` to a real glyph.
///
/// Answers a single codepoint. It does not answer whether an emoji grapheme -
/// a ZWJ sequence, a skin-tone modifier, a VS16 presentation - renders as one
/// glyph; see the module documentation.
pub fn face_covers(font: &BundledFont, ch: char) -> bool {
    if let Some(ranges) = coverage_cache().get(&face_key(font.bytes)) {
        return ranges_contain(ranges, u32::from(ch));
    }

    // A face assembled outside the registry has no cached ranges. Ask its own
    // cmap rather than reporting that it covers nothing.
    Face::parse(font.bytes, 0).is_ok_and(|face| face.glyph_index(ch).is_some())
}

/// Returns the cache key identifying a face's bytes.
fn face_key(bytes: &[u8]) -> FaceKey {
    (bytes.as_ptr() as usize, bytes.len())
}

/// Returns the coverage of every compiled-in face, keyed by its bytes.
///
/// Built on first use and never rebuilt, so every later question is a hash
/// lookup and a binary search rather than another `cmap` walk.
fn coverage_cache() -> &'static HashMap<FaceKey, CoverageRanges> {
    static CACHE: OnceLock<HashMap<FaceKey, CoverageRanges>> = OnceLock::new();

    CACHE.get_or_init(|| {
        bundled_faces()
            .iter()
            .map(|font| (face_key(font.bytes), face_coverage(font.bytes)))
            .collect()
    })
}

/// Reads the codepoints an in-memory font maps to a glyph.
///
/// A face or `cmap` that will not parse yields empty coverage, which is the
/// fail-safe answer: every caller then reads "cannot draw this" and picks
/// another face rather than shipping a row of notdef boxes.
///
/// # Trust invariant
///
/// Only ever called on the compiled-in font bytes, which ship inside the
/// binary and are therefore trusted. That is what makes the walk below safe:
/// a `cmap` format 12 group enumerates `start..=end` with no bound, so a
/// hostile font could declare a handful of groups spanning billions of
/// codepoints and stall the process. If this is ever widened to system-
/// installed or user-supplied fonts, bound the per-group iteration (and the
/// total codepoint count) before reading them.
fn face_coverage(bytes: &[u8]) -> CoverageRanges {
    let Ok(face) = Face::parse(bytes, 0) else {
        return CoverageRanges::default();
    };
    let Some(cmap) = face.tables().cmap else {
        return CoverageRanges::default();
    };

    let mut codepoints = Vec::new();
    for subtable in cmap.subtables {
        if !subtable.is_unicode() {
            continue;
        }

        subtable.codepoints(|codepoint| codepoints.push(codepoint));
    }

    codepoints.sort_unstable();
    codepoints.dedup();
    // `codepoints` reports what a subtable *defines*, which includes entries
    // pointing at glyph 0. Only a real glyph counts as coverage.
    codepoints.retain(|codepoint| {
        char::from_u32(*codepoint).is_some_and(|ch| face.glyph_index(ch).is_some())
    });

    coalesce(&codepoints)
}

/// Folds a sorted, deduplicated codepoint list into inclusive ranges.
fn coalesce(codepoints: &[u32]) -> CoverageRanges {
    let mut ranges: Vec<(u32, u32)> = Vec::new();

    for &codepoint in codepoints {
        match ranges.last_mut() {
            Some(last) if last.1.checked_add(1) == Some(codepoint) => last.1 = codepoint,
            _ => ranges.push((codepoint, codepoint)),
        }
    }

    ranges.into_boxed_slice()
}

/// Returns whether `codepoint` falls inside one of `ranges`.
fn ranges_contain(ranges: &[(u32, u32)], codepoint: u32) -> bool {
    ranges
        .binary_search_by(|&(start, end)| {
            if codepoint < start {
                Ordering::Greater
            } else if codepoint > end {
                Ordering::Less
            } else {
                Ordering::Equal
            }
        })
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::text::bundled_fonts::resolve_bundled;

    /// Hangul syllable "ga" - outside every Latin face compiled in today.
    const HANGUL_GA: char = '\u{AC00}';

    /// Returns a `'static` copy of `bytes` living at an address of its own.
    ///
    /// Deliberately leaked, and small: `BundledFont::bytes` is `&'static [u8]`,
    /// and a copy is precisely what makes a face unknown to the cache, which is
    /// keyed on where the compiled-in bytes live rather than on a file name.
    fn leak_font_bytes(bytes: &[u8]) -> &'static [u8] {
        Box::leak(bytes.to_vec().into_boxed_slice())
    }

    /// Feature: deterministic caption burn-in
    /// Scenario: a family answers the coverage question with one voice
    ///
    /// The export path asks whether a *family* can draw a string and takes
    /// `true` from any weight of it - see `bundled_family_covers_text`. That
    /// approximation is only sound while every weight of a family covers the
    /// same codepoints, which is true of the eight compiled in today because
    /// each family's weights are instanced from one design. A future face whose
    /// bold dropped, say, the Latin Extended block would make the regular
    /// weight vouch for characters the bold cannot draw, and the bold event
    /// would burn in as notdef boxes with `fontsdir` already dropped from the
    /// graph. Fail here rather than there.
    #[test]
    fn every_weight_of_a_bundled_family_covers_the_same_codepoints() {
        let mut by_family: HashMap<&'static str, Vec<&'static BundledFont>> = HashMap::new();
        for font in bundled_faces() {
            by_family.entry(font.family).or_default().push(font);
        }

        for (family, faces) in by_family {
            let Some((first, rest)) = faces.split_first() else {
                continue;
            };
            let expected = face_coverage(first.bytes);
            assert!(
                !expected.is_empty(),
                "{} reported no coverage at all",
                first.file_name
            );

            for font in rest {
                assert_eq!(
                    face_coverage(font.bytes),
                    expected,
                    "'{family}' weights disagree on coverage ({} vs {}); the any-weight \
                     approximation in bundled_family_covers_text is no longer sound and has to \
                     become a per-face question",
                    first.file_name,
                    font.file_name
                );
            }
        }
    }

    #[test]
    fn every_bundled_face_covers_the_latin_alphabet() {
        for font in bundled_faces() {
            for ch in ['A', 'z', '0', ' ', '.'] {
                assert!(
                    face_covers(font, ch),
                    "{} must cover {ch:?}",
                    font.file_name
                );
            }
        }
    }

    #[test]
    fn a_latin_face_does_not_claim_a_hangul_syllable() {
        let font = resolve_bundled("TikTok Sans").expect("TikTok Sans is bundled");

        assert!(!face_covers(font, HANGUL_GA));
    }

    #[test]
    fn coverage_agrees_with_the_face_itself() {
        // The cached ranges are a derived form of the cmap; they have to answer
        // exactly what the face answers, for present and absent characters
        // alike.
        for font in bundled_faces() {
            let face = Face::parse(font.bytes, 0).expect("bundled face parses");

            for codepoint in (0x20u32..0x2FF).chain([0x3042, 0xAC00, 0x1F600]) {
                let Some(ch) = char::from_u32(codepoint) else {
                    continue;
                };

                assert_eq!(
                    face_covers(font, ch),
                    face.glyph_index(ch).is_some(),
                    "{} disagrees with its own cmap about {ch:?}",
                    font.file_name
                );
            }
        }
    }

    #[test]
    fn repeated_questions_keep_answering_the_same_way() {
        let font = resolve_bundled("Poppins").expect("Poppins is bundled");

        for _ in 0..3 {
            assert!(face_covers(font, 'A'));
            assert!(!face_covers(font, HANGUL_GA));
        }
    }

    #[test]
    fn a_face_outside_the_registry_is_read_from_its_own_bytes() {
        // `face_covers` takes any `BundledFont`, and the cache only knows the
        // registry's file names. An unknown one must still be answered from the
        // font it carries rather than being reported as covering nothing.
        let bundled = resolve_bundled("Anton").expect("Anton is bundled");
        let unregistered = BundledFont {
            family: bundled.family,
            file_name: "not-in-the-registry",
            bytes: leak_font_bytes(bundled.bytes),
        };

        assert!(face_covers(&unregistered, 'A'));
        assert!(!face_covers(&unregistered, HANGUL_GA));
    }

    #[test]
    fn a_face_reusing_a_registry_file_name_does_not_inherit_its_coverage() {
        // The cache answers for the bytes it was built from, not for a name a
        // caller can pick. A face that borrows a registered file name while
        // carrying different bytes has to be read from those bytes.
        let registered = resolve_bundled("TikTok Sans").expect("TikTok Sans is bundled");
        assert!(face_covers(registered, 'A'), "the real face covers 'A'");

        let impostor = BundledFont {
            family: registered.family,
            file_name: registered.file_name,
            bytes: leak_font_bytes(b"not a font at all"),
        };

        assert!(!face_covers(&impostor, 'A'));
    }

    #[test]
    fn coalesce_merges_only_adjacent_codepoints() {
        assert_eq!(
            coalesce(&[1, 2, 3, 7, 9, 10]).as_ref(),
            [(1, 3), (7, 7), (9, 10)]
        );
        assert!(coalesce(&[]).is_empty());
    }

    #[test]
    fn ranges_contain_finds_edges_and_rejects_gaps() {
        let ranges = [(1u32, 3u32), (7, 7), (9, 10)];

        for present in [1, 2, 3, 7, 9, 10] {
            assert!(
                ranges_contain(&ranges, present),
                "{present} must be covered"
            );
        }
        for absent in [0, 4, 6, 8, 11] {
            assert!(
                !ranges_contain(&ranges, absent),
                "{absent} must not be covered"
            );
        }
    }
}
