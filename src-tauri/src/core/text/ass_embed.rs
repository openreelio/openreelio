//! Encoder for the ASS `[Fonts]` section.
//!
//! SSA stores attached fonts in a uuencode-*like* dialect that is neither
//! base64 nor real uuencode: three bytes become four characters, each
//! character carrying six bits offset by 33, and no line carries a length
//! prefix. libass decodes it in `decode_chars`/`decode_font` (`ass.c`), and a
//! partial trailing group is decoded by dropping the bytes the missing
//! characters would have supplied - so a one-byte tail is written as two
//! characters and a two-byte tail as three.
//!
//! Lines are wrapped at 80 characters because libass rejects a `[Fonts]` line
//! longer than that outright. 80 is not a multiple of 4 on purpose: the decoder
//! concatenates every line of a font before decoding, so groups are free to
//! straddle a line break.

/// Bit offset every encoded character carries, per the SSA dialect.
const CHAR_OFFSET: u8 = 33;

/// Maximum characters libass accepts on one `[Fonts]` line.
const LINE_WIDTH: usize = 80;

/// Encodes font bytes into the character stream an ASS `[Fonts]` section holds.
///
/// The returned string is newline-separated and has no trailing newline.
pub fn encode_font_data(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for group in bytes.chunks(3) {
        // Pad the group out to 24 bits, then emit only the characters those
        // bits actually fill: 4 for three bytes, 3 for two, 2 for one.
        let mut word = 0u32;
        for (index, byte) in group.iter().enumerate() {
            word |= u32::from(*byte) << (16 - index * 8);
        }

        let character_count = match group.len() {
            1 => 2,
            2 => 3,
            _ => 4,
        };

        for index in 0..character_count {
            let six_bits = ((word >> (18 - index * 6)) & 0x3F) as u8;
            encoded.push((six_bits + CHAR_OFFSET) as char);
        }
    }

    wrap_lines(&encoded)
}

fn wrap_lines(encoded: &str) -> String {
    let mut wrapped = String::with_capacity(encoded.len() + encoded.len() / LINE_WIDTH + 1);

    for (index, chunk) in encoded
        .as_bytes()
        .chunks(LINE_WIDTH)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .enumerate()
    {
        if index > 0 {
            wrapped.push('\n');
        }
        wrapped.push_str(chunk);
    }

    wrapped
}

