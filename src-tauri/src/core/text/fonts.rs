//! System font discovery for text editing.
//!
//! The editor stores font family names in project commands, while renderers
//! resolve those names at preview/export time. This module provides a lightweight
//! local catalog by reading TrueType/OpenType name tables from standard OS font
//! directories without pulling in a shaping engine.
//!
//! `ttf-parser` locates and bounds-checks the tables. Every question about a
//! font's identity - the catalog's family names and [`font_face_info`]'s
//! libass-facing fields alike - goes through [`for_each_face_name`], so no two
//! call sites can disagree about what a file declares.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use ttf_parser::{name, name_id, os2, PlatformId, RawFace, Tag};
use walkdir::WalkDir;

const MAX_FONT_FILES_TO_SCAN: usize = 4096;
const MAX_FONT_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Families a font picker offers whether or not this host has them.
///
/// These are suggestions, not facts. The list used to be folded into the
/// scanned catalog, which made [`system_font_family_installed`] answer `true`
/// for every name in it on every machine - so `"Arial"`, the family every
/// caption pack and every text default asks for, looked installed on a Linux
/// box that has never seen it and the renderer took the host-font path instead
/// of embedding a face. Keeping the two apart is what makes the burn-in
/// reproducible: only [`list_font_picker_suggestions`] may read this.
const FONT_PICKER_SUGGESTIONS: &[&str] = &[
    "Arial",
    "Helvetica",
    "Verdana",
    "Inter",
    "Roboto",
    "Noto Sans",
    "Noto Sans KR",
    "Pretendard",
    "Apple SD Gothic Neo",
    "Malgun Gothic",
    "Nanum Gothic",
    "Georgia",
    "Times New Roman",
    "Courier New",
    "Impact",
    "Montserrat",
    "Poppins",
    "Oswald",
];

static SYSTEM_FONT_FAMILY_CACHE: OnceLock<Vec<String>> = OnceLock::new();

/// `head` `macStyle` bit 0: the face declares itself bold.
///
/// Read by hand because `ttf-parser` skips `macStyle` while parsing `head`, and
/// libass consults it alongside the `OS/2` bit when it ranks a family's weights.
const MAC_STYLE_BOLD: u16 = 1 << 0;

/// Byte offset of `macStyle` within the `head` table.
const HEAD_MAC_STYLE_OFFSET: usize = 44;

/// Upper bound on the faces read out of one font collection.
///
/// A `ttcf` header can claim any member count; capping it keeps a corrupt or
/// hostile file from turning directory scanning into an unbounded parse.
const MAX_COLLECTION_FACES: u32 = 256;

/// Returns the cached catalog of installed font family names.
fn system_font_families() -> &'static [String] {
    SYSTEM_FONT_FAMILY_CACHE.get_or_init(scan_system_font_families)
}

/// Returns the families a font picker should offer.
///
/// Everything this host actually has, plus [`FONT_PICKER_SUGGESTIONS`] so the
/// dropdown still names the families a project is likely to carry. A name that
/// came only from the suggestion list is *not* a claim that the font is
/// installed - ask [`system_font_family_installed`] for that.
///
/// This copies the whole catalog, which on a well-stocked machine is thousands
/// of names. Callers that only need a membership test should use
/// [`system_font_family_installed`] instead - export validation asks once per
/// text clip, and a copy per question is pure waste.
pub fn list_font_picker_suggestions() -> Vec<String> {
    merge_picker_suggestions(system_font_families())
}

/// Returns the family names this host genuinely has installed.
///
/// The scanned catalog with nothing added. Ask this when the answer has to be
/// a fact about the machine; ask [`list_font_picker_suggestions`] when it only
/// has to fill a dropdown.
pub fn list_installed_font_families() -> Vec<String> {
    system_font_families().to_vec()
}

/// Returns whether `family` names a font installed on this host, ignoring case.
///
/// Reads only the scanned catalog. The renderer branches on this to decide
/// between embedding a face and letting libass resolve one, so a name that is
/// merely *offered* by the picker must never answer `true` here.
pub fn system_font_family_installed(family: &str) -> bool {
    catalog_contains_family(system_font_families(), family)
}

/// Returns whether `catalog` holds `family`, ignoring case and surrounding space.
fn catalog_contains_family(catalog: &[String], family: &str) -> bool {
    let family = family.trim();

    catalog
        .iter()
        .any(|installed| installed.eq_ignore_ascii_case(family))
}

