//! Plan-aware FFmpeg argument builders.
//!
//! This module is the migration boundary for executable FFmpeg work. During the
//! parity migration it still consumes the legacy sequence payload, but callers
//! must enter through an optional RenderPlan contract and receive plain args
//! that are wrapped into `FfmpegInvocation` before execution.

use std::{collections::HashMap, path::Path};

use crate::core::{
    assets::Asset,
    effects::{Effect, IntoFFmpegFilter},
    fs::validate_local_input_path,
    timeline::{Sequence, TrackKind},
};

use super::{
    export::{
        append_ass_text_overlay, append_black_video_gap, append_caption_overlays,
        append_master_audio_output, append_output_time_range_args, append_text_clip_overlays,
        append_timeline_video_output, append_video_stream_normalization, apply_audio_mix_settings,
        asset_has_playable_audio, build_audio_trim_filter, build_video_trim_filter,
        clip_audio_is_suppressed_by_companion, collect_audio_companion_keys,
        collect_caption_drawtext_filters, collect_enabled_clips_sorted,
        collect_overlay_text_drawtext_filters, find_transition_effect,
        generated_text_visual_end_sec, hdr_metadata_for_asset, is_text_clip,
        output_video_dimensions, output_video_fps, output_video_pixel_format, AssetAudioInfo,
        ExportEngine, ExportError, ExportSettings, VideoCodec, VideoTimelineSegment,
        TIMELINE_EPSILON_SEC,
    },
    RenderPlan,
};

pub(super) struct SequenceFfmpegBuildContext<'a> {
    pub engine: &'a ExportEngine,
    pub sequence: &'a Sequence,
    pub assets: &'a HashMap<String, Asset>,
    pub effects: &'a HashMap<String, Effect>,
    pub audio_info: &'a HashMap<String, AssetAudioInfo>,
    pub settings: &'a ExportSettings,
    pub render_plan: Option<&'a RenderPlan>,
    pub ass_text_overlay_path: Option<&'a Path>,
}

pub(super) struct AudioOnlyFfmpegBuildContext<'a> {
    pub engine: &'a ExportEngine,
    pub sequence: &'a Sequence,
    pub assets: &'a HashMap<String, Asset>,
    pub effects: &'a HashMap<String, Effect>,
    pub audio_info: &'a HashMap<String, AssetAudioInfo>,
    pub settings: &'a ExportSettings,
    pub render_plan: Option<&'a RenderPlan>,
}

