//! Emoji classification for text that has to be drawn into the picture.
//!
//! Captions and text overlays are burned in through libass, and libass draws
//! one monochrome outline per glyph. A colour emoji font is a COLR/CBDT table
//! layered *on top of* an outline, so what actually reaches the frame is the
//! base outline in the caption's fill colour — or, where the font has no base
//! outline at all, nothing but a tofu box. Sequences fare worse still: a flag
//! is two regional-indicator letters and comes out as the literal text "KR", a
//! keycap is a digit plus a combining enclosure and comes out as "1" with a
//! box after it, and a ZWJ family is drawn as the four people it is joined
//! from.
//!
//! None of that is a render *failure* — the export succeeds and the file plays
//! — so nothing downstream notices. This module is the part that can notice: it
//! segments text into extended grapheme clusters, which is the only
//! segmentation that keeps a flag, a keycap, a skin-tone modifier and a ZWJ
//! sequence each in one piece, and says what class of emoji each cluster is.
//! What a given render path can then do with that class is
//! [`super::super::qc::structural::CaptionEmojiRule`]'s business, not this
//! module's; here we only classify.
//!
//! # Where the tables come from
//!
//! The `Emoji` and `Emoji_Presentation` properties are generated from the
//! Unicode Consortium's `emoji-data.txt` by `scripts/generate-emoji-tables.mjs`
//! and baked in as sorted, inclusive code-point ranges, in the same shape as
//! the existing range tables in `core::qc::rules`. See
//! [`EMOJI_DATA_UNICODE_VERSION`] for the release they were taken from.

use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

/// Unicode release the generated property tables were derived from.
///
/// Bumping this means re-running `scripts/generate-emoji-tables.mjs --version
/// <release>`; the tables and this constant are meant to move together.
pub const EMOJI_DATA_UNICODE_VERSION: &str = "16.0.0";

// BEGIN GENERATED EMOJI TABLES
// Generated from https://www.unicode.org/Public/16.0.0/ucd/emoji/emoji-data.txt
// Regenerate with `node scripts/generate-emoji-tables.mjs`. Do not edit by hand.