/// Returns `installed` widened with the suggestion list, sorted and deduplicated.
fn merge_picker_suggestions(installed: &[String]) -> Vec<String> {
    let mut families: BTreeSet<String> = installed.iter().cloned().collect();

    for family in FONT_PICKER_SUGGESTIONS {
        if !catalog_contains_family(installed, family) {
            families.insert((*family).to_string());
        }
    }

    families.into_iter().collect()
}

/// Returns standard OS font directories that currently exist.
pub fn system_font_directories() -> Vec<PathBuf> {
    font_search_directories()
        .into_iter()
        .filter(|directory| directory.is_dir())
        .collect()
}

/// Returns the platform's primary font folder, falling back to any that exists.
///
/// Callers that can only name one directory - the FFmpeg `subtitles` filter's
/// `fontsdir` among them - need a deterministic choice rather than whichever
/// path happens to sort first.
pub fn primary_system_font_directory() -> Option<PathBuf> {
    let directories = system_font_directories();

    #[cfg(target_os = "windows")]
    let preferred = std::env::var("WINDIR")
        .ok()
        .map(|windir| PathBuf::from(windir).join("Fonts"));

    #[cfg(target_os = "macos")]
    let preferred = Some(PathBuf::from("/System/Library/Fonts"));

    #[cfg(all(unix, not(target_os = "macos")))]
    let preferred = Some(PathBuf::from("/usr/share/fonts"));

    if let Some(preferred) = preferred {
        if directories.contains(&preferred) {
            return Some(preferred);
        }
    }

    directories.into_iter().next()
}

fn scan_system_font_families() -> Vec<String> {
    let mut families = BTreeSet::new();
    let mut scanned_files = 0usize;

    for directory in font_search_directories() {
        if scanned_files >= MAX_FONT_FILES_TO_SCAN {
            break;
        }

        scan_font_directory(&directory, &mut families, &mut scanned_files);
    }

    families.into_iter().collect()
}

fn font_search_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(windir) = std::env::var("WINDIR") {
            directories.push(PathBuf::from(windir).join("Fonts"));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            directories.push(
                PathBuf::from(local_app_data)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        directories.push(PathBuf::from("/System/Library/Fonts"));
        directories.push(PathBuf::from("/Library/Fonts"));
        if let Some(home) = dirs::home_dir() {
            directories.push(home.join("Library").join("Fonts"));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        directories.push(PathBuf::from("/usr/share/fonts"));
        directories.push(PathBuf::from("/usr/local/share/fonts"));
        if let Some(home) = dirs::home_dir() {
            directories.push(home.join(".fonts"));
            directories.push(home.join(".local").join("share").join("fonts"));
        }
    }

    directories.sort();
    directories.dedup();
    directories
}

fn scan_font_directory(
    directory: &Path,
    families: &mut BTreeSet<String>,
    scanned_files: &mut usize,
) {
    if !directory.is_dir() {
        return;
    }

    let walker = WalkDir::new(directory)
        .follow_links(true)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file());

    for entry in walker {
        if *scanned_files >= MAX_FONT_FILES_TO_SCAN {
            return;
        }

        let path = entry.path();
        if !is_supported_font_path(path) {
            continue;
        }

        *scanned_files += 1;
        if let Ok(metadata) = entry.metadata() {
            if metadata.len() > MAX_FONT_FILE_BYTES {
                continue;
            }
        }

        let Ok(bytes) = fs::read(path) else {
            continue;
        };

        for family in parse_font_families(&bytes) {
            families.insert(family);
        }
    }
}

fn is_supported_font_path(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };

    matches!(
        extension.to_ascii_lowercase().as_str(),
        "ttf" | "otf" | "ttc" | "otc"
    )
}

/// Returns the family names declared by an in-memory TrueType/OpenType font.
///
/// Exposed so the bundled font registry can index a compiled-in font by the
/// names it actually answers to, rather than only by the name this codebase
/// happens to label it with.
pub fn font_family_names(bytes: &[u8]) -> Vec<String> {
    parse_font_families(bytes)
}

/// The identity a font declares, split by the fields a matcher reads.
///
/// The split matters because libass does not treat these interchangeably: it
/// matches a requested family against `name` ID 1 and `name` ID 4 only, and
/// decides whether a face is bold from the `OS/2` and `head` bold bits rather
/// than from the subfamily string. A face whose only spelling of its family
/// lives in ID 16 is unreachable by that name however correct ID 16 looks, and
/// a bold face with the bits unset can never win a bold request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FontFaceInfo {
    /// `name` ID 1 - the family name.
    pub family_names: Vec<String>,
    /// `name` ID 4 - the full name.
    pub full_names: Vec<String>,
    /// `name` ID 16 - the typographic family. libass never reads this.
    pub typographic_family_names: Vec<String>,
    /// `OS/2` `usWeightClass`, if the table is readable.
    pub weight_class: Option<u16>,
    /// `OS/2` `fsSelection` bit 5.
    pub fs_selection_bold: bool,
    /// `head` `macStyle` bit 0.
    pub mac_style_bold: bool,
}