/// Renders one attached font as the `fontname:` header plus its encoded body.
///
/// The `_0` suffix is the SSA convention for the first face of an attachment.
/// libass matches embedded fonts through their own `name` table rather than
/// this label, so it only has to be stable, not meaningful.
pub fn encode_attached_font(file_name: &str, bytes: &[u8]) -> String {
    let sanitized: String = file_name
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_control())
        .collect();

    format!("fontname: {sanitized}_0.ttf\n{}\n", encode_font_data(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// libass's decoder, re-implemented from `decode_chars`/`decode_font`.
    ///
    /// Written as the inverse of the encoder under test rather than reusing any
    /// of its helpers, so a shared mistake cannot cancel itself out.
    fn libass_decode(encoded: &str) -> Vec<u8> {
        let characters: Vec<u8> = encoded
            .chars()
            .filter(|ch| *ch != '\n' && *ch != '\r')
            .map(|ch| ch as u8)
            .collect();

        let decode_chars = |c1: u8, c2: u8, c3: u8, c4: u8| -> [u8; 3] {
            let value = (u32::from(c1.wrapping_sub(CHAR_OFFSET)) << 18)
                | (u32::from(c2.wrapping_sub(CHAR_OFFSET)) << 12)
                | (u32::from(c3.wrapping_sub(CHAR_OFFSET)) << 6)
                | u32::from(c4.wrapping_sub(CHAR_OFFSET));
            [
                (value >> 16) as u8,
                ((value >> 8) & 0xFF) as u8,
                (value & 0xFF) as u8,
            ]
        };

        let size = characters.len();
        let mut decoded = Vec::with_capacity(size / 4 * 3);

        for group in characters.chunks_exact(4) {
            decoded.extend_from_slice(&decode_chars(group[0], group[1], group[2], group[3]));
        }

        let tail_start = size / 4 * 4;
        match size % 4 {
            // libass decodes the padded group, then discards the bytes the
            // missing characters never described.
            2 => {
                let full = decode_chars(characters[tail_start], characters[tail_start + 1], 0, 0);
                decoded.extend_from_slice(&full[..1]);
            }
            3 => {
                let full = decode_chars(
                    characters[tail_start],
                    characters[tail_start + 1],
                    characters[tail_start + 2],
                    0,
                );
                decoded.extend_from_slice(&full[..2]);
            }
            _ => {}
        }

        decoded
    }

    fn pseudo_random_bytes(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (state >> 33) as u8
            })
            .collect()
    }

    #[test]
    fn encoded_font_data_round_trips_through_the_libass_decoder() {
        // Every tail length, plus sizes that straddle the 80-character wrap.
        for len in [
            0, 1, 2, 3, 4, 5, 6, 7, 59, 60, 61, 119, 120, 121, 4096, 4097,
        ] {
            let original = pseudo_random_bytes(len, len as u64 + 7);
            let encoded = encode_font_data(&original);
            assert_eq!(
                libass_decode(&encoded),
                original,
                "round trip failed for {len} bytes"
            );
        }
    }

    #[test]
    fn encoded_font_data_round_trips_for_byte_values_at_the_extremes() {
        for original in [
            vec![0x00],
            vec![0xFF],
            vec![0x00, 0x00],
            vec![0xFF, 0xFF],
            vec![0x00, 0xFF, 0x00],
            vec![0xFF, 0x00, 0xFF],
            (0u8..=255).collect::<Vec<u8>>(),
        ] {
            let encoded = encode_font_data(&original);
            assert_eq!(libass_decode(&encoded), original);
        }
    }

    #[test]
    fn encoded_characters_stay_inside_the_range_libass_reads() {
        let encoded = encode_font_data(&(0u8..=255).collect::<Vec<u8>>());
        for ch in encoded.chars().filter(|ch| *ch != '\n') {
            let value = ch as u32;
            assert!(
                (33..=96).contains(&value),
                "character {ch:?} ({value}) is outside the 6-bit + 33 range"
            );
        }
    }

    #[test]
    fn no_encoded_line_exceeds_the_libass_line_limit() {
        let encoded = encode_font_data(&pseudo_random_bytes(9001, 3));
        let lines: Vec<&str> = encoded.split('\n').collect();
        assert!(lines.len() > 1, "expected the body to wrap");
        for line in &lines {
            assert!(
                line.len() <= LINE_WIDTH,
                "line of {} characters exceeds the {LINE_WIDTH}-character limit",
                line.len()
            );
        }
        for line in &lines[..lines.len() - 1] {
            assert_eq!(line.len(), LINE_WIDTH, "only the last line may be short");
        }
    }

    #[test]
    fn attached_font_carries_a_fontname_header_and_a_terminated_body() {
        let attached = encode_attached_font("Bebas Neue", &pseudo_random_bytes(10, 11));
        let mut lines = attached.lines();
        assert_eq!(lines.next(), Some("fontname: BebasNeue_0.ttf"));
        assert!(attached.ends_with('\n'));
        assert_eq!(
            libass_decode(&attached["fontname: BebasNeue_0.ttf\n".len()..]),
            pseudo_random_bytes(10, 11)
        );
    }

    #[test]
    fn a_bundled_font_round_trips_byte_for_byte() {
        let font = super::super::bundled_fonts::resolve_bundled("Bebas Neue").expect("bundled");
        assert_eq!(libass_decode(&encode_font_data(font.bytes)), font.bytes);
    }
}
