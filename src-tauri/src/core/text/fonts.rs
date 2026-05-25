//! System font discovery for text editing.
//!
//! The editor stores font family names in project commands, while renderers
//! resolve those names at preview/export time. This module provides a lightweight
//! local catalog by reading TrueType/OpenType name tables from standard OS font
//! directories without pulling in a shaping engine.

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use walkdir::WalkDir;

const MAX_FONT_FILES_TO_SCAN: usize = 4096;
const MAX_FONT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_FONT_FAMILIES: &[&str] = &[
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

/// Returns installed font family names discovered from standard system folders.
pub fn list_system_font_families() -> Vec<String> {
    SYSTEM_FONT_FAMILY_CACHE
        .get_or_init(scan_system_font_families)
        .clone()
}

/// Returns standard OS font directories that currently exist.
pub fn system_font_directories() -> Vec<PathBuf> {
    font_search_directories()
        .into_iter()
        .filter(|directory| directory.is_dir())
        .collect()
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

    for family in DEFAULT_FONT_FAMILIES {
        families.insert((*family).to_string());
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

fn parse_font_families(bytes: &[u8]) -> Vec<String> {
    let mut families = BTreeSet::new();

    if bytes.starts_with(b"ttcf") {
        if bytes.len() < 12 {
            return Vec::new();
        }
        let font_count = read_u32(bytes, 8).unwrap_or(0).min(256);
        for index in 0..font_count as usize {
            let Some(offset) = read_u32(bytes, 12 + index * 4) else {
                continue;
            };
            parse_sfnt_font(bytes, offset as usize, &mut families);
        }
    } else {
        parse_sfnt_font(bytes, 0, &mut families);
    }

    families.into_iter().collect()
}

fn parse_sfnt_font(bytes: &[u8], font_offset: usize, families: &mut BTreeSet<String>) {
    if font_offset + 12 > bytes.len() {
        return;
    }

    let signature = &bytes[font_offset..font_offset + 4];
    if !matches!(signature, b"\x00\x01\x00\x00" | b"OTTO" | b"true" | b"typ1") {
        return;
    }

    let Some(table_count) = read_u16(bytes, font_offset + 4) else {
        return;
    };
    let record_start = font_offset + 12;
    for table_index in 0..table_count as usize {
        let record_offset = record_start + table_index * 16;
        if record_offset + 16 > bytes.len() {
            return;
        }

        if &bytes[record_offset..record_offset + 4] != b"name" {
            continue;
        }

        let Some(table_offset) = read_u32(bytes, record_offset + 8) else {
            continue;
        };
        let Some(table_length) = read_u32(bytes, record_offset + 12) else {
            continue;
        };

        parse_name_table(
            bytes,
            table_offset as usize,
            table_length as usize,
            families,
        );

        let relative_table_offset = font_offset.saturating_add(table_offset as usize);
        if relative_table_offset != table_offset as usize {
            parse_name_table(
                bytes,
                relative_table_offset,
                table_length as usize,
                families,
            );
        }
        return;
    }
}

fn parse_name_table(
    bytes: &[u8],
    table_offset: usize,
    table_length: usize,
    families: &mut BTreeSet<String>,
) {
    if table_offset + table_length > bytes.len() || table_length < 6 {
        return;
    }

    let Some(record_count) = read_u16(bytes, table_offset + 2) else {
        return;
    };
    let Some(storage_offset) = read_u16(bytes, table_offset + 4) else {
        return;
    };

    let storage_start = table_offset + storage_offset as usize;
    let table_end = table_offset + table_length;
    if storage_start > table_end {
        return;
    }

    for record_index in 0..record_count as usize {
        let record_offset = table_offset + 6 + record_index * 12;
        if record_offset + 12 > table_end {
            return;
        }

        let platform_id = read_u16(bytes, record_offset).unwrap_or(0);
        let encoding_id = read_u16(bytes, record_offset + 2).unwrap_or(0);
        let name_id = read_u16(bytes, record_offset + 6).unwrap_or(0);
        if name_id != 1 && name_id != 16 {
            continue;
        }

        let length = read_u16(bytes, record_offset + 8).unwrap_or(0) as usize;
        let string_offset = read_u16(bytes, record_offset + 10).unwrap_or(0) as usize;
        let string_start = storage_start + string_offset;
        let string_end = string_start + length;
        if string_start > table_end || string_end > table_end {
            continue;
        }

        if let Some(family) =
            decode_font_name(platform_id, encoding_id, &bytes[string_start..string_end])
        {
            families.insert(family);
        }
    }
}

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

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|chunk| u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
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

    fn make_test_font(family: &str) -> Vec<u8> {
        let family_utf16 = family
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect::<Vec<_>>();
        let name_table_offset = 28u32;
        let name_table_length = 18u32 + family_utf16.len() as u32;

        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x00\x01\x00\x00");
        push_u16(&mut bytes, 1);
        push_u16(&mut bytes, 16);
        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, 16);

        bytes.extend_from_slice(b"name");
        push_u32(&mut bytes, 0);
        push_u32(&mut bytes, name_table_offset);
        push_u32(&mut bytes, name_table_length);

        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, 1);
        push_u16(&mut bytes, 18);
        push_u16(&mut bytes, 3);
        push_u16(&mut bytes, 1);
        push_u16(&mut bytes, 0x0409);
        push_u16(&mut bytes, 1);
        push_u16(&mut bytes, family_utf16.len() as u16);
        push_u16(&mut bytes, 0);
        bytes.extend_from_slice(&family_utf16);
        bytes
    }

    #[test]
    fn parse_font_families_reads_true_type_name_table() {
        assert_eq!(
            parse_font_families(&make_test_font("OpenReelio Sans")),
            vec!["OpenReelio Sans".to_string()]
        );
    }

    #[test]
    fn parse_font_families_deduplicates_ttc_members() {
        let font = make_test_font("OpenReelio Sans");
        let first_offset = 20u32;
        let second_offset = first_offset + font.len() as u32;

        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"ttcf");
        push_u32(&mut bytes, 0x0001_0000);
        push_u32(&mut bytes, 2);
        push_u32(&mut bytes, first_offset);
        push_u32(&mut bytes, second_offset);
        bytes.extend_from_slice(&font);
        bytes.extend_from_slice(&font);

        assert_eq!(
            parse_font_families(&bytes),
            vec!["OpenReelio Sans".to_string()]
        );
    }

    #[test]
    fn decode_font_name_does_not_treat_mac_encoding_one_as_utf16() {
        assert_eq!(
            decode_font_name(1, 1, b"MacSans"),
            Some("MacSans".to_string())
        );
    }
}