impl FontFaceInfo {
    /// Returns whether `family` is a name libass can match this face by.
    pub fn matches_family(&self, family: &str) -> bool {
        let family = family.trim();

        self.family_names
            .iter()
            .chain(&self.full_names)
            .any(|name| name.eq_ignore_ascii_case(family))
    }

    /// Returns whether both bold bits are set.
    pub fn declares_bold(&self) -> bool {
        self.fs_selection_bold && self.mac_style_bold
    }
}

/// Reads the name-table identity and weight bits of an in-memory font.
///
/// Reads the first face of a collection, matching what a renderer handed the
/// file without an index would resolve.
pub fn font_face_info(bytes: &[u8]) -> FontFaceInfo {
    let mut info = FontFaceInfo::default();

    let Ok(face) = RawFace::parse(bytes, 0) else {
        return info;
    };

    for_each_face_name(&face, |name_id, name| {
        let bucket = match name_id {
            name_id::FAMILY => &mut info.family_names,
            name_id::FULL_NAME => &mut info.full_names,
            name_id::TYPOGRAPHIC_FAMILY => &mut info.typographic_family_names,
            _ => return,
        };
        if !bucket.contains(&name) {
            bucket.push(name);
        }
    });

    if let Some(os2) = face_table(&face, b"OS/2").and_then(os2::Table::parse) {
        info.weight_class = Some(os2.weight().to_number());
        info.fs_selection_bold = os2.is_bold();
    }

    info.mac_style_bold = face_table(&face, b"head")
        .and_then(|head| read_u16(head, HEAD_MAC_STYLE_OFFSET))
        .is_some_and(|bits| bits & MAC_STYLE_BOLD != 0);

    info
}

/// Returns the raw bytes of `tag`'s table in `face`.
fn face_table<'a>(face: &RawFace<'a>, tag: &[u8; 4]) -> Option<&'a [u8]> {
    face.table(Tag::from_bytes(tag))
}

/// Returns how many faces `bytes` holds - a collection's members, or the one
/// face of a plain font file.
fn face_count(bytes: &[u8]) -> u32 {
    ttf_parser::fonts_in_collection(bytes)
        .unwrap_or(1)
        .min(MAX_COLLECTION_FACES)
}

/// Calls `visit` with every decodable `(name ID, value)` pair of one face.
///
/// Walks the records by index instead of iterating the table. `NamesIter`
/// signals a record it cannot decode - an unknown platform ID, a string offset
/// that runs past the storage area - by yielding `None`, which *ends* a `for`
/// loop rather than skipping that record. One malformed entry would therefore
/// hide every entry after it, and the Windows family name a font declares
/// usually sits behind the Macintosh records that precede it.
fn for_each_face_name(face: &RawFace<'_>, mut visit: impl FnMut(u16, String)) {
    let Some(table) = face_table(face, b"name").and_then(name::Table::parse) else {
        return;
    };

    let names = table.names;
    for index in 0..names.len() {
        let Some(record) = names.get(index) else {
            continue;
        };

        if let Some(value) = decode_font_name(
            platform_id_number(record.platform_id),
            record.encoding_id,
            record.name,
        ) {
            visit(record.name_id, value);
        }
    }
}

/// Returns the on-disk number of a parsed platform ID.
///
/// `decode_font_name` picks an encoding from the raw pair a `name` record
/// stores, so the enum has to go back to the number it was read from.
fn platform_id_number(platform_id: PlatformId) -> u16 {
    match platform_id {
        PlatformId::Unicode => 0,
        PlatformId::Macintosh => 1,
        PlatformId::Iso => 2,
        PlatformId::Windows => 3,
        PlatformId::Custom => 4,
    }
}

fn parse_font_families(bytes: &[u8]) -> Vec<String> {
    let mut families = BTreeSet::new();

    for index in 0..face_count(bytes) {
        let Ok(face) = RawFace::parse(bytes, index) else {
            continue;
        };

        for_each_face_name(&face, |name_id, name| {
            if name_id == name_id::FAMILY || name_id == name_id::TYPOGRAPHIC_FAMILY {
                families.insert(name);
            }
        });
    }

    families.into_iter().collect()
}