/// Code points with the Unicode `Emoji` property.
///
/// Membership alone says nothing about how a character is drawn: most of
/// this set is text-default (`#`, `1`, `❤`) and renders correctly as an
/// ordinary glyph. It is the gate for the *sequences* — a variation
/// selector, a keycap, a ZWJ join — that turn one of these into a picture.
const EMOJI_RANGES: [(u32, u32); 150] = [
    (0x0023, 0x0023),
    (0x002A, 0x002A),
    (0x0030, 0x0039),
    (0x00A9, 0x00A9),
    (0x00AE, 0x00AE),
    (0x203C, 0x203C),
    (0x2049, 0x2049),
    (0x2122, 0x2122),
    (0x2139, 0x2139),
    (0x2194, 0x2199),
    (0x21A9, 0x21AA),
    (0x231A, 0x231B),
    (0x2328, 0x2328),
    (0x23CF, 0x23CF),
    (0x23E9, 0x23F3),
    (0x23F8, 0x23FA),
    (0x24C2, 0x24C2),
    (0x25AA, 0x25AB),
    (0x25B6, 0x25B6),
    (0x25C0, 0x25C0),
    (0x25FB, 0x25FE),
    (0x2600, 0x2604),
    (0x260E, 0x260E),
    (0x2611, 0x2611),
    (0x2614, 0x2615),
    (0x2618, 0x2618),
    (0x261D, 0x261D),
    (0x2620, 0x2620),
    (0x2622, 0x2623),
    (0x2626, 0x2626),
    (0x262A, 0x262A),
    (0x262E, 0x262F),
    (0x2638, 0x263A),
    (0x2640, 0x2640),
    (0x2642, 0x2642),
    (0x2648, 0x2653),
    (0x265F, 0x2660),
    (0x2663, 0x2663),
    (0x2665, 0x2666),
    (0x2668, 0x2668),
    (0x267B, 0x267B),
    (0x267E, 0x267F),
    (0x2692, 0x2697),
    (0x2699, 0x2699),
    (0x269B, 0x269C),
    (0x26A0, 0x26A1),
    (0x26A7, 0x26A7),
    (0x26AA, 0x26AB),
    (0x26B0, 0x26B1),
    (0x26BD, 0x26BE),
    (0x26C4, 0x26C5),
    (0x26C8, 0x26C8),
    (0x26CE, 0x26CF),
    (0x26D1, 0x26D1),
    (0x26D3, 0x26D4),
    (0x26E9, 0x26EA),
    (0x26F0, 0x26F5),
    (0x26F7, 0x26FA),
    (0x26FD, 0x26FD),
    (0x2702, 0x2702),
    (0x2705, 0x2705),
    (0x2708, 0x270D),
    (0x270F, 0x270F),
    (0x2712, 0x2712),
    (0x2714, 0x2714),
    (0x2716, 0x2716),
    (0x271D, 0x271D),
    (0x2721, 0x2721),
    (0x2728, 0x2728),
    (0x2733, 0x2734),
    (0x2744, 0x2744),
    (0x2747, 0x2747),
    (0x274C, 0x274C),
    (0x274E, 0x274E),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2763, 0x2764),
    (0x2795, 0x2797),
    (0x27A1, 0x27A1),
    (0x27B0, 0x27B0),
    (0x27BF, 0x27BF),
    (0x2934, 0x2935),
    (0x2B05, 0x2B07),
    (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50),
    (0x2B55, 0x2B55),
    (0x3030, 0x3030),
    (0x303D, 0x303D),
    (0x3297, 0x3297),
    (0x3299, 0x3299),
    (0x1F004, 0x1F004),
    (0x1F0CF, 0x1F0CF),
    (0x1F170, 0x1F171),
    (0x1F17E, 0x1F17F),
    (0x1F18E, 0x1F18E),
    (0x1F191, 0x1F19A),
    (0x1F1E6, 0x1F1FF),
    (0x1F201, 0x1F202),
    (0x1F21A, 0x1F21A),
    (0x1F22F, 0x1F22F),
    (0x1F232, 0x1F23A),
    (0x1F250, 0x1F251),
    (0x1F300, 0x1F321),
    (0x1F324, 0x1F393),
    (0x1F396, 0x1F397),
    (0x1F399, 0x1F39B),
    (0x1F39E, 0x1F3F0),
    (0x1F3F3, 0x1F3F5),
    (0x1F3F7, 0x1F4FD),
    (0x1F4FF, 0x1F53D),
    (0x1F549, 0x1F54E),
    (0x1F550, 0x1F567),
    (0x1F56F, 0x1F570),
    (0x1F573, 0x1F57A),
    (0x1F587, 0x1F587),
    (0x1F58A, 0x1F58D),
    (0x1F590, 0x1F590),
    (0x1F595, 0x1F596),
    (0x1F5A4, 0x1F5A5),
    (0x1F5A8, 0x1F5A8),
    (0x1F5B1, 0x1F5B2),
    (0x1F5BC, 0x1F5BC),
    (0x1F5C2, 0x1F5C4),
    (0x1F5D1, 0x1F5D3),
    (0x1F5DC, 0x1F5DE),
    (0x1F5E1, 0x1F5E1),
    (0x1F5E3, 0x1F5E3),
    (0x1F5E8, 0x1F5E8),
    (0x1F5EF, 0x1F5EF),
    (0x1F5F3, 0x1F5F3),
    (0x1F5FA, 0x1F64F),
    (0x1F680, 0x1F6C5),
    (0x1F6CB, 0x1F6D2),
    (0x1F6D5, 0x1F6D7),
    (0x1F6DC, 0x1F6E5),
    (0x1F6E9, 0x1F6E9),
    (0x1F6EB, 0x1F6EC),
    (0x1F6F0, 0x1F6F0),
    (0x1F6F3, 0x1F6FC),
    (0x1F7E0, 0x1F7EB),
    (0x1F7F0, 0x1F7F0),
    (0x1F90C, 0x1F93A),
    (0x1F93C, 0x1F945),
    (0x1F947, 0x1F9FF),
    (0x1FA70, 0x1FA7C),
    (0x1FA80, 0x1FA89),
    (0x1FA8F, 0x1FAC6),
    (0x1FACE, 0x1FADC),
    (0x1FADF, 0x1FAE9),
    (0x1FAF0, 0x1FAF8),
];

