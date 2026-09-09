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
//! # From one face to a chain
//!
//! [`FontStack`] turns that primitive into the question the burn-in actually
//! asks: given an ordered list of bundled families, which one draws each piece
//! of this string? [`split_runs`] answers it by extended grapheme cluster, so
//! the emitter can name a different face for the emoji in a caption than for
//! the words around it, and libass never has to consult the host provider for
//! a character something in the binary can draw.
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
//! emoji must treat a `true` here as necessary, never sufficient - which is
//! why [`FontStack`] requires a *single* face to cover every codepoint of a
//! cluster before it will route the cluster there: splitting a ZWJ sequence
//! across two faces guarantees the wrong picture, where keeping it whole only
//! risks one.

use std::{cmp::Ordering, collections::HashMap, sync::OnceLock};

use ttf_parser::Face;
use unicode_segmentation::UnicodeSegmentation;

use super::{
    bundled_fonts::{bundled_faces, bundled_family_faces, BundledFont, EMOJI_FALLBACK_FAMILY},
    emoji,
};

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

/// One tier of a [`FontStack`]: a family, and every weight of it.
///
/// Every weight, because libass picks between them by the event's own bold
/// bits, so a tier can only vouch for a character all of its faces can draw -
/// or, as the export path already assumes, any of them can. See
/// `every_weight_of_a_bundled_family_covers_the_same_codepoints`.
struct FaceTier {
    family: &'static str,
    faces: Vec<&'static BundledFont>,
    /// Whether this tier may only claim clusters drawn as a picture.
    ///
    /// True for the emoji face and nothing else. Its `cmap` reaches well past
    /// the pictures it is here for: `▶`, `⏸`, `‼`, `ℹ`, `Ⓜ` and the rest of the
    /// text-default symbols that carry the `Emoji` property are all in it, and
    /// all drawn at emoji proportions - 1.27 em against a text face's 0.218 em
    /// space. Claiming those turned `"▶ PLAY"` into an oversized triangle and
    /// moved the line's wrap, so coverage alone does not qualify a tier that
    /// draws at emoji proportions: the cluster has to be an emoji presentation
    /// as well. See [`emoji::is_emoji_presentation_cluster`].
    emoji_presentation_only: bool,
}

impl FaceTier {
    /// True if one face of this family draws every codepoint of `cluster`.
    fn covers_cluster(&self, cluster: &str) -> bool {
        if self.emoji_presentation_only && !emoji::is_emoji_presentation_cluster(cluster) {
            return false;
        }

        cluster
            .chars()
            .all(|ch| self.faces.iter().any(|face| face_covers(face, ch)))
    }
}

/// The bundled families libass may draw a string from, most preferred first.
///
/// The first tier is the family the ASS `Style` line names; the rest are
/// fallbacks reached per grapheme cluster, for characters the first cannot
/// draw. A name that is not compiled in contributes no tier, so a stack is
/// always a closed set of faces the script can carry - which is what makes it
/// safe to write a tier's name into an ASS override block.
#[derive(Default)]
pub struct FontStack {
    tiers: Vec<FaceTier>,
}

/// What a single face has to say about one grapheme cluster.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Slot {
    /// Whitespace or control characters only: laid out rather than drawn, so
    /// the cluster has no opinion about which face renders it.
    Neutral,
    /// The family that draws the whole cluster, or `None` when no tier does.
    Drawn(Option<&'static str>),
}

/// A stretch of text that one face - or no bundled face - draws.
///
/// `family` is `None` when nothing in the stack covers the run, which is the
/// signal to leave it on the style's own family and let libass reach the host
/// font provider, exactly as every non-Latin caption has always done.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TextRun<'a> {
    pub text: &'a str,
    pub family: Option<&'static str>,
}

