//! Render graph contracts for high-quality preview and export.
//!
//! This module is intentionally renderer-agnostic. It converts the event-sourced
//! project state into deterministic audio and visual layer lists that a future
//! GPU compositor, software reference renderer, or export renderer can share.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::core::{
    commands::{get_text_data, is_text_clip},
    project::ProjectState,
    text::{TextAlignment, TextClipData},
    timeline::{AudioSettings, BlendMode, SequenceFormat, TimelineClock, TrackKind, Transform},
    AssetId, ClipId, CoreError, CoreResult, EffectId, Frame, SequenceId, TimeSec, TrackId,
};

pub const RENDER_GRAPH_VERSION: u32 = 1;

const DEFAULT_TEXT_COLOR: ColorRgba = ColorRgba {
    r: 255,
    g: 255,
    b: 255,
    a: 255,
};
const DEFAULT_SHADOW_COLOR: ColorRgba = ColorRgba {
    r: 0,
    g: 0,
    b: 0,
    a: 128,
};
const DEFAULT_OUTLINE_COLOR: ColorRgba = ColorRgba {
    r: 0,
    g: 0,
    b: 0,
    a: 255,
};

/// Renderer-agnostic graph for a sequence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderGraph {
    pub graph_version: u32,
    pub sequence_id: SequenceId,
    pub format: SequenceFormat,
    pub duration_sec: TimeSec,
    pub duration_frames: Frame,
    /// Visual layers sorted back-to-front for compositing.
    pub visual_layers: Vec<VisualRenderLayer>,
    /// Audio layers sorted by timeline order, independent from visual compositing.
    pub audio_layers: Vec<AudioRenderLayer>,
}

/// A visual clip layer in compositor order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VisualRenderLayer {
    pub layer_index: usize,
    pub track_id: TrackId,
    pub track_kind: TrackKind,
    pub track_index: usize,
    pub clip_id: ClipId,
    pub timeline_in_sec: TimeSec,
    pub timeline_out_sec: TimeSec,
    pub timeline_in_frame: Frame,
    pub timeline_out_frame: Frame,
    pub duration_frames: Frame,
    pub source_in_sec: TimeSec,
    pub source_out_sec: TimeSec,
    pub source_in_frame: Frame,
    pub source_out_frame: Frame,
    pub transform: Transform,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    pub effects: Vec<EffectId>,
    pub source: VisualRenderSource,
}

/// The source payload for a visual layer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum VisualRenderSource {
    #[specta(rename_all = "camelCase")]
    Media {
        asset_id: AssetId,
    },
    #[specta(rename_all = "camelCase")]
    Text {
        asset_id: AssetId,
        render_spec: Option<TextRenderSpec>,
        text_data: Option<TextClipData>,
    },
    #[specta(rename_all = "camelCase")]
    Caption {
        text: String,
        render_spec: TextRenderSpec,
        style: Option<Value>,
        position: Option<Value>,
    },
    #[specta(rename_all = "camelCase")]
    Compound {
        sequence_id: SequenceId,
    },
    Adjustment,
}

/// An audio clip layer in timeline order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioRenderLayer {
    pub track_id: TrackId,
    pub track_index: usize,
    pub clip_id: ClipId,
    pub asset_id: AssetId,
    pub timeline_in_sec: TimeSec,
    pub timeline_out_sec: TimeSec,
    pub timeline_in_frame: Frame,
    pub timeline_out_frame: Frame,
    pub duration_frames: Frame,
    pub source_in_sec: TimeSec,
    pub source_out_sec: TimeSec,
    pub source_in_frame: Frame,
    pub source_out_frame: Frame,
    pub speed: f32,
    pub reverse: bool,
    pub audio: AudioSettings,
    pub effects: Vec<EffectId>,
}

/// RGBA color in straight alpha byte space.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColorRgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

/// Normalized text style that renderers can consume without parsing UI payloads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRenderStyle {
    pub font_family: String,
    pub font_size_px: f64,
    pub font_weight: u16,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub alignment: TextAlignment,
    pub line_height: f64,
    pub letter_spacing_px: f64,
    pub fill_color: ColorRgba,
    pub opacity: f64,
}

/// Normalized text anchor and placement in sequence percentage space.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRenderPosition {
    pub x_percent: f64,
    pub y_percent: f64,
    pub anchor_x_percent: f64,
    pub anchor_y_percent: f64,
}

/// Text background box styling.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRenderBackground {
    pub color: ColorRgba,
    pub padding_px: f64,
}

/// Text stroke styling.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRenderOutline {
    pub color: ColorRgba,
    pub width_px: f64,
}

/// Text drop shadow styling.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRenderShadow {
    pub color: ColorRgba,
    pub offset_x_px: f64,
    pub offset_y_px: f64,
    pub blur_px: f64,
}