/// Code points with the Unicode `Emoji_Presentation` property.
///
/// These default to the colour picture with no variation selector asked for,
/// which is exactly the set a monochrome burn-in cannot honour.
const EMOJI_PRESENTATION_RANGES: [(u32, u32); 80] = [
    (0x231A, 0x231B),
    (0x23E9, 0x23EC),
    (0x23F0, 0x23F0),
    (0x23F3, 0x23F3),
    (0x25FD, 0x25FE),
    (0x2614, 0x2615),
    (0x2648, 0x2653),
    (0x267F, 0x267F),
    (0x2693, 0x2693),
    (0x26A1, 0x26A1),
    (0x26AA, 0x26AB),
    (0x26BD, 0x26BE),
    (0x26C4, 0x26C5),
    (0x26CE, 0x26CE),
    (0x26D4, 0x26D4),
    (0x26EA, 0x26EA),
    (0x26F2, 0x26F3),
    (0x26F5, 0x26F5),
    (0x26FA, 0x26FA),
    (0x26FD, 0x26FD),
    (0x2705, 0x2705),
    (0x270A, 0x270B),
    (0x2728, 0x2728),
    (0x274C, 0x274C),
    (0x274E, 0x274E),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2795, 0x2797),
    (0x27B0, 0x27B0),
    (0x27BF, 0x27BF),
    (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50),
    (0x2B55, 0x2B55),
    (0x1F004, 0x1F004),
    (0x1F0CF, 0x1F0CF),
    (0x1F18E, 0x1F18E),
    (0x1F191, 0x1F19A),
    (0x1F1E6, 0x1F1FF),
    (0x1F201, 0x1F201),
    (0x1F21A, 0x1F21A),
    (0x1F22F, 0x1F22F),
    (0x1F232, 0x1F236),
    (0x1F238, 0x1F23A),
    (0x1F250, 0x1F251),
    (0x1F300, 0x1F320),
    (0x1F32D, 0x1F335),
    (0x1F337, 0x1F37C),
    (0x1F37E, 0x1F393),
    (0x1F3A0, 0x1F3CA),
    (0x1F3CF, 0x1F3D3),
    (0x1F3E0, 0x1F3F0),
    (0x1F3F4, 0x1F3F4),
    (0x1F3F8, 0x1F43E),
    (0x1F440, 0x1F440),
    (0x1F442, 0x1F4FC),
    (0x1F4FF, 0x1F53D),
    (0x1F54B, 0x1F54E),
    (0x1F550, 0x1F567),
    (0x1F57A, 0x1F57A),
    (0x1F595, 0x1F596),
    (0x1F5A4, 0x1F5A4),
    (0x1F5FB, 0x1F64F),
    (0x1F680, 0x1F6C5),
    (0x1F6CC, 0x1F6CC),
    (0x1F6D0, 0x1F6D2),
    (0x1F6D5, 0x1F6D7),
    (0x1F6DC, 0x1F6DF),
    (0x1F6EB, 0x1F6EC),
    (0x1F6F4, 0x1F6FC),
    (0x1F7E0, 0x1F7EB),
    (0x1F7F0, 0x1F7F0),
    (0x1F90C, 0x1F93A),
    (0x1F93C, 0x1F945),
    (0x1F947, 0x1F9FF),
    (0x1FA70, 0x1FA7C),
    (0x1FA80, 0x1FA89),
    (0x1FA8F, 0x1FAC6),
    (0x1FACE, 0x1FADC),
    (0x1FADF, 0x1FAE9),
    (0x1FAF0, 0x1FAF8),
];