impl FontStack {
    /// Builds a stack from family names, in the order libass should try them.
    ///
    /// Names resolve through [`bundled_family_faces`], so a fallback-only
    /// family is reachable here even though a style could never name it, and
    /// anything not compiled in is dropped rather than promised. Repeats
    /// collapse: a stack that named its primary twice would ask the same
    /// `cmap` twice for every character and change nothing.
    pub fn new(families: &[&str]) -> Self {
        let mut tiers: Vec<FaceTier> = Vec::with_capacity(families.len());

        for requested in families {
            let faces = bundled_family_faces(requested);
            let Some(first) = faces.first() else {
                continue;
            };
            let family = first.family;

            if tiers.iter().any(|tier| tier.family == family) {
                continue;
            }

            tiers.push(FaceTier {
                family,
                faces,
                emoji_presentation_only: family == EMOJI_FALLBACK_FAMILY,
            });
        }

        Self { tiers }
    }

    /// The family a `Style` line names, which every uncovered run stays on.
    pub fn primary(&self) -> Option<&'static str> {
        self.tiers.first().map(|tier| tier.family)
    }

    /// Whether the stack carries no face at all.
    pub fn is_empty(&self) -> bool {
        self.tiers.is_empty()
    }

    /// The first family that draws every codepoint of `cluster`.
    fn family_for_cluster(&self, cluster: &str) -> Option<&'static str> {
        self.tiers
            .iter()
            .find(|tier| tier.covers_cluster(cluster))
            .map(|tier| tier.family)
    }

    /// Whether the stack draws every character of `text` that is drawn at all.
    ///
    /// Whitespace and control characters are laid out rather than drawn, so a
    /// face with no glyph for them still renders the line and they are not
    /// asked about. Everything else has to be covered by one tier, cluster by
    /// cluster; a `false` here is what keeps `fontsdir` on the filtergraph.
    ///
    /// # The answer is codepoint coverage, and that is irreversible here
    ///
    /// A tier vouches for a cluster when it maps every codepoint in it, which
    /// says nothing about whether its `GSUB` joins them - see the module
    /// documentation. Noto Emoji 3.002 ligates the sequences of its own
    /// Unicode release and maps the parts of every later one, so a ZWJ
    /// combination assigned after that build returns `true` here, drops
    /// `fontsdir`, and then decomposes into the emoji it was joined from. That
    /// is now a one-way door: dropping `fontsdir` is exactly what stops libass
    /// consulting the machine's newer emoji font, which might have ligated it.
    /// The trade is deliberate - one deterministic decomposition everywhere
    /// beats a different picture per OS - but a font bump is the only thing
    /// that fixes such a sequence.
    pub fn covers(&self, text: &str) -> bool {
        text.graphemes(true)
            .all(|cluster| is_neutral(cluster) || self.family_for_cluster(cluster).is_some())
    }

    /// The fallback families the runs of `text` name, first use first.
    ///
    /// The primary is left out: it is the family the `Style` line already
    /// carries, and the caller embeds it whether or not a run reaches it.
    /// Everything else here is a face the script has to start carrying,
    /// because an override block is about to name it.
    pub fn fallbacks_used(&self, text: &str) -> Vec<&'static str> {
        let primary = self.primary();
        let mut used: Vec<&'static str> = Vec::new();

        for run in split_runs(text, self) {
            let Some(family) = run.family else {
                continue;
            };

            if Some(family) != primary && !used.contains(&family) {
                used.push(family);
            }
        }

        used
    }
}