/// Decodes one `name` record's bytes.
///
/// `ttf-parser` decodes only Unicode-platform records and drops every other
/// one, which would lose the Macintosh-platform names that are still the only
/// spelling some installed fonts carry - so the encoding choice stays here.
fn decode_font_name(platform_id: u16, encoding_id: u16, bytes: &[u8]) -> Option<String> {
    let is_utf16_name =
        platform_id == 0 || (platform_id == 3 && (encoding_id == 1 || encoding_id == 10));
    let decoded = if is_utf16_name {
        if !bytes.len().is_multiple_of(2) {
            return None;
        }
        let units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units).ok()?
    } else {
        String::from_utf8_lossy(bytes).to_string()
    };

    normalize_family_name(&decoded)
}

fn normalize_family_name(value: &str) -> Option<String> {
    let family = value
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .to_string();

    if family.is_empty() {
        return None;
    }

    Some(family)
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes
        .get(offset..offset + 2)
        .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_u16(bytes: &mut Vec<u8>, value: u16) {
        bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn push_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_be_bytes());
    }

    /// Byte offset of the `name` table record's `offset` field in a font built
    /// by [`make_test_font`]: 12-byte header, then tag (4) and checksum (4).
    const TEST_NAME_RECORD_OFFSET_FIELD: usize = 20;

    /// Byte offset of the `name` table inside a font built by
    /// [`make_test_font`]: 12-byte header plus one 16-byte table record.
    const TEST_NAME_TABLE_OFFSET: u32 = 28;

    /// Byte length of a `name` table header: format, count, storage offset.
    const NAME_TABLE_HEADER_LEN: u16 = 6;

    /// Byte length of one `name` table record.
    const NAME_RECORD_LEN: u16 = 12;

    /// One record to write into a fixture's `name` table.
    ///
    /// The value is always stored as UTF-16BE, whatever `platform_id` says, so
    /// a record can be given a platform the reader is expected to reject
    /// without the fixture having to model that platform's encoding too.
    struct TestNameRecord<'a> {
        platform_id: u16,
        encoding_id: u16,
        name_id: u16,
        value: &'a str,
    }

    /// Builds a single-face font whose only table is the given `name` records.
    fn make_test_font_with_names(records: &[TestNameRecord<'_>]) -> Vec<u8> {
        let storage_offset = NAME_TABLE_HEADER_LEN + NAME_RECORD_LEN * records.len() as u16;

        let mut record_bytes = Vec::new();
        let mut storage: Vec<u8> = Vec::new();
        for record in records {
            let value = record
                .value
                .encode_utf16()
                .flat_map(u16::to_be_bytes)
                .collect::<Vec<_>>();

            push_u16(&mut record_bytes, record.platform_id);
            push_u16(&mut record_bytes, record.encoding_id);
            push_u16(&mut record_bytes, 0x0409);
            push_u16(&mut record_bytes, record.name_id);
            push_u16(&mut record_bytes, value.len() as u16);
            push_u16(&mut record_bytes, storage.len() as u16);
            storage.extend_from_slice(&value);
        }

        let name_table_length = u32::from(storage_offset) + storage.len() as u32;

        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x00\x01\x00\x00");
        push_u16(&mut bytes, 1);
        push_u16(&mut bytes, 16);
        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, 16);

        bytes.extend_from_slice(b"name");
        push_u32(&mut bytes, 0);
        push_u32(&mut bytes, TEST_NAME_TABLE_OFFSET);
        push_u32(&mut bytes, name_table_length);

        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, records.len() as u16);
        push_u16(&mut bytes, storage_offset);
        bytes.extend_from_slice(&record_bytes);
        bytes.extend_from_slice(&storage);
        bytes
    }

    fn make_test_font(family: &str) -> Vec<u8> {
        make_test_font_with_names(&[TestNameRecord {
            platform_id: 3,
            encoding_id: 1,
            name_id: name_id::FAMILY,
            value: family,
        }])
    }

    #[test]
    fn parse_font_families_reads_true_type_name_table() {
        assert_eq!(
            parse_font_families(&make_test_font("OpenReelio Sans")),
            vec!["OpenReelio Sans".to_string()]
        );
    }

    #[test]
    fn parse_font_families_skips_an_undecodable_record_and_keeps_reading() {
        // Platform ID 9 is not one `ttf-parser` knows, so the record fails to
        // parse and the table iterator reports the end of the list there.
        // Reading past it is what keeps the Windows family name - which real
        // fonts place after their Macintosh records - visible.
        let bytes = make_test_font_with_names(&[
            TestNameRecord {
                platform_id: 9,
                encoding_id: 0,
                name_id: name_id::FAMILY,
                value: "Unreadable Platform",
            },
            TestNameRecord {
                platform_id: 3,
                encoding_id: 1,
                name_id: name_id::FAMILY,
                value: "OpenReelio Sans",
            },
        ]);

        assert_eq!(
            parse_font_families(&bytes),
            vec!["OpenReelio Sans".to_string()]
        );
    }

    /// Packs `members` into a `ttcf` collection.
    ///
    /// A collection's table records hold offsets from the start of the file,
    /// not from the start of the member, so each member's `name` record is
    /// rebased as it is placed. Emitting member-relative offsets instead would
    /// make the fixture a malformed collection no conforming parser can read.
    fn make_test_collection(members: &[Vec<u8>]) -> Vec<u8> {
        let header_length = 12 + 4 * members.len();

        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"ttcf");
        push_u32(&mut bytes, 0x0001_0000);
        push_u32(&mut bytes, members.len() as u32);

        let mut member_offset = header_length as u32;
        for member in members {
            push_u32(&mut bytes, member_offset);
            member_offset += member.len() as u32;
        }

        for member in members {
            let base = bytes.len() as u32;
            let mut member = member.clone();
            let field = TEST_NAME_RECORD_OFFSET_FIELD;
            member[field..field + 4]
                .copy_from_slice(&(base + TEST_NAME_TABLE_OFFSET).to_be_bytes());
            bytes.extend_from_slice(&member);
        }

        bytes
    }

    #[test]
    fn parse_font_families_reads_each_ttc_member_at_its_own_offset() {
        // Distinct families on purpose: with the same family in both members
        // this would still pass if the parser read member 0 twice, which is
        // exactly the per-member offset resolution it is meant to pin.
        let bytes = make_test_collection(&[
            make_test_font("OpenReelio Sans"),
            make_test_font("OpenReelio Serif"),
        ]);

        assert_eq!(
            parse_font_families(&bytes),
            vec![
                "OpenReelio Sans".to_string(),
                "OpenReelio Serif".to_string()
            ]
        );
    }

    #[test]
    fn parse_font_families_deduplicates_ttc_members() {
        let font = make_test_font("OpenReelio Sans");
        let bytes = make_test_collection(&[font.clone(), font]);

        assert_eq!(
            parse_font_families(&bytes),
            vec!["OpenReelio Sans".to_string()]
        );
    }

    /// Feature: deterministic caption burn-in
    /// Scenario: a picker suggestion is not evidence that the font is installed
    ///
    /// The suggestion list used to be folded into the scanned catalog, so
    /// `system_font_family_installed("Arial")` answered `true` on a machine
    /// with no Arial. The renderer reads that answer to decide whether to embed
    /// a face, so the whole default caption path silently fell through to
    /// whatever font the host happened to rank first.
    #[test]
    fn a_picker_suggestion_is_not_reported_as_installed() {
        let installed = vec!["Only Installed Family".to_string()];

        for family in FONT_PICKER_SUGGESTIONS {
            assert!(
                !catalog_contains_family(&installed, family),
                "{family} is a suggestion, not an installed font"
            );
        }
    }

    #[test]
    fn the_picker_offers_the_suggestions_on_top_of_what_is_installed() {
        let installed = vec!["Only Installed Family".to_string()];
        let suggestions = merge_picker_suggestions(&installed);

        assert!(suggestions.contains(&"Only Installed Family".to_string()));
        for family in FONT_PICKER_SUGGESTIONS {
            assert!(
                suggestions.contains(&(*family).to_string()),
                "the picker must still offer {family}"
            );
        }
    }

    #[test]
    fn the_picker_does_not_list_an_installed_family_twice() {
        // The scan reports the host's own spelling; the suggestion list carries
        // a canonical one. Matching case-insensitively keeps "arial" and
        // "Arial" from both reaching the dropdown.
        let installed = vec!["arial".to_string()];
        let suggestions = merge_picker_suggestions(&installed);

        assert_eq!(
            suggestions
                .iter()
                .filter(|family| family.eq_ignore_ascii_case("Arial"))
                .count(),
            1,
            "got: {suggestions:?}"
        );
    }

    #[test]
    fn catalog_membership_ignores_case_and_surrounding_space() {
        let installed = vec!["OpenReelio Sans".to_string()];

        assert!(catalog_contains_family(&installed, "  openreelio sans "));
        assert!(!catalog_contains_family(&installed, "OpenReelio Serif"));
    }

    #[test]
    fn decode_font_name_does_not_treat_mac_encoding_one_as_utf16() {
        assert_eq!(
            decode_font_name(1, 1, b"MacSans"),
            Some("MacSans".to_string())
        );
    }
}