// END GENERATED EMOJI TABLES

/// First and last regional indicator symbol letter (`A`..`Z`).
///
/// A flag is a *pair* of these, and extended grapheme segmentation is what
/// pairs them; a lone one left over from a truncated string is still counted
/// here, because it draws as a stray letter for the same reason a pair does.
const REGIONAL_INDICATOR_RANGE: (u32, u32) = (0x1F1E6, 0x1F1FF);

/// Waving black flag, the base of every tag-sequence subdivision flag.
const TAG_FLAG_BASE: char = '\u{1F3F4}';

/// Tag characters, which spell a subdivision code after [`TAG_FLAG_BASE`].
const TAG_CHARACTER_RANGE: (u32, u32) = (0xE0020, 0xE007F);

/// Combining enclosing keycap, the box drawn around a keycap's digit.
const COMBINING_ENCLOSING_KEYCAP: char = '\u{20E3}';

/// Zero width joiner, which fuses several emoji into one picture.
const ZERO_WIDTH_JOINER: char = '\u{200D}';

/// Variation selector 16, which asks for the colour emoji presentation.
const VARIATION_SELECTOR_16: char = '\u{FE0F}';

/// Variation selector 15, which asks for the monochrome text presentation.
const VARIATION_SELECTOR_15: char = '\u{FE0E}';

/// Emoji modifiers Fitzpatrick 1-2 through 6.
const SKIN_TONE_RANGE: (u32, u32) = (0x1F3FB, 0x1F3FF);

/// Characters that may begin a keycap sequence.
const KEYCAP_BASES: [char; 12] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '#', '*'];

/// What kind of emoji a cluster is, and so how a monochrome burn-in fails it.
///
/// The variants are ordered by how badly the burn-in mangles them, worst first,
/// which is what [`EmojiClass::rank`] reports and what lets a caption carrying
/// several kinds name the one worth quoting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum EmojiClass {
    /// `U+1F3F4` plus tag characters: a subdivision flag (🏴󠁧󠁢󠁳󠁣󠁴󠁿).
    ///
    /// Nothing in the sequence after the base flag has a glyph of its own, so
    /// an unsupported font draws the black flag and drops the subdivision, and
    /// a font without the base draws nothing at all.
    TagFlag,
    /// A pair of regional indicators: a country flag (🇰🇷).
    ///
    /// Without the font's ligature the pair falls back to its letters, so the
    /// caption reads "KR" where the author wrote a flag.
    RegionalFlag,
    /// A digit, `#` or `*` enclosed in a keycap (1️⃣).
    ///
    /// The digit draws; the combining enclosure usually does not, so the
    /// caption reads "1" followed by a tofu box.
    Keycap,
    /// Two or more emoji joined by `U+200D` into one picture (👩‍💻).
    ///
    /// Drawn as the emoji it was joined from, side by side, so a family of four
    /// becomes four people standing in the caption.
    ZwjSequence,
    /// An emoji carrying a Fitzpatrick skin-tone modifier (👍🏽).
    ///
    /// The modifier has no standalone glyph, so the base draws untinted and the
    /// modifier draws as tofu or vanishes.
    SkinToneModified,
    /// An emoji that defaults to, or explicitly asks for, colour presentation.
    ///
    /// Drawn as the monochrome base outline in the caption's fill colour, or as
    /// tofu where the colour font carries no base outline.
    Presentation,
    /// An emoji explicitly asking for text presentation with `U+FE0E` (❤︎).
    ///
    /// The one class a monochrome burn-in renders exactly as asked, listed so a
    /// caller can tell "not emoji" from "emoji that is already fine".
    TextPresentation,
}