/// Complete normalized text render specification for text and caption layers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRenderSpec {
    pub text: String,
    pub style: TextRenderStyle,
    pub position: TextRenderPosition,
    pub background: Option<TextRenderBackground>,
    pub outline: Option<TextRenderOutline>,
    pub shadow: Option<TextRenderShadow>,
    pub rotation_deg: f64,
}

impl TextRenderSpec {
    fn from_text_data(text_data: &TextClipData) -> Self {
        let font_weight =
            effective_text_font_weight(text_data.style.font_weight, text_data.style.bold);

        Self {
            text: text_data.content.clone(),
            style: TextRenderStyle {
                font_family: normalize_font_family(&text_data.style.font_family),
                font_size_px: clamp_finite(text_data.style.font_size as f64, 1.0, 500.0, 48.0),
                font_weight,
                bold: text_data.style.bold || font_weight >= 600,
                italic: text_data.style.italic,
                underline: text_data.style.underline,
                alignment: text_data.style.alignment.clone(),
                line_height: clamp_finite(text_data.style.line_height, 0.5, 5.0, 1.2),
                letter_spacing_px: clamp_finite(
                    text_data.style.letter_spacing as f64,
                    -100.0,
                    200.0,
                    0.0,
                ),
                fill_color: parse_hex_color(&text_data.style.color).unwrap_or(DEFAULT_TEXT_COLOR),
                opacity: clamp_finite(text_data.opacity, 0.0, 1.0, 1.0),
            },
            position: TextRenderPosition {
                x_percent: clamp_finite(text_data.position.x * 100.0, 0.0, 100.0, 50.0),
                y_percent: clamp_finite(text_data.position.y * 100.0, 0.0, 100.0, 50.0),
                anchor_x_percent: alignment_anchor_x(&text_data.style.alignment),
                anchor_y_percent: 50.0,
            },
            background: text_data
                .style
                .background_color
                .as_deref()
                .and_then(parse_hex_color)
                .map(|color| TextRenderBackground {
                    color,
                    padding_px: clamp_finite(
                        text_data.style.background_padding as f64,
                        0.0,
                        500.0,
                        10.0,
                    ),
                }),
            outline: text_data.outline.as_ref().map(|outline| TextRenderOutline {
                color: parse_hex_color(&outline.color).unwrap_or(DEFAULT_OUTLINE_COLOR),
                width_px: clamp_finite(outline.width as f64, 0.0, 100.0, 0.0),
            }),
            shadow: text_data.shadow.as_ref().map(|shadow| TextRenderShadow {
                color: parse_hex_color(&shadow.color).unwrap_or(DEFAULT_SHADOW_COLOR),
                offset_x_px: clamp_finite(shadow.offset_x as f64, -500.0, 500.0, 0.0),
                offset_y_px: clamp_finite(shadow.offset_y as f64, -500.0, 500.0, 0.0),
                blur_px: clamp_finite(shadow.blur as f64, 0.0, 500.0, 0.0),
            }),
            rotation_deg: text_data.rotation,
        }
    }