/// The bundled faces a caption or overlay set in `family` may draw from.
///
/// Family selection and glyph coverage are different questions. Resolving a
/// style to a bundled family says the script carries *a* face; it says nothing
/// about whether that face has an outline for the characters this event
/// actually contains. Every *text* family compiled in is Latin-only, so an
/// emoji on the default path used to resolve to a bundled family, embed it, and
/// then need libass to reach past the attachment - onto whichever colour emoji
/// font the machine happened to have, or onto nothing at all.
///
/// The second tier closes that: [`EMOJI_FALLBACK_FAMILY`] is a monochrome face
/// we ship, so an emoji is drawn from the script's own `[Fonts]` section on
/// every OS. What is left over - Korean, Japanese, Chinese, Arabic, Thai, every
/// script we bundle no face for - still comes back uncovered, which is what
/// keeps `fontsdir` on the graph for those events.
///
/// `family` has to be one the binary carries. Without a primary there is
/// nothing to fall back *from*, and building the stack anyway would quietly
/// promote the emoji face to primary - the one face a caption must never be set
/// in - so a family we do not ship yields an empty stack, and the event is
/// emitted exactly as it was before the chain existed.
///
/// Shared with `core::qc::structural::CaptionEmojiRule`, which asks the same
/// question about the same caption without rendering it: a check that reasoned
/// about a chain the export does not build would report defects the frame does
/// not have.
pub fn caption_font_stack(family: &str) -> FontStack {
    if super::bundled_fonts::resolve_bundled(family).is_none() {
        return FontStack::default();
    }

    FontStack::new(&[family, EMOJI_FALLBACK_FAMILY])
}

/// True if a cluster is laid out rather than drawn.
fn is_neutral(cluster: &str) -> bool {
    cluster
        .chars()
        .all(|ch| ch.is_whitespace() || ch.is_control())
}

/// Splits `text` into runs, each labelled with the face that draws it.
///
/// # Why grapheme clusters
///
/// Segmentation is by *extended* grapheme cluster, never by codepoint. A ZWJ
/// family, a flag's regional-indicator pair, a keycap, a skin-tone modifier and
/// a combining mark are each several codepoints that render as one picture, and
/// a run boundary through the middle of one guarantees the wrong picture: the
/// pieces get shaped separately, in two different faces, and no substitution
/// lookup can join them back up. Clusters are therefore atomic - a cluster is
/// routed to the first tier that draws *every* codepoint in it, or to no tier
/// at all.
///
/// # Why whitespace has no opinion
///
/// A space is laid out, not drawn, and the emoji face's is 1.27 em wide. Asking
/// which face "covers" it would put the spaces of a mixed line into whichever
/// face happened to precede them and quietly change the line's width. So a
/// whitespace run joins its neighbours when they agree - which is what keeps a
/// Korean, Arabic or Thai sentence one unbroken run with no face change in it -
/// and otherwise falls to the primary, the face the `Style` line already names.
pub fn split_runs<'a>(text: &'a str, stack: &FontStack) -> Vec<TextRun<'a>> {
    let mut clusters: Vec<(usize, usize, Slot)> = text
        .grapheme_indices(true)
        .map(|(offset, cluster)| {
            let slot = if is_neutral(cluster) {
                Slot::Neutral
            } else {
                Slot::Drawn(stack.family_for_cluster(cluster))
            };

            (offset, offset + cluster.len(), slot)
        })
        .collect();

    resolve_neutral_clusters(&mut clusters, stack.primary());

    // Coalesce as byte ranges rather than as slices, so extending a run is one
    // assignment instead of arithmetic back from its current length.
    let mut spans: Vec<(usize, usize, Option<&'static str>)> = Vec::new();
    for (start, end, slot) in clusters {
        let Slot::Drawn(family) = slot else {
            // `resolve_neutral_clusters` leaves no `Neutral` behind.
            continue;
        };

        match spans.last_mut() {
            Some(span) if span.2 == family => span.1 = end,
            _ => spans.push((start, end, family)),
        }
    }

    spans
        .into_iter()
        .map(|(start, end, family)| TextRun {
            text: &text[start..end],
            family,
        })
        .collect()
}