impl EmojiClass {
    /// Identifier used in violation metrics.
    pub fn as_str(self) -> &'static str {
        match self {
            EmojiClass::TagFlag => "tagFlag",
            EmojiClass::RegionalFlag => "regionalFlag",
            EmojiClass::Keycap => "keycap",
            EmojiClass::ZwjSequence => "zwjSequence",
            EmojiClass::SkinToneModified => "skinToneModified",
            EmojiClass::Presentation => "presentation",
            EmojiClass::TextPresentation => "textPresentation",
        }
    }

    /// How badly a monochrome burn-in mangles this class; lower is worse.
    ///
    /// Derived from the declaration order rather than written out again, so a
    /// variant inserted in the right place cannot be ranked in the wrong one.
    pub fn rank(self) -> u8 {
        self as u8
    }
}

/// One extended grapheme cluster that scanned as emoji.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmojiCluster<'a> {
    /// The cluster exactly as it appears in the scanned text.
    pub text: &'a str,
    /// Byte offsets of [`text`](Self::text) within the scanned string.
    pub byte_range: Range<usize>,
    /// How a monochrome burn-in fails this cluster.
    pub class: EmojiClass,
    /// Every code point in the cluster, in order, selectors included.
    pub codepoints: Vec<char>,
    /// Canonical identity of the sequence; see [`sequence_key`].
    pub sequence_key: String,
}

/// Splits `text` into extended grapheme clusters and returns the emoji ones.
///
/// Extended clusters are what make this correct rather than approximate: they
/// keep a regional-indicator pair, a keycap, a skin-tone modifier and a whole
/// ZWJ sequence together, so "how many emoji are in this caption" answers with
/// the number a reader would count instead of the number of code points.
///
/// Plain text — Latin, CJK, punctuation — and bare text-default symbols such as
/// `U+2764` with no variation selector produce no clusters at all: they draw
/// correctly, and reporting them would be noise.
pub fn scan(text: &str) -> Vec<EmojiCluster<'_>> {
    text.grapheme_indices(true)
        .filter_map(|(offset, grapheme)| {
            let codepoints: Vec<char> = grapheme.chars().collect();
            let class = classify(&codepoints)?;

            Some(EmojiCluster {
                text: grapheme,
                byte_range: offset..offset + grapheme.len(),
                class,
                sequence_key: sequence_key_for(&codepoints),
                codepoints,
            })
        })
        .collect()
}

/// Canonical identity of a cluster's sequence.
///
/// Lowercase hexadecimal code points joined by `-`, with every `U+FE0F`
/// dropped: the emoji presentation selector changes nothing about *which*
/// emoji a sequence is, and keeping it would file `👍` and `👍️` as two
/// different things. The result matches the naming CLDR and the emoji-test
/// data use for sequences, so `1f469-200d-1f4bb` is a key a lookup table or a
/// bug report can be written against.
pub fn sequence_key(cluster: &EmojiCluster<'_>) -> String {
    sequence_key_for(&cluster.codepoints)
}

/// [`sequence_key`] over the code points alone, for use before a cluster exists.
fn sequence_key_for(codepoints: &[char]) -> String {
    codepoints
        .iter()
        .copied()
        .filter(|codepoint| *codepoint != VARIATION_SELECTOR_16)
        .map(|codepoint| format!("{:x}", codepoint as u32))
        .collect::<Vec<_>>()
        .join("-")
}