    fn from_caption(text: &str, style: Option<&Value>, position: Option<&Value>) -> Self {
        let style_object = style.and_then(Value::as_object);
        let font_family = style_object
            .and_then(|object| json_string(object, &["fontFamily", "font_family"]))
            .map(|value| normalize_font_family(&value))
            .unwrap_or_else(|| "Arial".to_string());
        let font_size_px = style_object
            .and_then(|object| json_number(object, &["fontSize", "font_size"]))
            .map(|value| clamp_finite(value, 1.0, 500.0, 48.0))
            .unwrap_or(48.0);
        let explicit_bold =
            style_object.and_then(|object| json_bool(object, &["bold", "isBold", "is_bold"]));
        let font_weight = style_object
            .and_then(|object| json_value(object, &["fontWeight", "font_weight"]))
            .and_then(|value| parse_font_weight(value, explicit_bold.unwrap_or(false)))
            .unwrap_or_else(|| {
                if explicit_bold.unwrap_or(false) {
                    700
                } else {
                    400
                }
            });
        let bold = explicit_bold.unwrap_or(font_weight >= 600);
        let alignment = style_object
            .and_then(|object| json_string(object, &["alignment", "textAlign", "text_align"]))
            .and_then(parse_alignment)
            .unwrap_or_default();
        let fill_color = style_object
            .and_then(|object| json_value(object, &["color"]))
            .and_then(parse_json_color)
            .unwrap_or(DEFAULT_TEXT_COLOR);
        let opacity_from_color = fill_color.a as f64 / 255.0;
        let opacity = style_object
            .and_then(|object| json_number(object, &["opacity"]))
            .map(|value| clamp_finite(value, 0.0, 1.0, 1.0))
            .unwrap_or(opacity_from_color);
        let background = style_object.and_then(|object| {
            json_value(object, &["backgroundColor", "background_color"])
                .and_then(parse_json_color)
                .map(|color| {
                    let padding_px =
                        json_number(object, &["backgroundPadding", "background_padding"])
                            .map(|value| clamp_finite(value, 0.0, 500.0, 10.0))
                            .unwrap_or(10.0);
                    TextRenderBackground { color, padding_px }
                })
        });
        let outline_color = style_object
            .and_then(|object| json_value(object, &["outlineColor", "outline_color"]))
            .and_then(parse_json_color)
            .unwrap_or(DEFAULT_OUTLINE_COLOR);
        let outline_width_px = style_object
            .and_then(|object| json_number(object, &["outlineWidth", "outline_width"]))
            .map(|value| clamp_finite(value, 0.0, 100.0, 2.0))
            .unwrap_or(2.0);
        let outline = (outline_width_px > 0.0).then_some(TextRenderOutline {
            color: outline_color,
            width_px: outline_width_px,
        });
        let shadow_color = style_object
            .and_then(|object| json_value(object, &["shadowColor", "shadow_color"]))
            .and_then(parse_json_color)
            .unwrap_or(DEFAULT_SHADOW_COLOR);
        let shadow_offset = style_object
            .and_then(|object| json_number(object, &["shadowOffset", "shadow_offset"]))
            .map(|value| clamp_finite(value, -500.0, 500.0, 2.0))
            .unwrap_or(2.0);
        let shadow_offset_x = style_object
            .and_then(|object| {
                json_number(
                    object,
                    &["shadowOffsetX", "shadow_offset_x", "shadowX", "shadow_x"],
                )
            })
            .map(|value| clamp_finite(value, -500.0, 500.0, shadow_offset))
            .unwrap_or(shadow_offset);
        let shadow_offset_y = style_object
            .and_then(|object| {
                json_number(
                    object,
                    &["shadowOffsetY", "shadow_offset_y", "shadowY", "shadow_y"],
                )
            })
            .map(|value| clamp_finite(value, -500.0, 500.0, shadow_offset))
            .unwrap_or(shadow_offset);
        let shadow_blur_px = style_object
            .and_then(|object| json_number(object, &["shadowBlur", "shadow_blur"]))
            .map(|value| clamp_finite(value, 0.0, 500.0, 0.0))
            .unwrap_or(0.0);
        let shadow = Some(TextRenderShadow {
            color: shadow_color,
            offset_x_px: shadow_offset_x,
            offset_y_px: shadow_offset_y,
            blur_px: shadow_blur_px,
        });
        let (x_percent, y_percent) =
            resolve_caption_position_percent(position, style_object, &alignment);

        Self {
            text: text.to_string(),
            style: TextRenderStyle {
                font_family,
                font_size_px,
                font_weight,
                bold,
                italic: style_object
                    .and_then(|object| json_bool(object, &["italic"]))
                    .unwrap_or(false),
                underline: style_object
                    .and_then(|object| json_bool(object, &["underline"]))
                    .unwrap_or(false),
                alignment: alignment.clone(),
                line_height: style_object
                    .and_then(|object| json_number(object, &["lineHeight", "line_height"]))
                    .map(|value| clamp_finite(value, 0.5, 5.0, 1.2))
                    .unwrap_or(1.2),
                letter_spacing_px: style_object
                    .and_then(|object| json_number(object, &["letterSpacing", "letter_spacing"]))
                    .map(|value| clamp_finite(value, -100.0, 200.0, 0.0))
                    .unwrap_or(0.0),
                fill_color,
                opacity,
            },
            position: TextRenderPosition {
                x_percent,
                y_percent,
                anchor_x_percent: alignment_anchor_x(&alignment),
                anchor_y_percent: 50.0,
            },
            background,
            outline,
            shadow,
            rotation_deg: 0.0,
        }
    }
}