/// Gives every neutral cluster the face of the run it belongs to.
///
/// A maximal group of neutral clusters takes the family of its neighbours only
/// when both exist, agree, and name something a space may safely be measured
/// in: the primary, or `None` - the unlabelled run that a script we bundle no
/// face for comes back as, which has to stay whole so the host shapes it in one
/// piece. Every other agreement falls to the primary, including at either end
/// of the string.
///
/// "Every other agreement" is the fallback faces, and it is the whole point.
/// Two emoji with a space between them - `"🔥 🔥"`, the product's own caption
/// idiom - agree on the emoji face, and inheriting it would draw the space in
/// Noto Emoji at 1.27 em against the text face's 0.218 em: 5.8 times wider,
/// changing both the spacing and where the line wraps.
fn resolve_neutral_clusters(clusters: &mut [(usize, usize, Slot)], primary: Option<&'static str>) {
    let mut index = 0;
    while index < clusters.len() {
        if clusters[index].2 != Slot::Neutral {
            index += 1;
            continue;
        }

        let group_end = clusters[index..]
            .iter()
            .position(|(_, _, slot)| *slot != Slot::Neutral)
            .map_or(clusters.len(), |offset| index + offset);

        // Read both neighbours before writing: the loop only ever rewrites the
        // group itself, so the left one is still the face it was assigned.
        let left = index.checked_sub(1).map(|before| clusters[before].2);
        let right = clusters.get(group_end).map(|(_, _, slot)| *slot);
        let resolved = match (left, right) {
            (Some(Slot::Drawn(before)), Some(Slot::Drawn(after)))
                if before == after && (before.is_none() || before == primary) =>
            {
                before
            }
            _ => primary,
        };

        for cluster in &mut clusters[index..group_end] {
            cluster.2 = Slot::Drawn(resolved);
        }
        index = group_end;
    }
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
    use crate::core::text::bundled_fonts::{
        resolve_bundled, FaceRole, DEFAULT_BUNDLED_FAMILY, EMOJI_FALLBACK_FAMILY,
    };

    /// Hangul syllable "ga" - outside every Latin face compiled in today.
    const HANGUL_GA: char = '\u{AC00}';

    /// The single face of the bundled emoji family.
    fn resolve_emoji_face() -> &'static BundledFont {
        bundled_family_faces(EMOJI_FALLBACK_FAMILY)
            .first()
            .copied()
            .expect("the emoji fallback family is compiled in")
    }

    /// The stack the caption burn-in builds: the default face, then emoji.
    fn caption_stack() -> FontStack {
        FontStack::new(&[DEFAULT_BUNDLED_FAMILY, EMOJI_FALLBACK_FAMILY])
    }

    /// `split_runs` as `(text, family)` pairs, which is what the assertions
    /// below are actually about.
    fn runs_of(text: &str, stack: &FontStack) -> Vec<(String, Option<&'static str>)> {
        split_runs(text, stack)
            .into_iter()
            .map(|run| (run.text.to_string(), run.family))
            .collect()
    }

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

    /// Feature: deterministic caption burn-in
    /// Scenario: a face a style may name can draw the words around the emoji
    ///
    /// Scoped to [`FaceRole::Text`] on purpose. A fallback face is reached per
    /// glyph and never names a `Style` line, so it is free to cover one script
    /// and nothing else - Noto Emoji has no `A` at all. A *text* face that
    /// could not draw the Latin alphabet would burn a caption in as boxes.
    #[test]
    fn every_face_a_style_may_name_covers_the_latin_alphabet() {
        for font in bundled_faces() {
            if font.role != FaceRole::Text {
                continue;
            }

            for ch in ['A', 'z', '0', ' ', '.'] {
                assert!(
                    face_covers(font, ch),
                    "{} must cover {ch:?}",
                    font.file_name
                );
            }
        }
    }

    /// Feature: deterministic emoji burn-in
    /// Scenario: the bundled emoji face really has the glyphs it is here for
    ///
    /// The whole chain rests on this file carrying outlines for the emoji a
    /// caption contains and for the joiners that assemble the sequences. A
    /// colour build (`CBDT`/`COLR`) or a wrong download would pass every other
    /// test in the tree and still burn in notdef boxes.
    #[test]
    fn the_bundled_emoji_face_covers_emoji_and_their_joiners() {
        let font = resolve_emoji_face();

        for (ch, what) in [
            ('\u{1F525}', "fire"),
            ('\u{1F600}', "grinning face"),
            ('\u{2764}', "heavy black heart"),
            ('\u{1F468}', "man"),
            ('\u{1F469}', "woman"),
            ('\u{1F467}', "girl"),
            ('\u{200D}', "zero width joiner"),
            ('\u{FE0F}', "variation selector 16"),
            ('\u{FE0E}', "variation selector 15"),
            ('\u{20E3}', "combining enclosing keycap"),
            ('\u{1F3FB}', "skin tone modifier"),
            ('\u{1F1FA}', "regional indicator U"),
            ('\u{1F1F8}', "regional indicator S"),
            ('\u{1F3F4}', "waving black flag"),
            ('\u{E0067}', "tag letter g"),
        ] {
            assert!(face_covers(font, ch), "the emoji face must cover {what}");
        }

        // And it is emoji-only, which is why it is a fallback tier rather than
        // a family a caption could be set in.
        assert!(!face_covers(font, 'A'));
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
            role: bundled.role,
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
            role: registered.role,
            bytes: leak_font_bytes(b"not a font at all"),
        };

        assert!(!face_covers(&impostor, 'A'));
    }

    /// Feature: deterministic emoji burn-in
    /// Scenario: text one face draws end to end stays one run
    #[test]
    fn text_the_primary_face_covers_is_a_single_run() {
        let stack = caption_stack();

        assert_eq!(
            runs_of("Hello there.", &stack),
            vec![("Hello there.".to_string(), Some(DEFAULT_BUNDLED_FAMILY))]
        );
        assert!(stack.covers("Hello there."));
    }

    /// Feature: deterministic emoji burn-in
    /// Scenario: an emoji is lifted out into the face that can draw it
    #[test]
    fn an_emoji_between_words_becomes_its_own_run() {
        assert_eq!(
            runs_of("Hi \u{1F525} there", &caption_stack()),
            vec![
                ("Hi ".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
                ("\u{1F525}".to_string(), Some(EMOJI_FALLBACK_FAMILY)),
                (" there".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
            ],
            "the spaces belong to the words, not to the emoji face"
        );
    }

    /// Feature: deterministic emoji burn-in
    /// Scenario: a multi-codepoint emoji is never cut in half
    ///
    /// Each of these is several codepoints that render as one picture. A run
    /// boundary inside one would shape the pieces separately - four people
    /// instead of a family, two letters instead of a flag - and no
    /// substitution lookup could put them back together.
    #[test]
    fn a_multi_codepoint_emoji_stays_one_run() {
        let stack = caption_stack();

        for (sequence, what) in [
            (
                "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
                "a ZWJ family",
            ),
            ("\u{1F1FA}\u{1F1F8}", "a regional-indicator flag"),
            ("1\u{FE0F}\u{20E3}", "a keycap"),
            ("\u{1F44B}\u{1F3FF}", "a skin-tone modifier"),
            ("\u{2764}\u{FE0F}", "a VS16 presentation selector"),
            (
                "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
                "a tag-sequence subdivision flag",
            ),
        ] {
            assert_eq!(
                runs_of(sequence, &stack),
                vec![(sequence.to_string(), Some(EMOJI_FALLBACK_FAMILY))],
                "{what} must route whole to the emoji face"
            );
        }
    }

    /// Feature: deterministic caption burn-in
    /// Scenario: a script we bundle no face for is left to the host, unbroken
    ///
    /// libass shapes a run at a time, so a face change dropped into the middle
    /// of a Korean, Arabic or Thai sentence would break the shaping the host
    /// fallback does today. Nothing in the stack covers these, so every
    /// cluster - and the spaces between them - has to come back as one run
    /// with no family, which is the emitter's signal to write no face change
    /// at all.
    #[test]
    fn a_sentence_no_bundled_face_covers_stays_one_unbroken_run() {
        let stack = caption_stack();

        for (sentence, script) in [
            ("\u{C548}\u{B155} \u{D558}\u{C138}\u{C694}", "Hangul"),
            (
                "\u{645}\u{631}\u{62D}\u{628}\u{627} \u{628}\u{643}",
                "Arabic contextual forms",
            ),
            ("\u{E2A}\u{E27}\u{E31}\u{E2A}\u{E14}\u{E35}", "Thai"),
            ("\u{915}\u{94D}\u{937}\u{93F}", "a Devanagari conjunct"),
            ("\u{3053}\u{3093} \u{306B}\u{3061}\u{306F}", "Japanese kana"),
        ] {
            assert_eq!(
                runs_of(sentence, &stack),
                vec![(sentence.to_string(), None)],
                "{script} must reach libass as one run"
            );
            assert!(
                !stack.covers(sentence),
                "{script} still needs the host font set"
            );
        }
    }

    /// Feature: deterministic caption burn-in
    /// Scenario: a Latin word inside an RTL sentence splits where it should
    #[test]
    fn an_embedded_latin_word_splits_out_of_an_rtl_sentence() {
        // "مرحبا OpenReelio بك" - the spaces around the Latin word sit between
        // neighbours that disagree, so they fall to the primary rather than
        // dragging Arabic into it or Latin out of it.
        assert_eq!(
            runs_of(
                "\u{645}\u{631}\u{62D}\u{628}\u{627} OpenReelio \u{628}\u{643}",
                &caption_stack()
            ),
            vec![
                ("\u{645}\u{631}\u{62D}\u{628}\u{627}".to_string(), None),
                (" OpenReelio ".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
                ("\u{628}\u{643}".to_string(), None),
            ]
        );
    }

    /// Feature: deterministic caption burn-in
    /// Scenario: a combining mark never leaves the letter it belongs to
    #[test]
    fn a_combining_mark_stays_with_its_base_letter() {
        // "e" + combining acute, then a CRLF, which is itself one cluster.
        let runs = runs_of("cafe\u{301}\r\nnext", &caption_stack());

        assert_eq!(runs.len(), 1, "got: {runs:?}");
        assert_eq!(runs[0].0, "cafe\u{301}\r\nnext");
    }

    /// Feature: deterministic emoji burn-in
    /// Scenario: whitespace never decides which face is used
    #[test]
    fn whitespace_falls_to_the_primary_rather_than_to_a_fallback() {
        let stack = caption_stack();

        // Leading and trailing space around an emoji: no neighbour on one
        // side, so the space takes the style's own family.
        assert_eq!(
            runs_of(" \u{1F525} ", &stack),
            vec![
                (" ".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
                ("\u{1F525}".to_string(), Some(EMOJI_FALLBACK_FAMILY)),
                (" ".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
            ]
        );
        // A line of nothing but whitespace has no neighbours at all.
        assert_eq!(
            runs_of(" \t\n", &stack),
            vec![(" \t\n".to_string(), Some(DEFAULT_BUNDLED_FAMILY))]
        );
        assert!(
            stack.covers("Two\tlines\nof\u{00A0}text"),
            "a face with no glyph for a tab still renders the line"
        );
    }

    /// Feature: deterministic emoji burn-in
    /// Scenario: a space between two emoji is still measured in the text face
    ///
    /// Two emoji with a space between them is the product's own caption idiom,
    /// and both of the space's neighbours agree on the emoji face. Inheriting
    /// an agreement is right for the primary and for the unlabelled run a
    /// script we bundle no face for comes back as; it is wrong for a fallback,
    /// because Noto Emoji's space is 1.27 em against TikTok Sans' 0.218 em, so
    /// the gap would come out 5.8 times too wide and the line would wrap
    /// somewhere else.
    #[test]
    fn a_space_between_two_emoji_stays_on_the_primary() {
        let stack = caption_stack();

        assert_eq!(
            runs_of("\u{1F525} \u{1F525}", &stack),
            vec![
                ("\u{1F525}".to_string(), Some(EMOJI_FALLBACK_FAMILY)),
                (" ".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
                ("\u{1F525}".to_string(), Some(EMOJI_FALLBACK_FAMILY)),
            ]
        );
        assert_eq!(
            runs_of("\u{1F389} \u{1F38A} \u{1F388}", &stack),
            vec![
                ("\u{1F389}".to_string(), Some(EMOJI_FALLBACK_FAMILY)),
                (" ".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
                ("\u{1F38A}".to_string(), Some(EMOJI_FALLBACK_FAMILY)),
                (" ".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
                ("\u{1F388}".to_string(), Some(EMOJI_FALLBACK_FAMILY)),
            ]
        );
    }

    /// Feature: deterministic caption burn-in
    /// Scenario: a text-default symbol is not dragged into the emoji face
    ///
    /// Noto Emoji's `cmap` covers far more than the pictures it is bundled
    /// for: `▶`, `⏸`, `‼`, `ℹ`, `Ⓜ` and the rest of the text-default symbols
    /// that carry the `Emoji` property are all in it, drawn at emoji
    /// proportions. Routing by coverage alone gave `"▶ PLAY"` a triangle 1.27
    /// em wide and dropped `fontsdir` with it, so the host could not draw the
    /// symbol at text proportions any more. These belong to nothing in the
    /// stack, exactly as they did before the chain existed.
    #[test]
    fn a_text_default_symbol_is_left_to_the_host() {
        let stack = caption_stack();

        assert_eq!(
            runs_of("\u{25B6} PLAY", &stack),
            vec![
                ("\u{25B6}".to_string(), None),
                (" PLAY".to_string(), Some(DEFAULT_BUNDLED_FAMILY)),
            ],
            "the arrow is ordinary text, and the space belongs to the word"
        );
        assert!(
            !stack.covers("\u{25B6} PLAY"),
            "the graph has to keep fontsdir so the host can draw the arrow"
        );

        // The rest are symbols too. Which face draws one depends on whether the
        // Latin primary happens to carry it - `↔` does, `⏸` does not - and both
        // answers are right; what matters is that none of them is drawn at
        // emoji proportions.
        for symbol in [
            "\u{25C0}", "\u{23F8}", "\u{203C}", "\u{2049}", "\u{2139}", "\u{2194}", "\u{24C2}",
            "\u{25AA}", "\u{25AB}",
        ] {
            let runs = runs_of(symbol, &stack);
            assert_eq!(runs.len(), 1, "{symbol:?} is one cluster: {runs:?}");
            assert_ne!(
                runs[0].1,
                Some(EMOJI_FALLBACK_FAMILY),
                "{symbol:?} is a symbol, not a picture"
            );
        }

        // The same base with `U+FE0F` after it did ask for the picture, and an
        // emoji-presentation codepoint never needed to ask.
        assert_eq!(
            runs_of("\u{25B6}\u{FE0F}", &stack),
            vec![("\u{25B6}\u{FE0F}".to_string(), Some(EMOJI_FALLBACK_FAMILY))]
        );
        assert_eq!(
            runs_of("\u{1F525}", &stack),
            vec![("\u{1F525}".to_string(), Some(EMOJI_FALLBACK_FAMILY))]
        );
        assert!(stack.covers("\u{1F525}"));
    }

    /// Feature: deterministic caption burn-in
    /// Scenario: only a family the binary carries can head a chain
    #[test]
    fn a_caption_stack_needs_a_bundled_primary() {
        let bundled = caption_font_stack(DEFAULT_BUNDLED_FAMILY);
        assert_eq!(bundled.primary(), Some(DEFAULT_BUNDLED_FAMILY));
        assert!(bundled.covers("Ship it \u{1F389}"));

        let host = caption_font_stack("Comic Sans MS");
        assert!(
            host.is_empty(),
            "a family we do not ship must never promote the emoji face to primary"
        );
        assert!(!host.covers("Ship it \u{1F389}"));
    }

    /// Feature: deterministic emoji burn-in
    /// Scenario: the stack answers the coverage question the graph asks
    #[test]
    fn a_stack_covers_exactly_what_its_tiers_can_draw() {
        let stack = caption_stack();

        assert!(stack.covers("Latin and \u{1F525} emoji"));
        assert!(!stack.covers("mostly latin \u{C548}"));

        // Without the emoji tier the same caption needs the host again, which
        // is the whole difference this chain makes.
        let latin_only = FontStack::new(&[DEFAULT_BUNDLED_FAMILY]);
        assert!(!latin_only.covers("Latin and \u{1F525} emoji"));
        assert_eq!(
            runs_of("Latin and \u{1F525} emoji", &latin_only)
                .into_iter()
                .map(|(_, family)| family)
                .collect::<Vec<_>>(),
            vec![
                Some(DEFAULT_BUNDLED_FAMILY),
                None,
                Some(DEFAULT_BUNDLED_FAMILY)
            ]
        );
    }

    #[test]
    fn a_stack_reports_only_the_fallbacks_a_string_reaches() {
        let stack = caption_stack();

        assert!(stack.fallbacks_used("Hello there").is_empty());
        assert_eq!(
            stack.fallbacks_used("Hello \u{1F525}"),
            vec![EMOJI_FALLBACK_FAMILY]
        );
        assert!(
            stack.fallbacks_used("\u{C548}\u{B155}").is_empty(),
            "a run nothing covers names no face to embed"
        );
    }

    #[test]
    fn a_stack_drops_names_it_does_not_ship_and_repeats_of_ones_it_does() {
        let stack = FontStack::new(&[
            "Comic Sans MS",
            "  poppins ",
            "Poppins",
            EMOJI_FALLBACK_FAMILY,
        ]);

        assert_eq!(stack.primary(), Some("Poppins"));
        assert_eq!(
            stack.fallbacks_used("\u{1F525}"),
            vec![EMOJI_FALLBACK_FAMILY],
            "a name resolves case- and space-insensitively, once"
        );

        let nothing = FontStack::new(&["Comic Sans MS"]);
        assert!(nothing.is_empty());
        assert_eq!(nothing.primary(), None);
        assert_eq!(
            runs_of("Hello \u{1F525}", &nothing),
            vec![("Hello \u{1F525}".to_string(), None)],
            "an empty stack asks libass for nothing and leaves the text whole"
        );
        assert!(!nothing.covers("A"));
    }

    #[test]
    fn splitting_empty_text_produces_no_runs() {
        assert!(split_runs("", &caption_stack()).is_empty());
    }

    /// Feature: deterministic emoji burn-in
    /// Scenario: a cluster only routes to a face that draws all of it
    ///
    /// The tier test is per cluster, not per codepoint: a keycap's `1` is in
    /// the primary face and its enclosing combiner is not, so the cluster has
    /// to leave the primary as a whole rather than being cut at the boundary.
    #[test]
    fn a_partly_covered_cluster_does_not_stay_on_the_primary() {
        let stack = caption_stack();

        assert_eq!(
            runs_of("1", &stack),
            vec![("1".to_string(), Some(DEFAULT_BUNDLED_FAMILY))],
            "a bare digit is ordinary text"
        );
        assert_eq!(
            runs_of("1\u{FE0F}\u{20E3}", &stack),
            vec![("1\u{FE0F}\u{20E3}".to_string(), Some(EMOJI_FALLBACK_FAMILY))],
            "the same digit inside a keycap belongs to the emoji face"
        );
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