/// Classifies one grapheme cluster, or returns `None` when it is not emoji.
///
/// Tested in the order the burn-in fails, worst first, because a cluster is
/// routinely several things at once — a ZWJ sequence whose members carry skin
/// tones, a keycap that also carries `U+FE0F` — and the class reported has to
/// be the one that explains what lands on the frame.
fn classify(codepoints: &[char]) -> Option<EmojiClass> {
    if !codepoints.iter().copied().any(is_emoji) {
        return None;
    }

    if codepoints.first() == Some(&TAG_FLAG_BASE)
        && codepoints.iter().copied().any(is_tag_character)
    {
        return Some(EmojiClass::TagFlag);
    }

    if codepoints.iter().copied().any(is_regional_indicator) {
        return Some(EmojiClass::RegionalFlag);
    }

    // The variation selector is optional here on purpose. `1 U+20E3` is the
    // legacy keycap and is still what a paste from an older document carries;
    // it draws exactly as badly as the `U+FE0F` form, so refusing to recognise
    // it would only hide the same defect.
    if codepoints.contains(&COMBINING_ENCLOSING_KEYCAP)
        && codepoints
            .first()
            .is_some_and(|first| KEYCAP_BASES.contains(first))
    {
        return Some(EmojiClass::Keycap);
    }

    if codepoints.contains(&ZERO_WIDTH_JOINER) {
        return Some(EmojiClass::ZwjSequence);
    }

    if codepoints.iter().copied().any(is_skin_tone_modifier) {
        return Some(EmojiClass::SkinToneModified);
    }

    if codepoints.contains(&VARIATION_SELECTOR_15) {
        return Some(EmojiClass::TextPresentation);
    }

    if has_emoji_presentation(codepoints) {
        return Some(EmojiClass::Presentation);
    }

    None
}

/// Whether the cluster asks for, or defaults to, the colour presentation.
///
/// Either half is enough: a code point whose `Emoji_Presentation` is `Yes`
/// defaults to colour with nothing written after it, and a text-default emoji
/// followed by `U+FE0F` has asked for colour explicitly.
fn has_emoji_presentation(codepoints: &[char]) -> bool {
    if codepoints.iter().copied().any(is_emoji_presentation) {
        return true;
    }

    codepoints
        .windows(2)
        .any(|pair| is_emoji(pair[0]) && pair[1] == VARIATION_SELECTOR_16)
}

/// Whether `codepoint` falls inside any of the inclusive `ranges`.
fn in_ranges(ranges: &[(u32, u32)], codepoint: char) -> bool {
    let code = u32::from(codepoint);
    ranges
        .iter()
        .any(|(first, last)| code >= *first && code <= *last)
}

/// Whether `codepoint` carries the Unicode `Emoji` property.
fn is_emoji(codepoint: char) -> bool {
    in_ranges(&EMOJI_RANGES, codepoint)
}

/// Whether `codepoint` carries the Unicode `Emoji_Presentation` property.
fn is_emoji_presentation(codepoint: char) -> bool {
    in_ranges(&EMOJI_PRESENTATION_RANGES, codepoint)
}

/// Whether `codepoint` is one of the regional indicator symbol letters.
pub fn is_regional_indicator(codepoint: char) -> bool {
    in_ranges(&[REGIONAL_INDICATOR_RANGE], codepoint)
}

/// Whether `codepoint` is a tag character used to spell a subdivision flag.
fn is_tag_character(codepoint: char) -> bool {
    in_ranges(&[TAG_CHARACTER_RANGE], codepoint)
}