/// Builds a renderer-agnostic graph for the sequence.
pub fn build_render_graph(state: &ProjectState, sequence_id: &str) -> CoreResult<RenderGraph> {
    let sequence = state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id.to_string()))?;

    let mut visual_layers = Vec::new();
    let mut audio_layers = Vec::new();
    let clock = TimelineClock::new(sequence.format.fps.clone());

    for (track_index, track) in sequence.tracks.iter().enumerate().rev() {
        if track.muted || !track.visible {
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }

            match track.kind {
                TrackKind::Audio => {
                    let timeline_in_frame =
                        clock.seconds_to_nearest_frame(clip.place.timeline_in_sec);
                    let timeline_out_frame =
                        clock.seconds_to_nearest_frame(clip.place.timeline_out_sec());
                    audio_layers.push(AudioRenderLayer {
                        track_id: track.id.clone(),
                        track_index,
                        clip_id: clip.id.clone(),
                        asset_id: clip.asset_id.clone(),
                        timeline_in_sec: clip.place.timeline_in_sec,
                        timeline_out_sec: clip.place.timeline_out_sec(),
                        timeline_in_frame,
                        timeline_out_frame,
                        duration_frames: (timeline_out_frame - timeline_in_frame).max(0),
                        source_in_sec: clip.range.source_in_sec,
                        source_out_sec: clip.range.source_out_sec,
                        source_in_frame: clock.seconds_to_nearest_frame(clip.range.source_in_sec),
                        source_out_frame: clock.seconds_to_nearest_frame(clip.range.source_out_sec),
                        speed: clip.speed,
                        reverse: clip.reverse,
                        audio: clip.audio.clone(),
                        effects: clip.effects.clone(),
                    });
                }
                TrackKind::Video | TrackKind::Overlay | TrackKind::Caption => {
                    let source = if let Some(compound_sequence_id) = &clip.compound_sequence_id {
                        VisualRenderSource::Compound {
                            sequence_id: compound_sequence_id.clone(),
                        }
                    } else if clip.is_adjustment_layer {
                        VisualRenderSource::Adjustment
                    } else if track.kind == TrackKind::Caption {
                        VisualRenderSource::Caption {
                            text: clip.label.clone().unwrap_or_default(),
                            render_spec: TextRenderSpec::from_caption(
                                clip.label.as_deref().unwrap_or_default(),
                                clip.caption_style.as_ref(),
                                clip.caption_position.as_ref(),
                            ),
                            style: clip.caption_style.clone(),
                            position: clip.caption_position.clone(),
                        }
                    } else if is_text_clip(clip) {
                        let text_data = get_text_data(clip, state);
                        let render_spec = text_data.as_ref().map(TextRenderSpec::from_text_data);
                        VisualRenderSource::Text {
                            asset_id: clip.asset_id.clone(),
                            render_spec,
                            text_data,
                        }
                    } else {
                        VisualRenderSource::Media {
                            asset_id: clip.asset_id.clone(),
                        }
                    };

                    let timeline_in_frame =
                        clock.seconds_to_nearest_frame(clip.place.timeline_in_sec);
                    let timeline_out_frame =
                        clock.seconds_to_nearest_frame(clip.place.timeline_out_sec());
                    visual_layers.push(VisualRenderLayer {
                        layer_index: visual_layers.len(),
                        track_id: track.id.clone(),
                        track_kind: track.kind.clone(),
                        track_index,
                        clip_id: clip.id.clone(),
                        timeline_in_sec: clip.place.timeline_in_sec,
                        timeline_out_sec: clip.place.timeline_out_sec(),
                        timeline_in_frame,
                        timeline_out_frame,
                        duration_frames: (timeline_out_frame - timeline_in_frame).max(0),
                        source_in_sec: clip.range.source_in_sec,
                        source_out_sec: clip.range.source_out_sec,
                        source_in_frame: clock.seconds_to_nearest_frame(clip.range.source_in_sec),
                        source_out_frame: clock.seconds_to_nearest_frame(clip.range.source_out_sec),
                        transform: clip.transform.clone(),
                        opacity: clip.opacity,
                        blend_mode: clip.blend_mode.clone(),
                        effects: clip.effects.clone(),
                        source,
                    });
                }
            }
        }
    }

    audio_layers.sort_by(|a, b| {
        a.timeline_in_sec
            .partial_cmp(&b.timeline_in_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.track_index.cmp(&b.track_index))
    });

    Ok(RenderGraph {
        graph_version: RENDER_GRAPH_VERSION,
        sequence_id: sequence.id.clone(),
        format: sequence.format.clone(),
        duration_sec: sequence.duration(),
        duration_frames: clock.seconds_to_nearest_frame(sequence.duration()),
        visual_layers,
        audio_layers,
    })
}

fn clamp_finite(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

fn normalize_font_family(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "Arial".to_string()
    } else {
        trimmed.to_string()
    }
}

fn alignment_anchor_x(alignment: &TextAlignment) -> f64 {
    match alignment {
        TextAlignment::Left => 0.0,
        TextAlignment::Right => 100.0,
        TextAlignment::Center => 50.0,
    }
}

fn effective_text_font_weight(font_weight: u16, bold: bool) -> u16 {
    let font_weight = font_weight.clamp(100, 900);
    if bold && font_weight < 600 {
        700
    } else {
        font_weight
    }
}