pub(super) fn build_sequence_ffmpeg_args(
    ctx: SequenceFfmpegBuildContext<'_>,
) -> Result<Vec<String>, ExportError> {
    validate_optional_plan_contract(ctx.render_plan, ctx.sequence, ctx.settings)?;

    let mut args = Vec::new();
    let mut input_index = 0;
    let mut filter_complex = String::new();
    let mut video_segments = Vec::new();
    let mut audio_streams = Vec::new();
    let mut timeline_end_sec = 0.0_f64;
    let audio_companion_keys =
        collect_audio_companion_keys(ctx.sequence, ctx.assets, ctx.audio_info);

    let all_clips = collect_enabled_clips_sorted(ctx.sequence);

    if all_clips.is_empty() {
        return Err(ExportError::NoClips);
    }

    let use_ass_text_overlays = ctx.ass_text_overlay_path.is_some();
    let caption_filters = if use_ass_text_overlays {
        Vec::new()
    } else {
        collect_caption_drawtext_filters(&all_clips)
    };
    let overlay_text_filters = if use_ass_text_overlays {
        Vec::new()
    } else {
        collect_overlay_text_drawtext_filters(&all_clips, ctx.effects)?
    };

    let (output_width, output_height) = output_video_dimensions(ctx.sequence, ctx.settings);
    let output_fps = output_video_fps(ctx.sequence, ctx.settings);
    let output_pixel_format = output_video_pixel_format(ctx.settings);

    let mut adjustment_layer_effects = Vec::new();
    for (clip, _track) in &all_clips {
        if clip.is_adjustment_layer() && !clip.effects.is_empty() {
            let graph = ctx.engine.build_clip_filter_graph(
                clip,
                ctx.effects,
                Some(output_width),
                Some(output_height),
            );
            if graph.has_video_effects() {
                let start = clip.place.timeline_in_sec;
                let end = clip.place.timeline_out_sec();
                adjustment_layer_effects.push((graph, start, end));
            }
        }
    }

    for (clip, track) in &all_clips {
        if matches!(track.kind, TrackKind::Caption | TrackKind::Overlay) {
            continue;
        }

        if clip.is_adjustment_layer() || is_text_clip(clip) {
            continue;
        }

        let asset = ctx.assets.get(&clip.asset_id).ok_or_else(|| {
            ExportError::InvalidSettings(format!("Asset not found: {}", clip.asset_id))
        })?;

        let validated_path = validate_local_input_path(&asset.uri, "Asset file")
            .map_err(ExportError::InvalidSettings)?;

        let clip_has_audio =
            asset_has_playable_audio(asset, &track.kind, ctx.audio_info.get(&clip.asset_id))
                && !clip_audio_is_suppressed_by_companion(
                    clip,
                    track,
                    asset,
                    &audio_companion_keys,
                );

        let contributes_visual_output = matches!(track.kind, TrackKind::Video) && track.visible;
        if !contributes_visual_output && !clip_has_audio {
            continue;
        }
        timeline_end_sec = timeline_end_sec.max(clip.place.timeline_out_sec());

        args.push("-i".to_string());
        args.push(validated_path.to_string_lossy().to_string());

        let clip_filter_graph = ctx.engine.build_clip_filter_graph(
            clip,
            ctx.effects,
            Some(output_width),
            Some(output_height),
        );

        let source_hdr_metadata = hdr_metadata_for_asset(asset);
        let tonemap_filter = ctx
            .settings
            .build_tonemap_video_filter(&source_hdr_metadata);

        match track.kind {
            TrackKind::Video => {
                if track.visible {
                    let trim_label = format!("trim{}", input_index);
                    let video_out_label = format!("v{}", input_index);
                    let normalized_video_label = format!("vnorm{}", input_index);

                    let effects_out_label = if tonemap_filter.is_some() {
                        format!("vfx{}", input_index)
                    } else {
                        video_out_label.clone()
                    };

                    build_video_trim_filter(clip, input_index, &trim_label, &mut filter_complex);

                    if clip_filter_graph.has_video_effects() {
                        let effects_filter = clip_filter_graph
                            .to_video_filter_complex(&trim_label, &effects_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        filter_complex
                            .push_str(&format!("[{}]null[{}];", trim_label, effects_out_label));
                    }

                    if let Some(ref tm_filter) = tonemap_filter {
                        filter_complex.push_str(&format!(
                            "[{}]{}[{}];",
                            effects_out_label, tm_filter, video_out_label
                        ));
                    }

                    append_video_stream_normalization(
                        &mut filter_complex,
                        &video_out_label,
                        &normalized_video_label,
                        output_width,
                        output_height,
                        output_fps,
                        output_pixel_format,
                    );

                    video_segments.push(VideoTimelineSegment {
                        stream_label: format!("[{}]", normalized_video_label),
                        start_sec: clip.place.timeline_in_sec,
                        end_sec: clip.place.timeline_out_sec(),
                        transition_filter: find_transition_effect(clip, ctx.effects)
                            .map(|effect| effect.to_filter_body()),
                    });
                }

                if clip_has_audio && !clip.freeze_frame && !clip.audio.muted {
                    let audio_trim_label = format!("atrim{}", input_index);
                    let audio_out_label = format!("a{}", input_index);

                    let audio_effects_input = build_audio_trim_filter(
                        clip,
                        input_index,
                        &audio_trim_label,
                        &mut filter_complex,
                    );

                    if clip_filter_graph.has_audio_effects() {
                        let effects_filter = clip_filter_graph
                            .to_audio_filter_complex(&audio_effects_input, &audio_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        filter_complex.push_str(&format!(
                            "[{}]anull[{}];",
                            audio_effects_input, audio_out_label
                        ));
                    }

                    let mixed_audio_label = apply_audio_mix_settings(
                        clip,
                        track,
                        input_index,
                        &audio_out_label,
                        &mut filter_complex,
                    );

                    audio_streams.push(format!("[{}]", mixed_audio_label));
                }
            }
            TrackKind::Audio => {
                if clip_has_audio && !clip.freeze_frame && !clip.audio.muted {
                    let audio_trim_label = format!("atrim{}", input_index);
                    let audio_out_label = format!("a{}", input_index);

                    let audio_effects_input = build_audio_trim_filter(
                        clip,
                        input_index,
                        &audio_trim_label,
                        &mut filter_complex,
                    );

                    if clip_filter_graph.has_audio_effects() {
                        let effects_filter = clip_filter_graph
                            .to_audio_filter_complex(&audio_effects_input, &audio_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        filter_complex.push_str(&format!(
                            "[{}]anull[{}];",
                            audio_effects_input, audio_out_label
                        ));
                    }

                    let mixed_audio_label = apply_audio_mix_settings(
                        clip,
                        track,
                        input_index,
                        &audio_out_label,
                        &mut filter_complex,
                    );

                    audio_streams.push(format!("[{}]", mixed_audio_label));
                }
            }
            _ => {}
        }

        input_index += 1;
    }

    if video_segments.is_empty()
        && (!caption_filters.is_empty()
            || !overlay_text_filters.is_empty()
            || use_ass_text_overlays)
    {
        let generated_visual_end_sec = generated_text_visual_end_sec(&all_clips);
        if generated_visual_end_sec > TIMELINE_EPSILON_SEC {
            let blank_label = "vtextbase0";
            append_black_video_gap(
                &mut filter_complex,
                blank_label,
                generated_visual_end_sec,
                output_width,
                output_height,
                output_fps,
                output_pixel_format,
            );
            video_segments.push(VideoTimelineSegment {
                stream_label: format!("[{}]", blank_label),
                start_sec: 0.0,
                end_sec: generated_visual_end_sec,
                transition_filter: None,
            });
            timeline_end_sec = timeline_end_sec.max(generated_visual_end_sec);
        }
    }

    if video_segments.is_empty() {
        return Err(ExportError::InvalidSettings(
            "Sequence has no visual clips to export".to_string(),
        ));
    }

    if filter_complex.ends_with(';') {
        filter_complex.pop();
    }
    filter_complex.push(';');

    append_timeline_video_output(
        &mut filter_complex,
        &video_segments,
        timeline_end_sec,
        output_width,
        output_height,
        output_fps,
        output_pixel_format,
    )?;

    let mut adj_video_label = "outv".to_string();
    for (i, (graph, start, end)) in adjustment_layer_effects.iter().enumerate() {
        let out_label = format!("adj{}", i);
        let adj_filter =
            graph.to_video_filter_complex_timed(&adj_video_label, &out_label, *start, *end);
        filter_complex.push(';');
        filter_complex.push_str(&adj_filter);
        adj_video_label = out_label;
    }

    if !adjustment_layer_effects.is_empty() {
        filter_complex.push(';');
        filter_complex.push_str(&format!("[{}]null[outv]", adj_video_label));
    }

    let final_video_label = if let Some(ass_path) = ctx.ass_text_overlay_path {
        append_ass_text_overlay(
            &mut filter_complex,
            "[outv]",
            ass_path,
            output_width,
            output_height,
        )
    } else {
        let text_overlay_video_label =
            append_text_clip_overlays(&mut filter_complex, "[outv]", &overlay_text_filters);
        append_caption_overlays(
            &mut filter_complex,
            &text_overlay_video_label,
            &caption_filters,
        )
    };

    let final_audio_label = append_master_audio_output(
        &mut filter_complex,
        &audio_streams,
        ctx.sequence.master_volume_db,
    );

    args.push("-filter_complex".to_string());
    args.push(filter_complex);
    args.push("-map".to_string());
    args.push(final_video_label);

    if let Some(final_audio_label) = final_audio_label.as_deref() {
        args.push("-map".to_string());
        args.push(final_audio_label.to_string());
    }

    let video_encoder = ctx.settings.video_encoder_name();
    args.push("-c:v".to_string());
    args.push(video_encoder.clone());

    if final_audio_label.is_some() {
        args.push("-c:a".to_string());
        args.push(ctx.settings.audio_encoder_name().to_string());
    }

    if let Some(ref bitrate) = ctx.settings.video_bitrate {
        args.push("-b:v".to_string());
        args.push(bitrate.clone());
    }

    if let Some(ref bitrate) = ctx.settings.audio_bitrate {
        if final_audio_label.is_some() {
            args.push("-b:a".to_string());
            args.push(bitrate.clone());
        }
    }

    if let Some(crf) = ctx.settings.crf {
        if matches!(
            ctx.settings.video_codec,
            VideoCodec::H264 | VideoCodec::H265 | VideoCodec::Vp9
        ) {
            args.extend(super::hardware::resolve_quality_args(&video_encoder, crf));
        }
    }

    args.extend(ctx.settings.hdr_args());
    append_output_time_range_args(&mut args, ctx.settings.start_time, ctx.settings.end_time);
    args.push("-y".to_string());
    args.push(ctx.settings.output_path.to_string_lossy().to_string());

    Ok(args)
}

pub(super) fn build_audio_only_ffmpeg_args(
    ctx: AudioOnlyFfmpegBuildContext<'_>,
) -> Result<Vec<String>, ExportError> {
    validate_optional_plan_contract(ctx.render_plan, ctx.sequence, ctx.settings)?;

    let mut args = Vec::new();
    let mut input_index = 0;
    let mut filter_complex = String::new();
    let mut audio_streams = Vec::new();
    let audio_companion_keys =
        collect_audio_companion_keys(ctx.sequence, ctx.assets, ctx.audio_info);
    let all_clips = collect_enabled_clips_sorted(ctx.sequence);

    if all_clips.is_empty() {
        return Err(ExportError::NoClips);
    }

    for (clip, track) in &all_clips {
        if !matches!(track.kind, TrackKind::Video | TrackKind::Audio) {
            continue;
        }

        if clip.is_adjustment_layer() || is_text_clip(clip) || clip.freeze_frame || clip.audio.muted
        {
            continue;
        }

        let asset = ctx.assets.get(&clip.asset_id).ok_or_else(|| {
            ExportError::InvalidSettings(format!("Asset not found: {}", clip.asset_id))
        })?;

        let clip_has_audio =
            asset_has_playable_audio(asset, &track.kind, ctx.audio_info.get(&clip.asset_id))
                && !clip_audio_is_suppressed_by_companion(
                    clip,
                    track,
                    asset,
                    &audio_companion_keys,
                );

        if !clip_has_audio {
            continue;
        }

        let validated_path = validate_local_input_path(&asset.uri, "Asset file")
            .map_err(ExportError::InvalidSettings)?;

        args.push("-i".to_string());
        args.push(validated_path.to_string_lossy().to_string());

        let clip_filter_graph = ctx
            .engine
            .build_clip_filter_graph(clip, ctx.effects, None, None);
        let audio_trim_label = format!("atrim{}", input_index);
        let audio_out_label = format!("a{}", input_index);

        let audio_effects_input =
            build_audio_trim_filter(clip, input_index, &audio_trim_label, &mut filter_complex);

        if clip_filter_graph.has_audio_effects() {
            let effects_filter =
                clip_filter_graph.to_audio_filter_complex(&audio_effects_input, &audio_out_label);
            filter_complex.push_str(&effects_filter);
            filter_complex.push(';');
        } else {
            filter_complex.push_str(&format!(
                "[{}]anull[{}];",
                audio_effects_input, audio_out_label
            ));
        }

        let mixed_audio_label = apply_audio_mix_settings(
            clip,
            track,
            input_index,
            &audio_out_label,
            &mut filter_complex,
        );

        audio_streams.push(format!("[{}]", mixed_audio_label));
        input_index += 1;
    }

    if filter_complex.ends_with(';') {
        filter_complex.pop();
    }

    let final_audio_label = append_master_audio_output(
        &mut filter_complex,
        &audio_streams,
        ctx.sequence.master_volume_db,
    )
    .ok_or_else(|| ExportError::InvalidSettings("No audio tracks found in sequence".to_string()))?;

    args.push("-filter_complex".to_string());
    args.push(filter_complex);
    args.push("-map".to_string());
    args.push(final_audio_label);

    append_output_time_range_args(&mut args, ctx.settings.start_time, ctx.settings.end_time);
    args.push("-y".to_string());
    args.push(ctx.settings.output_path.to_string_lossy().to_string());

    Ok(args)
}

fn validate_optional_plan_contract(
    render_plan: Option<&RenderPlan>,
    sequence: &Sequence,
    settings: &ExportSettings,
) -> Result<(), ExportError> {
    let Some(plan) = render_plan else {
        return Ok(());
    };

    if !plan.validation.is_valid {
        return Err(ExportError::InvalidSettings(format!(
            "Render plan validation failed: {}",
            plan.validation.errors.join("; ")
        )));
    }

    if plan.sequence_id != sequence.id {
        return Err(ExportError::InvalidSettings(format!(
            "Render plan sequence '{}' does not match export sequence '{}'",
            plan.sequence_id, sequence.id
        )));
    }

    let sequence_duration = sequence.duration().max(0.0);
    let expected_start = settings.start_time.unwrap_or(0.0).max(0.0);
    let expected_end = settings
        .end_time
        .unwrap_or(sequence_duration)
        .clamp(expected_start, sequence_duration.max(expected_start));

    if (plan.output_start_sec - expected_start).abs() > TIMELINE_EPSILON_SEC
        || (plan.output_end_sec - expected_end).abs() > TIMELINE_EPSILON_SEC
    {
        return Err(ExportError::InvalidSettings(format!(
            "Render plan range {:.3}-{:.3}s does not match export range {:.3}-{:.3}s",
            plan.output_start_sec, plan.output_end_sec, expected_start, expected_end
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{Clip, SequenceFormat, Track};

    fn sequence_with_duration(sequence_id: &str, duration_sec: f64) -> Sequence {
        let mut sequence = Sequence::new("Sequence", SequenceFormat::youtube_1080());
        sequence.id = sequence_id.to_string();
        let mut track = Track::new_video("V1");
        track.add_clip(
            Clip::new("asset-1")
                .with_source_range(0.0, duration_sec)
                .place_at(0.0),
        );
        sequence.tracks.push(track);
        sequence
    }

    fn valid_plan(sequence_id: &str, start_sec: f64, end_sec: f64) -> RenderPlan {
        RenderPlan {
            sequence_id: sequence_id.to_string(),
            graph_version: 1,
            output_start_sec: start_sec,
            output_end_sec: end_sec,
            output_start_frame: 0,
            output_end_frame: 30,
            output_duration_frames: 30,
            video_layers: Vec::new(),
            audio_layers: Vec::new(),
            validation: super::super::RenderPlanValidation {
                is_valid: true,
                errors: Vec::new(),
                warnings: Vec::new(),
            },
            plan_hash: "plan-hash".to_string(),
        }
    }

    #[test]
    fn should_reject_plan_for_different_sequence() {
        let sequence = sequence_with_duration("seq-1", 1.0);
        let settings = ExportSettings::default();
        let plan = valid_plan("seq-2", 0.0, 1.0);

        let result = validate_optional_plan_contract(Some(&plan), &sequence, &settings);

        assert!(matches!(
            result,
            Err(ExportError::InvalidSettings(message))
                if message.contains("does not match export sequence")
        ));
    }

    #[test]
    fn should_reject_invalid_plan_before_building_args() {
        let sequence = sequence_with_duration("seq-1", 1.0);
        let settings = ExportSettings::default();
        let mut plan = valid_plan("seq-1", 0.0, 1.0);
        plan.validation.is_valid = false;
        plan.validation.errors.push("broken contract".to_string());

        let result = validate_optional_plan_contract(Some(&plan), &sequence, &settings);

        assert!(matches!(
            result,
            Err(ExportError::InvalidSettings(message)) if message.contains("broken contract")
        ));
    }

    #[test]
    fn should_reject_plan_for_different_export_range() {
        let sequence = sequence_with_duration("seq-1", 10.0);
        let settings = ExportSettings {
            start_time: Some(2.0),
            end_time: Some(4.0),
            ..ExportSettings::default()
        };
        let plan = valid_plan("seq-1", 0.0, 10.0);

        let result = validate_optional_plan_contract(Some(&plan), &sequence, &settings);

        assert!(matches!(
            result,
            Err(ExportError::InvalidSettings(message)) if message.contains("does not match export range")
        ));
    }
}
