#!/usr/bin/env python3
"""Rebuilds the static font instances bundled for caption burn-in.

Two of the families the caption presets use ship upstream only as variable
fonts. libass cannot read a variable font's named instances: it matches a
requested family against `name` ID 1 (family) and `name` ID 4 (full name) and
nothing else, and it decides "is this face bold" from the `OS/2` `fsSelection`
bold bit and the `head` `macStyle` bold bit. A default instancer run leaves
the family in `name` ID 16 and the weight in ID 17, which libass never reads,
so the face is unreachable by the name the ASS `Style` line asks for.

This script pins each variable font to one design location and then rewrites
the name table and the weight bits so every produced face answers to the exact
family name `src-tauri/src/core/text/bundled_fonts.rs` declares for it.

Run it from the repository root:

    python scripts/instance-bundled-fonts.py

It overwrites the four files under `src-tauri/fonts/` listed in `TARGETS`.
The other bundled families ship upstream as single static faces whose name
tables are already correct, so they are copied verbatim from Google Fonts and
are not regenerated here.

Written against fontTools 4.60.1 (`pip install "fonttools==4.60.1"`); the
`varLib.instancer` API used below is stable from 4.20 onwards.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from fontTools import version as fonttools_version
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# Upstream variable fonts, pinned to the `main` branch of google/fonts. Both are
# SIL Open Font License 1.1; see `THIRD_PARTY_NOTICES.md`.
MONTSERRAT_URL = (
    "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/"
    "Montserrat%5Bwght%5D.ttf"
)
TIKTOK_SANS_URL = (
    "https://raw.githubusercontent.com/google/fonts/main/ofl/tiktoksans/"
    "TikTokSans%5Bopsz,slnt,wdth,wght%5D.ttf"
)

# `OS/2` `fsSelection` bits and the `head` `macStyle` bit libass reads.
FS_SELECTION_ITALIC = 1 << 0
FS_SELECTION_BOLD = 1 << 5
FS_SELECTION_REGULAR = 1 << 6
MAC_STYLE_BOLD = 1 << 0

# Windows/Unicode BMP/US English, the record every name we write targets.
WINDOWS_PLATFORM_ID = 3
WINDOWS_ENCODING_ID = 1
WINDOWS_LANGUAGE_ID = 0x0409


@dataclass(frozen=True)
class Target:
    """One static face to produce from a variable source."""

    source_url: str
    source_name: str
    output: str
    #: Design location every axis is pinned to. Pinning all of them drops
    #: `fvar`/`STAT`, which is what makes the result a plain static face.
    location: dict[str, float] = field(default_factory=dict)
    #: `name` ID 1. The family libass matches an ASS `Style` `Fontname` against.
    family: str = ""
    #: `name` ID 2. Kept to the four RIBBI spellings so ID 16/17 can be dropped.
    subfamily: str = "Regular"
    #: `name` ID 4. libass matches this too, so it must stay a superset of the
    #: family name rather than carrying an optical-size qualifier.
    full_name: str = ""
    #: `name` ID 6, the PostScript name.
    postscript_name: str = ""
    #: `OS/2` `usWeightClass`, and whether the bold bits are set.
    weight_class: int = 400
    bold: bool = False


TARGETS: tuple[Target, ...] = (
    Target(
        source_url=TIKTOK_SANS_URL,
        source_name="TikTokSans[opsz,slnt,wdth,wght].ttf",
        output="tiktok-sans/TikTokSans-Regular.ttf",
        # The 36pt optical size is the upstream default and the one the display
        # weights are drawn for; captions are large type.
        location={"opsz": 36, "wdth": 100, "wght": 400, "slnt": 0},
        family="TikTok Sans",
        subfamily="Regular",
        full_name="TikTok Sans",
        postscript_name="TikTokSans-Regular",
        weight_class=400,
        bold=False,
    ),
    Target(
        source_url=TIKTOK_SANS_URL,
        source_name="TikTokSans[opsz,slnt,wdth,wght].ttf",
        output="tiktok-sans/TikTokSans-Bold.ttf",
        location={"opsz": 36, "wdth": 100, "wght": 700, "slnt": 0},
        family="TikTok Sans",
        subfamily="Bold",
        full_name="TikTok Sans Bold",
        postscript_name="TikTokSans-Bold",
        weight_class=700,
        bold=True,
    ),
    Target(
        source_url=MONTSERRAT_URL,
        source_name="Montserrat[wght].ttf",
        output="montserrat/Montserrat-Regular.ttf",
        location={"wght": 400},
        family="Montserrat",
        subfamily="Regular",
        full_name="Montserrat Regular",
        postscript_name="Montserrat-Regular",
        weight_class=400,
        bold=False,
    ),
    Target(
        source_url=MONTSERRAT_URL,
        source_name="Montserrat[wght].ttf",
        output="montserrat/Montserrat-Bold.ttf",
        # 700, not the 800 this family used to ship at. libass resolves a
        # requested weight against `usWeightClass`, so a face that claims 800
        # is a worse match for `\b700` than a regular face is, and the
        # exaggerated weight was never what the caption presets asked for.
        location={"wght": 700},
        family="Montserrat",
        subfamily="Bold",
        full_name="Montserrat Bold",
        postscript_name="Montserrat-Bold",
        weight_class=700,
        bold=True,
    ),
)


def download(url: str, cache_dir: Path, file_name: str) -> Path:
    """Fetches `url` into `cache_dir`, reusing an already-downloaded copy."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / file_name
    if destination.exists():
        print(f"  reusing cached {destination}")
        return destination

    print(f"  downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as response:
        destination.write_bytes(response.read())
    return destination


def set_name(font: TTFont, name_id: int, value: str) -> None:
    font["name"].setName(
        value,
        name_id,
        WINDOWS_PLATFORM_ID,
        WINDOWS_ENCODING_ID,
        WINDOWS_LANGUAGE_ID,
    )


def apply_names_and_weight_bits(font: TTFont, target: Target) -> None:
    """Rewrites the identity libass reads, and drops what it ignores."""
    name_table = font["name"]

    # Anything that is not the Windows US-English record is noise for our
    # purposes and would leave a stale "TikTok Sans 36pt" behind on macOS.
    name_table.names = [
        record
        for record in name_table.names
        if record.platformID == WINDOWS_PLATFORM_ID
        and record.platEncID == WINDOWS_ENCODING_ID
        and record.langID == WINDOWS_LANGUAGE_ID
    ]

    set_name(font, 1, target.family)
    set_name(font, 2, target.subfamily)
    set_name(font, 4, target.full_name)
    set_name(font, 6, target.postscript_name)
    set_name(font, 3, f"{target.postscript_name};OpenReelio")

    # `name` ID 16/17 exist to carry a family whose subfamily is outside the
    # four RIBBI spellings. Ours are all RIBBI now, and leaving ID 16 in place
    # is exactly the trap this script exists to close: it looks like the family
    # name while libass cannot see it.
    for ignored_name_id in (16, 17, 21, 22):
        name_table.removeNames(ignored_name_id)

    os2 = font["OS/2"]
    os2.usWeightClass = target.weight_class
    os2.fsSelection &= ~(FS_SELECTION_BOLD | FS_SELECTION_REGULAR | FS_SELECTION_ITALIC)
    os2.fsSelection |= FS_SELECTION_BOLD if target.bold else FS_SELECTION_REGULAR

    head = font["head"]
    if target.bold:
        head.macStyle |= MAC_STYLE_BOLD
    else:
        head.macStyle &= ~MAC_STYLE_BOLD


def build(target: Target, source_path: Path, fonts_root: Path) -> None:
    print(f"- {target.output}")
    font = TTFont(source_path)
    # Pinning every axis to a single value produces a static instance:
    # `instancer` drops `fvar`, `STAT`, `gvar`, `HVAR` and the rest.
    font = instancer.instantiateVariableFont(font, target.location, inplace=True)
    apply_names_and_weight_bits(font, target)

    output_path = fonts_root / target.output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    font.save(output_path)
    print(
        f"  wrote {output_path} "
        f"(family={target.family!r} full={target.full_name!r} "
        f"weight={target.weight_class} bold={target.bold})"
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fonts-root",
        type=Path,
        default=Path("src-tauri/fonts"),
        help="directory the bundled faces are written to",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(".font-sources"),
        help="directory the upstream variable fonts are downloaded into",
    )
    args = parser.parse_args(argv)

    print(f"fontTools {fonttools_version}")
    sources: dict[str, Path] = {}
    for target in TARGETS:
        if target.source_url not in sources:
            sources[target.source_url] = download(
                target.source_url, args.cache_dir, target.source_name
            )

    for target in TARGETS:
        build(target, sources[target.source_url], args.fonts_root)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
