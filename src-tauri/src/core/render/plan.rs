//! Renderer-neutral render plan derived from RenderGraph.
//!
//! This is the migration boundary between timeline interpretation and concrete
//! renderer backends. It intentionally does not build FFmpeg syntax.

use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::{
    assets::{Asset, AssetKind},
    effects::{effect_capability_dto, effect_type_label, Effect, EffectCapabilityDto},
    render::{
        AudioRenderLayer, ExportSettings, RenderGraph, VisualRenderLayer, VisualRenderSource,
    },
    timeline::{TimelineClock, TrackKind},
    AssetId, ClipId, EffectId, Frame, SequenceId, TimeSec, TrackId,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub sequence_id: SequenceId,
    pub graph_version: u32,
    pub output_start_sec: TimeSec,
    pub output_end_sec: TimeSec,
    pub output_start_frame: Frame,
    pub output_end_frame: Frame,
    pub output_duration_frames: Frame,
    pub video_layers: Vec<RenderPlanVideoLayer>,
    pub audio_layers: Vec<RenderPlanAudioLayer>,
    pub validation: RenderPlanValidation,
    pub plan_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlanVideoLayer {
    pub layer_index: usize,
    pub track_id: TrackId,
    pub track_kind: TrackKind,
    pub track_index: usize,
    pub clip_id: ClipId,
    pub layer_hash: String,
    pub timeline_in_sec: TimeSec,
    pub timeline_out_sec: TimeSec,
    pub timeline_in_frame: Frame,
    pub timeline_out_frame: Frame,
    pub duration_frames: Frame,
    pub source: RenderPlanVisualSource,
    pub effects: Vec<RenderPlanEffect>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RenderPlanVisualSource {
    Media {
        asset_id: AssetId,
        asset_kind: AssetKind,
        asset_hash: String,
    },
    Text {
        asset_id: AssetId,
    },
    Caption,
    Compound {
        sequence_id: SequenceId,
    },
    Adjustment,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlanAudioLayer {
    pub track_id: TrackId,
    pub track_index: usize,
    pub clip_id: ClipId,
    pub layer_hash: String,
    pub asset_id: AssetId,
    pub asset_hash: String,
    pub timeline_in_sec: TimeSec,
    pub timeline_out_sec: TimeSec,
    pub timeline_in_frame: Frame,
    pub timeline_out_frame: Frame,
    pub duration_frames: Frame,
    pub effects: Vec<RenderPlanEffect>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlanEffect {
    pub effect_id: EffectId,
    pub effect_label: String,
    pub effect_hash: String,
    pub capability: EffectCapabilityDto,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlanValidation {
    pub is_valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl RenderPlanValidation {
    fn valid() -> Self {
        Self {
            is_valid: true,
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn add_error(&mut self, error: impl Into<String>) {
        self.errors.push(error.into());
        self.is_valid = false;
    }
}

pub fn build_render_plan(
    graph: &RenderGraph,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
    settings: &ExportSettings,
) -> RenderPlan {
    let clock = TimelineClock::new(graph.format.fps.clone());
    let output_start_sec = settings.start_time.unwrap_or(0.0).max(0.0);
    let output_end_sec = settings
        .end_time
        .unwrap_or(graph.duration_sec)
        .clamp(output_start_sec, graph.duration_sec.max(output_start_sec));
    let output_start_frame = clock.seconds_to_nearest_frame(output_start_sec);
    let output_end_frame = clock.seconds_to_nearest_frame(output_end_sec);
    let mut validation = RenderPlanValidation::valid();

    let video_layers = graph
        .visual_layers
        .iter()
        .filter(|layer| {
            layer.timeline_out_sec > output_start_sec && layer.timeline_in_sec < output_end_sec
        })
        .map(|layer| build_video_layer(layer, assets, effects, &mut validation))
        .collect::<Vec<_>>();

    let audio_layers = graph
        .audio_layers
        .iter()
        .filter(|layer| {
            layer.timeline_out_sec > output_start_sec && layer.timeline_in_sec < output_end_sec
        })
        .map(|layer| build_audio_layer(layer, assets, effects, &mut validation))
        .collect::<Vec<_>>();

    if output_end_frame <= output_start_frame {
        validation.add_error("Render plan output range is empty");
    }

    let mut plan = RenderPlan {
        sequence_id: graph.sequence_id.clone(),
        graph_version: graph.graph_version,
        output_start_sec,
        output_end_sec,
        output_start_frame,
        output_end_frame,
        output_duration_frames: (output_end_frame - output_start_frame).max(0),
        video_layers,
        audio_layers,
        validation,
        plan_hash: String::new(),
    };
    plan.plan_hash = compute_render_plan_hash(&plan);
    plan
}

fn build_video_layer(
    layer: &VisualRenderLayer,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
    validation: &mut RenderPlanValidation,
) -> RenderPlanVideoLayer {
    let source = match &layer.source {
        VisualRenderSource::Media { asset_id } => match assets.get(asset_id) {
            Some(asset) => RenderPlanVisualSource::Media {
                asset_id: asset_id.clone(),
                asset_kind: asset.kind.clone(),
                asset_hash: asset.hash.clone(),
            },
            None => {
                validation.add_error(format!(
                    "Render graph layer '{}' references missing media asset '{}'",
                    layer.clip_id, asset_id
                ));
                RenderPlanVisualSource::Media {
                    asset_id: asset_id.clone(),
                    asset_kind: AssetKind::Video,
                    asset_hash: String::new(),
                }
            }
        },
        VisualRenderSource::Text { asset_id, .. } => RenderPlanVisualSource::Text {
            asset_id: asset_id.clone(),
        },
        VisualRenderSource::Caption { .. } => RenderPlanVisualSource::Caption,
        VisualRenderSource::Compound { sequence_id } => RenderPlanVisualSource::Compound {
            sequence_id: sequence_id.clone(),
        },
        VisualRenderSource::Adjustment => RenderPlanVisualSource::Adjustment,
    };

    RenderPlanVideoLayer {
        layer_index: layer.layer_index,
        track_id: layer.track_id.clone(),
        track_kind: layer.track_kind.clone(),
        track_index: layer.track_index,
        clip_id: layer.clip_id.clone(),
        layer_hash: render_layer_hash(layer),
        timeline_in_sec: layer.timeline_in_sec,
        timeline_out_sec: layer.timeline_out_sec,
        timeline_in_frame: layer.timeline_in_frame,
        timeline_out_frame: layer.timeline_out_frame,
        duration_frames: layer.duration_frames,
        source,
        effects: resolve_plan_effects(&layer.clip_id, &layer.effects, effects, validation),
    }
}

fn build_audio_layer(
    layer: &AudioRenderLayer,
    assets: &HashMap<String, Asset>,
    effects: &HashMap<String, Effect>,
    validation: &mut RenderPlanValidation,
) -> RenderPlanAudioLayer {
    if !assets.contains_key(&layer.asset_id) {
        validation.add_error(format!(
            "Render graph audio layer '{}' references missing asset '{}'",
            layer.clip_id, layer.asset_id
        ));
    }
    let asset_hash = assets
        .get(&layer.asset_id)
        .map(|asset| asset.hash.clone())
        .unwrap_or_default();

    RenderPlanAudioLayer {
        track_id: layer.track_id.clone(),
        track_index: layer.track_index,
        clip_id: layer.clip_id.clone(),
        layer_hash: render_layer_hash(layer),
        asset_id: layer.asset_id.clone(),
        asset_hash,
        timeline_in_sec: layer.timeline_in_sec,
        timeline_out_sec: layer.timeline_out_sec,
        timeline_in_frame: layer.timeline_in_frame,
        timeline_out_frame: layer.timeline_out_frame,
        duration_frames: layer.duration_frames,
        effects: resolve_plan_effects(&layer.clip_id, &layer.effects, effects, validation),
    }
}

fn resolve_plan_effects(
    clip_id: &str,
    effect_ids: &[EffectId],
    effects: &HashMap<String, Effect>,
    validation: &mut RenderPlanValidation,
) -> Vec<RenderPlanEffect> {
    effect_ids
        .iter()
        .filter_map(|effect_id| {
            let Some(effect) = effects.get(effect_id) else {
                validation.add_error(format!(
                    "Render graph clip '{}' references missing effect '{}'",
                    clip_id, effect_id
                ));
                return None;
            };

            if !effect.enabled {
                return None;
            }

            let capability = effect_capability_dto(&effect.effect_type);
            if capability.export == "unsupported" {
                validation.add_error(format!(
                    "Effect '{}' on clip '{}' is not supported in final export: {}",
                    effect_type_label(&effect.effect_type),
                    clip_id,
                    capability
                        .export_reason
                        .as_deref()
                        .unwrap_or("This effect is not implemented by final export.")
                ));
            }

            if !effect.keyframes.is_empty() {
                validation.add_error(format!(
                    "Keyframed effect '{}' on clip '{}' is not supported in final export yet",
                    effect_type_label(&effect.effect_type),
                    clip_id
                ));
            }

            Some(RenderPlanEffect {
                effect_id: effect_id.clone(),
                effect_label: effect_type_label(&effect.effect_type),
                effect_hash: effect_render_hash(effect),
                capability,
            })
        })
        .collect()
}

fn compute_render_plan_hash(plan: &RenderPlan) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    plan.sequence_id.hash(&mut hasher);
    plan.graph_version.hash(&mut hasher);
    plan.output_start_frame.hash(&mut hasher);
    plan.output_end_frame.hash(&mut hasher);

    for layer in &plan.video_layers {
        layer.layer_index.hash(&mut hasher);
        layer.track_id.hash(&mut hasher);
        layer.clip_id.hash(&mut hasher);
        layer.layer_hash.hash(&mut hasher);
        layer.timeline_in_frame.hash(&mut hasher);
        layer.timeline_out_frame.hash(&mut hasher);
        if let RenderPlanVisualSource::Media {
            asset_id,
            asset_hash,
            ..
        } = &layer.source
        {
            asset_id.hash(&mut hasher);
            asset_hash.hash(&mut hasher);
        }
        for effect in &layer.effects {
            effect.effect_id.hash(&mut hasher);
            effect.effect_hash.hash(&mut hasher);
            effect.capability.export.hash(&mut hasher);
        }
    }

    for layer in &plan.audio_layers {
        layer.track_id.hash(&mut hasher);
        layer.clip_id.hash(&mut hasher);
        layer.layer_hash.hash(&mut hasher);
        layer.asset_id.hash(&mut hasher);
        layer.asset_hash.hash(&mut hasher);
        layer.timeline_in_frame.hash(&mut hasher);
        layer.timeline_out_frame.hash(&mut hasher);
        for effect in &layer.effects {
            effect.effect_id.hash(&mut hasher);
            effect.effect_hash.hash(&mut hasher);
            effect.capability.export.hash(&mut hasher);
        }
    }

    format!("{:016x}", hasher.finish())
}

fn render_layer_hash<T: Serialize>(layer: &T) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match serde_json::to_string(layer) {
        Ok(serialized) => serialized.hash(&mut hasher),
        Err(error) => {
            tracing::warn!("Failed to serialize render layer for plan hash: {}", error);
        }
    }
    format!("{:016x}", hasher.finish())
}

fn effect_render_hash(effect: &Effect) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match serde_json::to_string(effect) {
        Ok(serialized) => serialized.hash(&mut hasher),
        Err(error) => {
            tracing::warn!(
                "Failed to serialize effect '{}' for render plan hash: {}",
                effect.id,
                error
            );
            effect.id.hash(&mut hasher);
            effect_type_label(&effect.effect_type).hash(&mut hasher);
        }
    }
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        assets::{Asset, VideoInfo},
        effects::{Effect, EffectType, ParamValue},
        project::ProjectState,
        render::build_render_graph,
        timeline::{Clip, ClipPlace, ClipRange, Sequence, SequenceFormat, Track},
    };

    fn clip_with_timing(id: &str, asset_id: &str, timeline_in: f64, duration: f64) -> Clip {
        let mut clip = Clip::new(asset_id);
        clip.id = id.to_string();
        clip.place = ClipPlace::new(timeline_in, duration);
        clip.range = ClipRange::new(0.0, duration);
        clip
    }

    fn video_asset(id: &str) -> Asset {
        let name = format!("{id}.mp4");
        let path = format!("/tmp/{id}.mp4");
        let mut asset = Asset::new_video(&name, &path, VideoInfo::default());
        asset.id = id.to_string();
        asset
    }

    fn graph_state() -> (ProjectState, HashMap<String, Asset>) {
        let mut state = ProjectState::new("Render Plan Test");
        state.sequences.clear();

        let mut sequence = Sequence::new("Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();
        let mut video_track = Track::new_video("Video 1");
        video_track.id = "track-video".to_string();
        video_track
            .clips
            .push(clip_with_timing("clip-1", "asset-1", 0.0, 5.0));
        sequence.tracks.push(video_track);
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);

        let assets = HashMap::from([("asset-1".to_string(), video_asset("asset-1"))]);
        (state, assets)
    }

    #[test]
    fn render_plan_is_built_from_render_graph_layers() {
        let (state, assets) = graph_state();
        let graph = build_render_graph(&state, "seq-1").expect("graph");

        let plan = build_render_plan(&graph, &assets, &HashMap::new(), &ExportSettings::default());

        assert!(plan.validation.is_valid, "{:?}", plan.validation.errors);
        assert_eq!(plan.sequence_id, "seq-1");
        assert_eq!(plan.output_duration_frames, 150);
        assert_eq!(plan.video_layers.len(), 1);
        assert_eq!(plan.video_layers[0].clip_id, "clip-1");
        assert_eq!(plan.video_layers[0].timeline_out_frame, 150);
        assert!(!plan.plan_hash.is_empty());
    }

    #[test]
    fn render_plan_respects_output_range() {
        let (state, assets) = graph_state();
        let graph = build_render_graph(&state, "seq-1").expect("graph");
        let settings = ExportSettings {
            start_time: Some(1.0),
            end_time: Some(3.0),
            ..ExportSettings::default()
        };

        let plan = build_render_plan(&graph, &assets, &HashMap::new(), &settings);

        assert_eq!(plan.output_start_frame, 30);
        assert_eq!(plan.output_end_frame, 90);
        assert_eq!(plan.output_duration_frames, 60);
        assert_eq!(plan.video_layers.len(), 1);
    }

    #[test]
    fn render_plan_reports_missing_assets_and_unsupported_effects() {
        let (mut state, assets) = graph_state();
        let effect = Effect::new(EffectType::BackgroundRemoval);
        let effect_id = effect.id.clone();
        state.effects.insert(effect_id.clone(), effect);
        state
            .sequences
            .get_mut("seq-1")
            .unwrap()
            .tracks
            .get_mut(0)
            .unwrap()
            .clips
            .get_mut(0)
            .unwrap()
            .effects
            .push(effect_id);
        let graph = build_render_graph(&state, "seq-1").expect("graph");

        let plan = build_render_plan(
            &graph,
            &HashMap::new(),
            &state.effects,
            &ExportSettings::default(),
        );

        assert!(!plan.validation.is_valid);
        assert!(plan
            .validation
            .errors
            .iter()
            .any(|error| error.contains("missing media asset")));
        assert!(plan
            .validation
            .errors
            .iter()
            .any(|error| error.contains("not supported in final export")));
        assert_eq!(assets.len(), 1);
    }

    #[test]
    fn render_plan_hash_changes_when_effect_params_change() {
        let (mut state, assets) = graph_state();
        let mut effect = Effect::new(EffectType::Brightness);
        effect.id = "effect-1".to_string();
        let effect_id = effect.id.clone();
        state.effects.insert(effect_id.clone(), effect);
        state
            .sequences
            .get_mut("seq-1")
            .unwrap()
            .tracks
            .get_mut(0)
            .unwrap()
            .clips
            .get_mut(0)
            .unwrap()
            .effects
            .push(effect_id.clone());
        let graph = build_render_graph(&state, "seq-1").expect("graph");

        let first = build_render_plan(&graph, &assets, &state.effects, &ExportSettings::default());
        state
            .effects
            .get_mut(&effect_id)
            .unwrap()
            .params
            .insert("value".to_string(), ParamValue::Float(0.45));
        let second = build_render_plan(&graph, &assets, &state.effects, &ExportSettings::default());

        assert!(first.validation.is_valid, "{:?}", first.validation.errors);
        assert!(second.validation.is_valid, "{:?}", second.validation.errors);
        assert_ne!(first.plan_hash, second.plan_hash);
    }

    #[test]
    fn render_plan_hash_changes_when_asset_hash_changes() {
        let (state, mut assets) = graph_state();
        let graph = build_render_graph(&state, "seq-1").expect("graph");

        let first = build_render_plan(&graph, &assets, &HashMap::new(), &ExportSettings::default());
        assets.get_mut("asset-1").unwrap().hash = "new-content-hash".to_string();
        let second =
            build_render_plan(&graph, &assets, &HashMap::new(), &ExportSettings::default());

        assert_ne!(first.plan_hash, second.plan_hash);
    }

    #[test]
    fn render_plan_hash_changes_when_graph_layer_render_inputs_change() {
        let (state, assets) = graph_state();
        let graph = build_render_graph(&state, "seq-1").expect("graph");
        let mut changed_graph = graph.clone();
        changed_graph.visual_layers[0].source_in_frame = 12;
        changed_graph.visual_layers[0].opacity = 0.5;

        let first = build_render_plan(&graph, &assets, &HashMap::new(), &ExportSettings::default());
        let second = build_render_plan(
            &changed_graph,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );

        assert_ne!(
            first.video_layers[0].layer_hash,
            second.video_layers[0].layer_hash
        );
        assert_ne!(first.plan_hash, second.plan_hash);
    }
}