/// Whether `codepoint` is a Fitzpatrick skin-tone modifier.
fn is_skin_tone_modifier(codepoint: char) -> bool {
    in_ranges(&[SKIN_TONE_RANGE], codepoint)
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// One scanned cluster, as `(text, class, sequence key)`.
    fn scanned(text: &str) -> Vec<(String, EmojiClass, String)> {
        scan(text)
            .into_iter()
            .map(|cluster| {
                assert_eq!(
                    &text[cluster.byte_range.clone()],
                    cluster.text,
                    "byte_range must address the cluster it reports"
                );
                assert_eq!(
                    sequence_key(&cluster),
                    cluster.sequence_key,
                    "the stored key must equal the computed one"
                );
                (
                    cluster.text.to_string(),
                    cluster.class,
                    cluster.sequence_key.clone(),
                )
            })
            .collect()
    }

    /// Feature: Emoji classification
    /// Scenario: should classify every class the burn-in fails, and only those
    #[test]
    fn should_classify_each_emoji_class() {
        let cases: [(&str, Option<EmojiClass>); 14] = [
            // Emoji_Presentation=Yes: colour with nothing asked for.
            ("\u{1F600}", Some(EmojiClass::Presentation)),
            // Emoji=Yes plus U+FE0F: colour asked for explicitly.
            ("\u{2764}\u{FE0F}", Some(EmojiClass::Presentation)),
            // Emoji=Yes with no selector at all: a text-default symbol.
            ("\u{2764}", None),
            // U+FE0E: the one presentation a monochrome burn-in honours.
            ("\u{2764}\u{FE0E}", Some(EmojiClass::TextPresentation)),
            ("\u{1F1F0}\u{1F1F7}", Some(EmojiClass::RegionalFlag)),
            (
                "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
                Some(EmojiClass::TagFlag),
            ),
            // A bare waving flag is not a tag sequence.
            ("\u{1F3F4}", Some(EmojiClass::Presentation)),
            ("1\u{FE0F}\u{20E3}", Some(EmojiClass::Keycap)),
            ("#\u{FE0F}\u{20E3}", Some(EmojiClass::Keycap)),
            // The legacy keycap, with no variation selector.
            ("1\u{20E3}", Some(EmojiClass::Keycap)),
            ("\u{1F469}\u{200D}\u{1F4BB}", Some(EmojiClass::ZwjSequence)),
            ("\u{1F44D}\u{1F3FD}", Some(EmojiClass::SkinToneModified)),
            // Plain text of both widths.
            ("A", None),
            ("\u{D55C}", None),
        ];

        for (text, expected) in cases {
            let found = scan(text);
            match expected {
                Some(class) => {
                    assert_eq!(found.len(), 1, "{text:?} must scan as exactly one cluster");
                    assert_eq!(found[0].class, class, "{text:?}");
                }
                None => assert!(
                    found.is_empty(),
                    "{text:?} must not scan as emoji: {found:?}"
                ),
            }
        }
    }

    /// Feature: Emoji classification
    /// Scenario: should keep a boundary code point on the right side of it
    #[test]
    fn should_place_boundary_code_points_correctly() {
        // The regional indicator block's first and last letters, and the two
        // code points on either side of it.
        assert!(is_regional_indicator('\u{1F1E6}'));
        assert!(is_regional_indicator('\u{1F1FF}'));
        assert!(!is_regional_indicator('\u{1F1E5}'));
        assert!(!is_regional_indicator('\u{1F200}'));

        // The skin-tone modifier block.
        assert!(is_skin_tone_modifier('\u{1F3FB}'));
        assert!(is_skin_tone_modifier('\u{1F3FF}'));
        assert!(!is_skin_tone_modifier('\u{1F3FA}'));
        assert!(!is_skin_tone_modifier('\u{1F400}'));

        // The tag block, whose last member is the cancel tag.
        assert!(is_tag_character('\u{E0020}'));
        assert!(is_tag_character('\u{E007F}'));
        assert!(!is_tag_character('\u{E001F}'));
        assert!(!is_tag_character('\u{E0080}'));

        // Digits are Emoji=Yes but never Emoji_Presentation=Yes, which is what
        // keeps a plain "2024" out of the report.
        assert!(is_emoji('1'));
        assert!(!is_emoji_presentation('1'));
        assert!(scan("2024").is_empty());
    }

    /// Feature: Emoji classification
    /// Scenario: should count a sequence as one cluster, not as its parts
    #[test]
    fn should_count_a_sequence_as_one_cluster() {
        let flag = scan("\u{1F1F0}\u{1F1F7}");
        assert_eq!(flag.len(), 1, "a flag is one cluster, not two letters");
        assert_eq!(flag[0].codepoints.len(), 2);

        let family = scan("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}");
        assert_eq!(family.len(), 1, "a ZWJ family is one cluster, not four");
        assert_eq!(family[0].codepoints.len(), 7);
    }

    /// Feature: Emoji classification
    /// Scenario: should report clusters in order with the offsets they came from
    #[test]
    fn should_report_clusters_in_order_with_their_offsets() {
        let text = "Hi \u{1F600} there \u{1F1F0}\u{1F1F7}!";

        assert_eq!(
            scanned(text),
            vec![
                (
                    "\u{1F600}".to_string(),
                    EmojiClass::Presentation,
                    "1f600".to_string()
                ),
                (
                    "\u{1F1F0}\u{1F1F7}".to_string(),
                    EmojiClass::RegionalFlag,
                    "1f1f0-1f1f7".to_string(),
                ),
            ]
        );
    }

    /// Feature: Sequence keys
    /// Scenario: should drop the emoji presentation selector and nothing else
    #[test]
    fn should_build_sequence_keys_without_the_presentation_selector() {
        assert_eq!(
            scan("\u{1F469}\u{200D}\u{1F4BB}")[0].sequence_key,
            "1f469-200d-1f4bb"
        );
        assert_eq!(scan("\u{2764}\u{FE0F}")[0].sequence_key, "2764");
        assert_eq!(scan("1\u{FE0F}\u{20E3}")[0].sequence_key, "31-20e3");
        // U+FE0E is part of the identity: it is what makes this cluster the
        // text presentation rather than the colour one.
        assert_eq!(scan("\u{2764}\u{FE0E}")[0].sequence_key, "2764-fe0e");
    }

    /// Feature: Emoji classification
    /// Scenario: should report the worst class when a cluster is several at once
    #[test]
    fn should_report_the_worst_class_of_a_compound_cluster() {
        // A skin-toned ZWJ sequence is both; the ZWJ join is what mangles it
        // worse, so that is what is reported.
        let cluster = &scan("\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}")[0];
        assert_eq!(cluster.class, EmojiClass::ZwjSequence);
        assert!(cluster.class.rank() < EmojiClass::SkinToneModified.rank());

        // Every class the burn-in fails outranks the one it does not.
        assert!(EmojiClass::Presentation.rank() < EmojiClass::TextPresentation.rank());
        assert!(EmojiClass::TagFlag.rank() < EmojiClass::RegionalFlag.rank());
    }

    /// Feature: Emoji tables
    /// Scenario: should stay sorted and disjoint so a lookup can trust them
    #[test]
    fn should_keep_the_generated_tables_sorted_and_disjoint() {
        for (label, ranges) in [
            ("EMOJI_RANGES", EMOJI_RANGES.as_slice()),
            (
                "EMOJI_PRESENTATION_RANGES",
                EMOJI_PRESENTATION_RANGES.as_slice(),
            ),
        ] {
            for window in ranges.windows(2) {
                assert!(
                    window[0].1 < window[1].0,
                    "{label} must be sorted and disjoint at {window:?}"
                );
            }
            for (first, last) in ranges {
                assert!(
                    first <= last,
                    "{label} range {first:#X}..{last:#X} is inverted"
                );
            }
        }

        // Emoji_Presentation is a subset of Emoji; if that stops being true the
        // tables were generated from mismatched files.
        for (first, last) in EMOJI_PRESENTATION_RANGES {
            for code in first..=last {
                let Some(codepoint) = char::from_u32(code) else {
                    continue;
                };
                assert!(
                    is_emoji(codepoint),
                    "{code:#X} has Emoji_Presentation but not Emoji"
                );
            }
        }
    }
}
