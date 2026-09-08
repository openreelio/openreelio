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

use std::{cmp::Ordering, collections::HashMap, sync::OnceLock};

use ttf_parser::Face;

use super::bundled_fonts::{bundled_faces, BundledFont};

/// Inclusive codepoint ranges a face covers, sorted and disjoint.
type CoverageRanges = Box<[(u32, u32)]>;

/// True if `font`'s cmap maps `ch` to a real glyph.
pub fn face_covers(font: &BundledFont, ch: char) -> bool {
    if let Some(ranges) = coverage_cache().get(font.file_name) {
        return ranges_contain(ranges, u32::from(ch));
    }

    // A face assembled outside the registry has no cached ranges. Ask its own
    // cmap rather than reporting that it covers nothing.
    Face::parse(font.bytes, 0).is_ok_and(|face| face.glyph_index(ch).is_some())
}

/// Returns the coverage of every compiled-in face, keyed by file name.
///
/// Built on first use and never rebuilt, so every later question is a hash
/// lookup and a binary search rather than another `cmap` walk.
fn coverage_cache() -> &'static HashMap<&'static str, CoverageRanges> {
    static CACHE: OnceLock<HashMap<&'static str, CoverageRanges>> = OnceLock::new();

    CACHE.get_or_init(|| {
        bundled_faces()
            .iter()
            .map(|font| (font.file_name, face_coverage(font.bytes)))
            .collect()
    })
}

/// Reads the codepoints an in-memory font maps to a glyph.
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
            bytes: bundled.bytes,
        };

        assert!(face_covers(&unregistered, 'A'));
        assert!(!face_covers(&unregistered, HANGUL_GA));
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