fn parse_alignment(value: String) -> Option<TextAlignment> {
    match value.trim().to_ascii_lowercase().as_str() {
        "left" => Some(TextAlignment::Left),
        "right" => Some(TextAlignment::Right),
        "center" | "middle" => Some(TextAlignment::Center),
        _ => None,
    }
}

fn json_value<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(*key))
}

fn json_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    json_value(object, keys)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn json_number(object: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    json_value(object, keys).and_then(parse_json_number)
}

fn json_bool(object: &Map<String, Value>, keys: &[&str]) -> Option<bool> {
    json_value(object, keys).and_then(parse_json_bool)
}

fn parse_json_number(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .map(str::trim)
            .and_then(|raw| raw.parse::<f64>().ok())
    })
}

fn parse_json_bool(value: &Value) -> Option<bool> {
    value.as_bool().or_else(|| {
        let normalized = value.as_str()?.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        }
    })
}

fn parse_font_weight(value: &Value, bold: bool) -> Option<u16> {
    if let Some(raw) = value.as_str() {
        let normalized = raw.trim().to_ascii_lowercase();
        let weight = match normalized.as_str() {
            "thin" => 100.0,
            "extra-light" | "extralight" | "ultralight" => 200.0,
            "light" => 300.0,
            "normal" | "regular" => 400.0,
            "medium" => 500.0,
            "semibold" | "semi-bold" | "demibold" | "demi-bold" => 600.0,
            "bold" => 700.0,
            "extrabold" | "extra-bold" | "ultrabold" | "ultra-bold" => 800.0,
            "black" | "heavy" => 900.0,
            _ => normalized.parse::<f64>().ok()?,
        };
        return Some(clamp_finite(weight.round(), 100.0, 900.0, 400.0) as u16);
    }

    parse_json_number(value)
        .map(|weight| clamp_finite(weight.round(), 100.0, 900.0, 400.0) as u16)
        .or_else(|| bold.then_some(700))
}

fn parse_json_color(value: &Value) -> Option<ColorRgba> {
    if let Some(raw) = value.as_str() {
        return parse_hex_color(raw);
    }

    let object = value.as_object()?;
    let r = json_number(object, &["r", "red"]).map(|value| clamp_color_byte(value, 255.0))?;
    let g = json_number(object, &["g", "green"]).map(|value| clamp_color_byte(value, 255.0))?;
    let b = json_number(object, &["b", "blue"]).map(|value| clamp_color_byte(value, 255.0))?;
    let a = json_number(object, &["a", "alpha"])
        .map(|value| clamp_color_byte(value, 255.0))
        .unwrap_or(255);

    Some(ColorRgba { r, g, b, a })
}

fn parse_hex_color(raw: &str) -> Option<ColorRgba> {
    let mut hex = raw.trim().trim_start_matches('#').to_string();
    if hex.len() == 3 || hex.len() == 4 {
        hex = hex.chars().flat_map(|ch| [ch, ch]).collect::<String>();
    }

    if !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }

    match hex.len() {
        6 => Some(ColorRgba {
            r: u8::from_str_radix(&hex[0..2], 16).ok()?,
            g: u8::from_str_radix(&hex[2..4], 16).ok()?,
            b: u8::from_str_radix(&hex[4..6], 16).ok()?,
            a: 255,
        }),
        8 => Some(ColorRgba {
            r: u8::from_str_radix(&hex[0..2], 16).ok()?,
            g: u8::from_str_radix(&hex[2..4], 16).ok()?,
            b: u8::from_str_radix(&hex[4..6], 16).ok()?,
            a: u8::from_str_radix(&hex[6..8], 16).ok()?,
        }),
        _ => None,
    }
}

fn clamp_color_byte(value: f64, fallback: f64) -> u8 {
    clamp_finite(value.round(), 0.0, 255.0, fallback) as u8
}

fn resolve_caption_position_percent(
    position: Option<&Value>,
    style_object: Option<&Map<String, Value>>,
    alignment: &TextAlignment,
) -> (f64, f64) {
    let mut x = match alignment {
        TextAlignment::Left => 10.0,
        TextAlignment::Right => 90.0,
        TextAlignment::Center => 50.0,
    };
    let mut y = 90.0;

    if let Some(position_value) = position {
        if let Some(preset) = position_value.as_str() {
            y = vertical_position_to_y_percent(preset, 5.0);
            return (x, y);
        }

        if let Some(position_object) = position_value.as_object() {
            let position_type = json_string(position_object, &["type"]).unwrap_or_default();

            if position_type.eq_ignore_ascii_case("preset") {
                let vertical = json_string(position_object, &["vertical"])
                    .unwrap_or_else(|| "bottom".to_string());
                let margin_percent =
                    json_number(position_object, &["marginPercent", "margin_percent"])
                        .map(|value| clamp_finite(value, 0.0, 50.0, 5.0))
                        .unwrap_or(5.0);
                return (x, vertical_position_to_y_percent(&vertical, margin_percent));
            }

            if position_type.eq_ignore_ascii_case("custom")
                || json_value(position_object, &["xPercent", "x_percent", "x"]).is_some()
                || json_value(position_object, &["yPercent", "y_percent", "y"]).is_some()
            {
                if let Some(custom_x) =
                    json_number(position_object, &["xPercent", "x_percent", "x"])
                {
                    x = normalize_caption_axis(custom_x, 50.0);
                }
                if let Some(custom_y) =
                    json_number(position_object, &["yPercent", "y_percent", "y"])
                {
                    y = normalize_caption_axis(custom_y, 90.0);
                }
                return (x, y);
            }
        }
    }

    if let Some(style_object) = style_object {
        if let Some(vertical_align) =
            json_string(style_object, &["verticalAlign", "vertical_align"])
        {
            y = vertical_position_to_y_percent(&vertical_align, 10.0);
        }
    }

    (x, y)
}

