//! Plan-aware FFmpeg argument builders.
//!
//! This module is the migration boundary for executable FFmpeg work. During the
//! parity migration it still consumes the legacy sequence payload, but callers
//! must enter through an optional RenderPlan contract and receive plain args
//! that are wrapped into `FfmpegInvocation` before execution.

use std::{collections::HashMap, path::Path};

use crate::core::{
    assets::Asset,
    effects::Effect,
    fs::validate_local_input_path,
    timeline::{Sequence, TrackKind},
};

use super::{
    export::{
        append_animated_video_transform_composition, append_ass_text_overlay,
        append_black_video_gap, append_drawtext_text_overlays, append_master_audio_output,
        append_output_time_range_args, append_timeline_video_output,
        append_video_stream_normalization, append_video_transform_composition,
        apply_audio_mix_settings, asset_has_playable_audio, build_audio_trim_filter,
        build_video_trim_filter, clip_audio_is_suppressed_by_companion,
        clip_composition_is_motion_only, clip_needs_transform_composition,
        collect_audio_companion_keys, collect_drawtext_text_overlays, collect_enabled_clips_sorted,
        effective_source_dimensions, generated_text_visual_end_sec, hdr_metadata_for_asset,
        is_text_clip, output_video_dimensions, output_video_fps, output_video_pixel_format,
        resolve_asset_source_dimensions, resolve_asset_source_duration, resolve_trim_source_kind,
        seed_source_dimension_cache, seed_source_duration_cache, unmeasurable_effect_message,
        AssetAudioInfo, ExportEngine, ExportError, ExportSettings, SourceFrameCountCache,
        VideoCodec, VideoTimelineSegment, TIMELINE_EPSILON_SEC,
    },
    pip_stitch::{fold_pip_groups, plan_pip_groups},
    transform_layout::{
        clip_motion_renders_animated, compute_clip_transform_layout, render_opacity,
        resolve_clip_motion_track,
    },
    transition_stitch::{
        clip_stream_frames, plan_sequence_transitions, stitch_transition_groups, ClipHandles,
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
    // Single source of truth for the output length: the video tail is padded
    // with black up to it and the audio tail with silence, so the file this
    // command writes is exactly `Sequence::output_duration()` long. Deriving it
    // from the clips this builder happens to emit a stream for would truncate
    // the render at every tail clip that renders nothing of its own — an
    // adjustment layer, a title over black, a clip on a hidden track.
    let timeline_end_sec = ctx.sequence.output_duration();
    let audio_companion_keys =
        collect_audio_companion_keys(ctx.sequence, ctx.assets, ctx.audio_info);

    let all_clips = collect_enabled_clips_sorted(ctx.sequence);

    if all_clips.is_empty() {
        return Err(ExportError::NoClips);
    }

    let use_ass_text_overlays = ctx.ass_text_overlay_path.is_some();
    let drawtext_text_overlays = if use_ass_text_overlays {
        Vec::new()
    } else {
        collect_drawtext_text_overlays(ctx.sequence, &all_clips, ctx.effects)?
    };

    let (output_width, output_height) = output_video_dimensions(ctx.sequence, ctx.settings);
    let output_fps = output_video_fps(ctx.sequence, ctx.settings);
    let output_pixel_format = output_video_pixel_format(ctx.settings);

    // The export already probed every unique asset to find out whether it has
    // audio, and that probe reports the picture size too. Seeding the cache with
    // it means the builder spawns no FFprobe of its own; assets the probe could
    // not measure are simply absent and fall through to the resolver.
    let mut source_dimensions = seed_source_dimension_cache(ctx.audio_info);

    // Which boundaries blend, and by how much. Planning once up front means the
    // trim builders, the audio mix and the stitch all read the same answer, so
    // the picture, the sound and the reported warnings cannot disagree about
    // what the render did.
    let mut source_durations = seed_source_duration_cache(ctx.audio_info);
    let transition_plan =
        plan_sequence_transitions(ctx.sequence, ctx.assets, ctx.effects, output_fps, |asset| {
            resolve_asset_source_duration(asset, &mut source_durations)
        });

    // Which clips share seconds with which, decided before a single filter is
    // emitted — because the answer changes how each clip's own chain is built. A
    // layer of a composite stages onto a transparent canvas instead of an opaque
    // black one, and that cannot be retrofitted once the chain is written.
    //
    // It reads the transition plan too: a transition folds its two sides into
    // one stream, so both sides have to be staged the same way or the opaque one
    // would black out the layers beneath it for its half of the boundary.
    let pip_plan = plan_pip_groups(ctx.sequence, &transition_plan)?;

    // Which image assets are photos and which are animations. An extension says
    // nothing about that, so the answer has to be measured; caching it keeps a
    // timeline that reuses one GIF to a single probe.
    let mut source_frame_counts = SourceFrameCountCache::new();

    let mut adjustment_layer_effects = Vec::new();
    for (clip, _track) in &all_clips {
        if clip.is_adjustment_layer() && !clip.effects.is_empty() {
            // An adjustment layer never takes part in a transition — the
            // planner refuses one outright — so it has no handles to anchor to.
            let graph = ctx.engine.build_clip_filter_graph(
                clip,
                ctx.effects,
                Some(output_width),
                Some(output_height),
                Some(output_fps),
                ClipHandles::default(),
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
            // No stream to emit. The clip still occupies the timeline, and
            // `timeline_end_sec` already accounts for it.
            continue;
        }

        args.push("-i".to_string());
        args.push(validated_path.to_string_lossy().to_string());

        // A clip in a transition renders a little more than its slot: the extra
        // comes out of unused source media, never out of the timeline. The
        // effect chain needs to know too — its stream now starts before the
        // clip's in point, so anything anchored in seconds has to move with it.
        let handles = transition_plan.handles(&clip.id);

        let clip_filter_graph = ctx.engine.build_clip_filter_graph(
            clip,
            ctx.effects,
            Some(output_width),
            Some(output_height),
            Some(output_fps),
            handles,
        );

        let source_hdr_metadata = hdr_metadata_for_asset(asset);
        let tonemap_filter = ctx
            .settings
            .build_tonemap_video_filter(&source_hdr_metadata);

        let engine_audio_fades = transition_plan.audio_fades(&clip.id);
        // The pin has to be the frame count the stitch will assume, and the
        // stitch derives it from the clip's cumulative timeline boundaries so
        // that consecutive clips telescope. Rounding this clip's own duration
        // instead would disagree by a frame on any timeline whose cut points are
        // not on frame boundaries, and `xfade` would blend at the wrong frame.
        let pinned_frames = transition_plan.touches(&clip.id).then(|| {
            clip_stream_frames(
                clip.place.timeline_in_sec,
                clip.place.timeline_out_sec(),
                handles,
                output_fps,
            )
        });
        let segment_duration_sec = match pinned_frames {
            Some(frames) => f64::from(frames) / output_fps,
            None => clip.place.duration_sec + handles.head_sec + handles.tail_sec,
        };

        match track.kind {
            TrackKind::Video => {
                if track.visible {
                    let pip_layer = pip_plan.layer(&clip.id);
                    let transparent_canvas = pip_layer.is_some();
                    let trim_label = format!("trim{}", input_index);
                    let video_out_label = format!("v{}", input_index);
                    let normalized_video_label = format!("vnorm{}", input_index);

                    let effects_out_label = if tonemap_filter.is_some() {
                        format!("vfx{}", input_index)
                    } else {
                        video_out_label.clone()
                    };

                    build_video_trim_filter(
                        clip,
                        input_index,
                        &trim_label,
                        &mut filter_complex,
                        handles,
                        resolve_trim_source_kind(asset, &mut source_frame_counts),
                    );

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

                    // A moved, scaled, rotated or translucent clip has to be
                    // drawn onto the canvas rather than fitted to it. The
                    // placement follows the source's real pixel dimensions,
                    // which is also what the preview measures.
                    //
                    // A clip composited *only* for its motion is the exception:
                    // it rendered as a plain canvas fit before motion animated,
                    // so an unmeasurable source degrades it back to that fit
                    // instead of failing the export over it. Validation raises
                    // the matching warning.
                    let composite_dimensions = if clip_needs_transform_composition(clip) {
                        let motion_only = clip_composition_is_motion_only(clip);
                        match resolve_asset_source_dimensions(asset, &mut source_dimensions) {
                            // The transform scales to an absolute size, so it has
                            // to be measured against the frame the effect chain
                            // hands it rather than against the file on disk.
                            Some(probed) => {
                                match effective_source_dimensions(probed, &clip_filter_graph) {
                                    Ok(dimensions) => Some(dimensions),
                                    Err(_) if motion_only => None,
                                    Err(effect_label) => {
                                        return Err(ExportError::InvalidSettings(
                                            unmeasurable_effect_message(&effect_label, &clip.id),
                                        ))
                                    }
                                }
                            }
                            None if motion_only => None,
                            None => {
                                return Err(ExportError::InvalidSettings(format!(
                                    "Could not determine source dimensions of asset '{}' needed to place transformed clip '{}'",
                                    asset.id, clip.id
                                )))
                            }
                        }
                    } else {
                        None
                    };

                    if let Some((source_width, source_height)) = composite_dimensions {
                        // Keyframed motion animates the composite; everything
                        // else — including motion that turns the picture, which
                        // FFmpeg cannot animate alongside a changing frame size
                        // — composites once at the clip's base transform.
                        let motion_track = resolve_clip_motion_track(
                            source_width,
                            source_height,
                            output_width,
                            output_height,
                            clip,
                            handles.head_sec,
                        )
                        .filter(|_| clip_motion_renders_animated(clip));

                        if let Some(motion_track) = motion_track {
                            append_animated_video_transform_composition(
                                &mut filter_complex,
                                &video_out_label,
                                &normalized_video_label,
                                &motion_track,
                                render_opacity(clip.opacity),
                                segment_duration_sec,
                                output_width,
                                output_height,
                                output_fps,
                                output_pixel_format,
                                transparent_canvas,
                            );
                        } else {
                            let layout = compute_clip_transform_layout(
                                source_width,
                                source_height,
                                output_width,
                                output_height,
                                &clip.transform,
                                clip.opacity,
                            );

                            append_video_transform_composition(
                                &mut filter_complex,
                                &video_out_label,
                                &normalized_video_label,
                                &layout,
                                segment_duration_sec,
                                output_width,
                                output_height,
                                output_fps,
                                output_pixel_format,
                                transparent_canvas,
                            );
                        }
                    } else {
                        append_video_stream_normalization(
                            &mut filter_complex,
                            &video_out_label,
                            &normalized_video_label,
                            output_width,
                            output_height,
                            output_fps,
                            output_pixel_format,
                            pinned_frames,
                            transparent_canvas,
                        );
                    }

                    video_segments.push(
                        VideoTimelineSegment::new(
                            format!("[{}]", normalized_video_label),
                            clip.place.timeline_in_sec,
                            clip.place.timeline_out_sec(),
                        )
                        .with_clip(clip.id.clone())
                        .with_layer(pip_layer),
                    );
                }

                if clip_has_audio && !clip.freeze_frame && !clip.audio.muted {
                    let audio_trim_label = format!("atrim{}", input_index);
                    let audio_out_label = format!("a{}", input_index);

                    let audio_effects_input = build_audio_trim_filter(
                        clip,
                        input_index,
                        &audio_trim_label,
                        &mut filter_complex,
                        handles,
                        engine_audio_fades,
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
                        handles,
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
                        handles,
                        engine_audio_fades,
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
                        handles,
                    );

                    audio_streams.push(format!("[{}]", mixed_audio_label));
                }
            }
            _ => {}
        }

        input_index += 1;
    }

    // Text and caption clips draw onto the composited picture instead of
    // contributing their own video segment. A sequence made only of them has no
    // picture at all to draw on, so it needs a base canvas; every other case is
    // covered by the black tail `append_timeline_video_output` pads out to
    // `timeline_end_sec`.
    let has_generated_text_visuals = !drawtext_text_overlays.is_empty() || use_ass_text_overlays;
    if has_generated_text_visuals && video_segments.is_empty() {
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
            video_segments.push(VideoTimelineSegment::new(
                format!("[{}]", blank_label),
                0.0,
                generated_visual_end_sec,
            ));
        }
    }

    if video_segments.is_empty() {
        return Err(ExportError::InvalidSettings(
            "Sequence has no visual clips to export".to_string(),
        ));
    }

    // Each planned boundary is folded into its neighbours here, before the
    // timeline stitch sees the list. The fold hands back one segment covering
    // exactly the same timeline span, so gaps, the black tail and the output
    // length are all decided by code that never learns a transition happened.
    let video_segments = stitch_transition_groups(
        &mut filter_complex,
        video_segments,
        &transition_plan,
        output_fps,
    )?;

    // Then every run of layers is stacked into one picture, likewise before the
    // timeline stitch sees the list. Order is forced: the transition stitch pairs
    // segments by adjacency after sorting, so folding overlaps first would leave
    // a planned boundary with nothing next to it and the transition stitch would
    // refuse the render outright.
    let video_segments = fold_pip_groups(
        &mut filter_complex,
        video_segments,
        output_fps,
        output_width,
        output_height,
        output_pixel_format,
    )?;

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
        append_ass_text_overlay(&mut filter_complex, "[outv]", ass_path)
    } else {
        append_drawtext_text_overlays(&mut filter_complex, "[outv]", &drawtext_text_overlays)
    };

    let final_audio_label = append_master_audio_output(
        &mut filter_complex,
        &audio_streams,
        ctx.sequence.master_volume_db,
        timeline_end_sec,
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

    args.extend(ctx.settings.encoder_speed_args(&video_encoder));

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
    // Same single source of truth as the video path: silence is padded out to
    // it, so the file is exactly `Sequence::output_duration()` long. Clips that
    // carry no audio — muted, frozen, text, or a silent source — are skipped
    // below but still occupy the timeline, and an export range inside their
    // span has to receive packets.
    let timeline_end_sec = ctx.sequence.output_duration();
    let audio_companion_keys =
        collect_audio_companion_keys(ctx.sequence, ctx.assets, ctx.audio_info);
    let all_clips = collect_enabled_clips_sorted(ctx.sequence);

    if all_clips.is_empty() {
        return Err(ExportError::NoClips);
    }

    // An audio-only render of a sequence with transitions has to hear the same
    // crossfades the full render does, or extracting the audio would produce a
    // different edit from the one on screen.
    let mut source_durations = seed_source_duration_cache(ctx.audio_info);
    // The *output* frame rate, exactly as the video path uses: every transition
    // length is quantised to whole output frames, so planning the audio against
    // the sequence rate would give an export with an fps override a different
    // set of crossfades from the picture it is supposed to accompany.
    let transition_plan = plan_sequence_transitions(
        ctx.sequence,
        ctx.assets,
        ctx.effects,
        output_video_fps(ctx.sequence, ctx.settings),
        |asset| resolve_asset_source_duration(asset, &mut source_durations),
    );

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

        let handles = transition_plan.handles(&clip.id);
        let clip_filter_graph =
            ctx.engine
                .build_clip_filter_graph(clip, ctx.effects, None, None, None, handles);
        let audio_trim_label = format!("atrim{}", input_index);
        let audio_out_label = format!("a{}", input_index);
        let audio_effects_input = build_audio_trim_filter(
            clip,
            input_index,
            &audio_trim_label,
            &mut filter_complex,
            handles,
            transition_plan.audio_fades(&clip.id),
        );

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
            handles,
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
        timeline_end_sec,
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