fn vertical_position_to_y_percent(vertical: &str, margin_percent: f64) -> f64 {
    let margin = clamp_finite(margin_percent, 0.0, 50.0, 5.0);
    match vertical.trim().to_ascii_lowercase().as_str() {
        "top" => margin,
        "center" | "middle" => 50.0,
        _ => 100.0 - margin,
    }
}

fn normalize_caption_axis(value: f64, fallback: f64) -> f64 {
    if (0.0..=1.0).contains(&value) {
        value * 100.0
    } else {
        clamp_finite(value, 0.0, 100.0, fallback)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        commands::TEXT_ASSET_PREFIX,
        effects::{Effect, EffectType, ParamValue},
        project::ProjectState,
        timeline::{Clip, ClipPlace, ClipRange, Sequence, SequenceFormat, Track, TrackKind},
    };

    fn clip_with_timing(id: &str, asset_id: &str, timeline_in: f64, duration: f64) -> Clip {
        let mut clip = Clip::new(asset_id);
        clip.id = id.to_string();
        clip.place = ClipPlace::new(timeline_in, duration);
        clip.range = ClipRange::new(0.0, duration);
        clip
    }

    fn add_sequence(state: &mut ProjectState, sequence: Sequence) {
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);
    }

    #[test]
    fn build_render_graph_orders_visual_layers_back_to_front() {
        let mut state = ProjectState::new("Render Graph Test");
        state.sequences.clear();

        let mut sequence = Sequence::new("Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();

        let mut top_video = Track::new("Video 2", TrackKind::Video);
        top_video.id = "track-top".to_string();
        top_video
            .clips
            .push(clip_with_timing("clip-top", "asset-top", 0.0, 5.0));

        let mut lower_video = Track::new("Video 1", TrackKind::Video);
        lower_video.id = "track-lower".to_string();
        lower_video
            .clips
            .push(clip_with_timing("clip-lower", "asset-lower", 0.0, 5.0));

        sequence.tracks.push(top_video);
        sequence.tracks.push(lower_video);
        add_sequence(&mut state, sequence);

        let graph = build_render_graph(&state, "seq-1").expect("render graph");

        assert_eq!(graph.graph_version, RENDER_GRAPH_VERSION);
        assert_eq!(graph.duration_frames, 150);
        assert_eq!(graph.visual_layers.len(), 2);
        assert_eq!(graph.visual_layers[0].clip_id, "clip-lower");
        assert_eq!(graph.visual_layers[1].clip_id, "clip-top");
        assert_eq!(graph.visual_layers[0].layer_index, 0);
        assert_eq!(graph.visual_layers[1].layer_index, 1);
        assert_eq!(graph.visual_layers[0].timeline_in_frame, 0);
        assert_eq!(graph.visual_layers[0].timeline_out_frame, 150);
        assert_eq!(graph.visual_layers[0].duration_frames, 150);
    }

    #[test]
    fn build_render_graph_preserves_text_and_caption_payloads() {
        let mut state = ProjectState::new("Render Graph Test");
        state.sequences.clear();

        let mut sequence = Sequence::new("Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();

        let mut caption_track = Track::new("Captions", TrackKind::Caption);
        caption_track.id = "caption-track".to_string();
        let mut caption = clip_with_timing("caption-1", "__caption__caption-1", 1.0, 2.0);
        caption.label = Some("Hello caption".to_string());
        caption.caption_style = Some(serde_json::json!({
            "fontFamily": "Inter",
            "fontSize": 52,
            "fontWeight": 700,
            "color": { "r": 10, "g": 20, "b": 30, "a": 204 },
            "opacity": 0.75,
            "backgroundColor": "#01020380",
            "backgroundPadding": 14,
            "outlineColor": "#111213",
            "outlineWidth": 4,
            "shadowColor": "#21222366",
            "shadowOffsetX": 6,
            "shadowOffsetY": 7,
            "shadowBlur": 8,
            "alignment": "left",
            "italic": true,
            "underline": true,
            "lineHeight": 1.4,
            "letterSpacing": 3
        }));
        caption.caption_position = Some(serde_json::json!({
            "type": "custom",
            "xPercent": 42,
            "yPercent": 80
        }));
        caption_track.clips.push(caption);

        let mut text_track = Track::new("Video 1", TrackKind::Video);
        text_track.id = "text-track".to_string();
        let mut text_effect = Effect::with_id("effect-text", EffectType::TextOverlay);
        text_effect.set_param("text", ParamValue::String("Hello title".to_string()));
        text_effect.set_param("font_family", ParamValue::String("Inter".to_string()));
        text_effect.set_param("font_size", ParamValue::Float(64.0));
        text_effect.set_param("color", ParamValue::String("#112233AA".to_string()));
        text_effect.set_param("bold", ParamValue::Bool(true));
        text_effect.set_param("alignment", ParamValue::String("right".to_string()));
        text_effect.set_param("x", ParamValue::Float(0.25));
        text_effect.set_param("y", ParamValue::Float(0.75));
        text_effect.set_param("shadow_color", ParamValue::String("#00000080".to_string()));
        text_effect.set_param("shadow_x", ParamValue::Int(4));
        text_effect.set_param("shadow_y", ParamValue::Int(5));
        text_effect.set_param("shadow_blur", ParamValue::Int(6));
        text_effect.set_param("outline_color", ParamValue::String("#FFFFFF".to_string()));
        text_effect.set_param("outline_width", ParamValue::Int(3));
        state.effects.insert(text_effect.id.clone(), text_effect);

        let mut text_clip =
            clip_with_timing("text-1", &format!("{TEXT_ASSET_PREFIX}text-1"), 0.0, 3.0);
        text_clip.effects.push("effect-text".to_string());
        text_track.clips.push(text_clip);

        sequence.tracks.push(caption_track);
        sequence.tracks.push(text_track);
        add_sequence(&mut state, sequence);

        let graph = build_render_graph(&state, "seq-1").expect("render graph");

        match &graph.visual_layers[0].source {
            VisualRenderSource::Text {
                text_data: Some(text_data),
                render_spec: Some(render_spec),
                ..
            } => {
                assert_eq!(text_data.content, "Hello title");
                assert_eq!(text_data.style.font_family, "Inter");
                assert_eq!(text_data.style.font_size, 64);
                assert_eq!(render_spec.text, "Hello title");
                assert_eq!(render_spec.style.font_family, "Inter");
                assert_eq!(render_spec.style.font_size_px, 64.0);
                assert_eq!(render_spec.style.font_weight, 700);
                assert_eq!(render_spec.style.fill_color.a, 170);
                assert_eq!(render_spec.position.x_percent, 25.0);
                assert_eq!(render_spec.position.y_percent, 75.0);
                assert_eq!(render_spec.position.anchor_x_percent, 100.0);
                assert_eq!(render_spec.shadow.as_ref().unwrap().blur_px, 6.0);
                assert_eq!(render_spec.outline.as_ref().unwrap().width_px, 3.0);
            }
            other => panic!("expected text render source, got {other:?}"),
        }

        match &graph.visual_layers[1].source {
            VisualRenderSource::Caption {
                text,
                render_spec,
                style: Some(_),
                position: Some(_),
            } => {
                assert_eq!(text, "Hello caption");
                assert_eq!(render_spec.text, "Hello caption");
                assert_eq!(render_spec.style.font_family, "Inter");
                assert_eq!(render_spec.style.font_size_px, 52.0);
                assert_eq!(render_spec.style.font_weight, 700);
                assert!(render_spec.style.bold);
                assert!(render_spec.style.italic);
                assert!(render_spec.style.underline);
                assert_eq!(render_spec.style.alignment, TextAlignment::Left);
                assert_eq!(
                    render_spec.style.fill_color,
                    ColorRgba {
                        r: 10,
                        g: 20,
                        b: 30,
                        a: 204
                    }
                );
                assert_eq!(render_spec.style.opacity, 0.75);
                assert_eq!(render_spec.position.x_percent, 42.0);
                assert_eq!(render_spec.position.y_percent, 80.0);
                assert_eq!(render_spec.position.anchor_x_percent, 0.0);
                assert_eq!(render_spec.background.as_ref().unwrap().padding_px, 14.0);
                assert_eq!(render_spec.outline.as_ref().unwrap().width_px, 4.0);
                assert_eq!(render_spec.shadow.as_ref().unwrap().offset_x_px, 6.0);
                assert_eq!(render_spec.shadow.as_ref().unwrap().offset_y_px, 7.0);
                assert_eq!(render_spec.shadow.as_ref().unwrap().blur_px, 8.0);
            }
            other => panic!("expected caption render source, got {other:?}"),
        }
    }

    #[test]
    fn build_render_graph_separates_audio_layers_and_skips_disabled_content() {
        let mut state = ProjectState::new("Render Graph Test");
        state.sequences.clear();

        let mut sequence = Sequence::new("Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();

        let mut video_track = Track::new("Video 1", TrackKind::Video);
        video_track.id = "video-track".to_string();
        let mut disabled_clip = clip_with_timing("disabled", "asset-disabled", 0.0, 1.0);
        disabled_clip.enabled = false;
        video_track.clips.push(disabled_clip);

        let mut audio_track = Track::new("Audio 1", TrackKind::Audio);
        audio_track.id = "audio-track".to_string();
        audio_track
            .clips
            .push(clip_with_timing("audio-1", "asset-audio", 2.0, 4.0));

        sequence.tracks.push(video_track);
        sequence.tracks.push(audio_track);
        add_sequence(&mut state, sequence);

        let graph = build_render_graph(&state, "seq-1").expect("render graph");

        assert!(graph.visual_layers.is_empty());
        assert_eq!(graph.audio_layers.len(), 1);
        assert_eq!(graph.audio_layers[0].clip_id, "audio-1");
        assert_eq!(graph.audio_layers[0].timeline_in_sec, 2.0);
        assert_eq!(graph.audio_layers[0].timeline_in_frame, 60);
        assert_eq!(graph.audio_layers[0].timeline_out_frame, 180);
        assert_eq!(graph.audio_layers[0].duration_frames, 120);
    }

    #[test]
    fn build_render_graph_includes_fractional_fps_frame_spans() {
        let mut state = ProjectState::new("Render Graph Test");
        state.sequences.clear();

        let mut sequence = Sequence::new(
            "Sequence",
            SequenceFormat::new(1920, 1080, 30000, 1001, 48_000),
        );
        sequence.id = "seq-1".to_string();

        let mut video_track = Track::new("Video 1", TrackKind::Video);
        video_track.id = "video-track".to_string();
        video_track.clips.push(clip_with_timing(
            "clip-ntsc",
            "asset-video",
            1001.0 / 30000.0,
            (1001.0 / 30000.0) * 10.0,
        ));
        sequence.tracks.push(video_track);
        add_sequence(&mut state, sequence);

        let graph = build_render_graph(&state, "seq-1").expect("render graph");
        let layer = &graph.visual_layers[0];

        assert_eq!(layer.timeline_in_frame, 1);
        assert_eq!(layer.timeline_out_frame, 11);
        assert_eq!(layer.duration_frames, 10);
        assert_eq!(graph.duration_frames, 11);
    }

    #[test]
    fn build_render_graph_preserves_gaps_without_synthesizing_layers() {
        let mut state = ProjectState::new("Render Graph Test");
        state.sequences.clear();

        let mut sequence = Sequence::new("Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();

        let mut video_track = Track::new("Video 1", TrackKind::Video);
        video_track.id = "video-track".to_string();
        video_track
            .clips
            .push(clip_with_timing("clip-a", "asset-a", 0.0, 2.0));
        video_track
            .clips
            .push(clip_with_timing("clip-b", "asset-b", 5.0, 2.0));
        sequence.tracks.push(video_track);
        add_sequence(&mut state, sequence);

        let graph = build_render_graph(&state, "seq-1").expect("render graph");

        assert_eq!(graph.visual_layers.len(), 2);
        assert_eq!(graph.duration_sec, 7.0);
        assert_eq!(graph.duration_frames, 210);
        assert_eq!(graph.visual_layers[0].timeline_out_sec, 2.0);
        assert_eq!(graph.visual_layers[1].timeline_in_sec, 5.0);
    }

    #[test]
    fn build_render_graph_returns_sequence_error_for_missing_sequence() {
        let state = ProjectState::new("Render Graph Test");
        let error = build_render_graph(&state, "missing-sequence").unwrap_err();

        assert!(
            matches!(error, CoreError::SequenceNotFound(sequence_id) if sequence_id == "missing-sequence")
        );
    }

    #[test]
    fn visual_render_source_serializes_camel_case_payload_fields() {
        let source = VisualRenderSource::Text {
            asset_id: "asset-text".to_string(),
            render_spec: None,
            text_data: None,
        };

        let value = serde_json::to_value(source).expect("serialized source");

        assert_eq!(
            value,
            serde_json::json!({
                "type": "text",
                "assetId": "asset-text",
                "renderSpec": null,
                "textData": null
            })
        );
    }
}
