/**
 * Command Schemas Tests
 *
 * Tests for Zod-based command validation schemas.
 * Following TDD methodology.
 */

import { describe, it, expect } from 'vitest';
import {
  InsertClipSchema,
  SplitClipSchema,
  TrimClipSchema,
  MoveClipSchema,
  DeleteClipSchema,
  AddTrackSchema,
  DeleteTrackSchema,
  MuteTrackSchema,
  AddEffectSchema,
  UpdateEffectSchema,
  RemoveEffectSchema,
  AddTransitionSchema,
  AddKeyframeSchema,
  UpdateKeyframeSchema,
  DeleteKeyframeSchema,
  AddCaptionSchema,
  UpdateCaptionSchema,
  ExportVideoSchema,
  EditCommandSchema,
  EditScriptSchema,
  EffectType,
  TransitionType,
  EasingType,
  type EditScript,
} from './commandSchemas';

describe('commandSchemas', () => {
  // ==========================================================================
  // Timeline Command Schemas
  // ==========================================================================

  describe('InsertClipSchema', () => {
    it('should validate valid InsertClip command', () => {
      const command = {
        commandType: 'InsertClip',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          assetId: '550e8400-e29b-41d4-a716-446655440001',
          timelineStart: 5.5,
        },
      };

      const result = InsertClipSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should accept optional sourceIn and sourceOut', () => {
      const command = {
        commandType: 'InsertClip',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          assetId: '550e8400-e29b-41d4-a716-446655440001',
          timelineStart: 0,
          sourceIn: 1.5,
          sourceOut: 10.0,
        },
      };

      const result = InsertClipSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.params.sourceIn).toBe(1.5);
        expect(result.data.params.sourceOut).toBe(10.0);
      }
    });

    it('should reject negative timelineStart', () => {
      const command = {
        commandType: 'InsertClip',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          assetId: '550e8400-e29b-41d4-a716-446655440001',
          timelineStart: -1,
        },
      };

      const result = InsertClipSchema.safeParse(command);
      expect(result.success).toBe(false);
    });

    it('should reject missing required fields', () => {
      const command = {
        commandType: 'InsertClip',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
        },
      };

      const result = InsertClipSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  describe('SplitClipSchema', () => {
    it('should validate valid SplitClip command', () => {
      const command = {
        commandType: 'SplitClip',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          atTimelineSec: 5.0,
        },
      };

      const result = SplitClipSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should reject non-uuid clipId', () => {
      const command = {
        commandType: 'SplitClip',
        params: {
          clipId: 'not-a-uuid',
          atTimelineSec: 5.0,
        },
      };

      const result = SplitClipSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  describe('TrimClipSchema', () => {
    it('should validate with newSourceIn only', () => {
      const command = {
        commandType: 'TrimClip',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          newSourceIn: 2.0,
        },
      };

      const result = TrimClipSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate with newSourceOut only', () => {
      const command = {
        commandType: 'TrimClip',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          newSourceOut: 10.0,
        },
      };

      const result = TrimClipSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate with both trim params', () => {
      const command = {
        commandType: 'TrimClip',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          newSourceIn: 1.0,
          newSourceOut: 8.0,
          newTimelineIn: 0,
        },
      };

      const result = TrimClipSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  describe('MoveClipSchema', () => {
    it('should validate valid MoveClip command', () => {
      const command = {
        commandType: 'MoveClip',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          newTimelineIn: 10.0,
        },
      };

      const result = MoveClipSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should accept optional newTrackId', () => {
      const command = {
        commandType: 'MoveClip',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          newTimelineIn: 10.0,
          newTrackId: '550e8400-e29b-41d4-a716-446655440001',
        },
      };

      const result = MoveClipSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  describe('DeleteClipSchema', () => {
    it('should validate valid DeleteClip command', () => {
      const command = {
        commandType: 'DeleteClip',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
        },
      };

      const result = DeleteClipSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Track Command Schemas
  // ==========================================================================

  describe('AddTrackSchema', () => {
    it('should validate video track', () => {
      const command = {
        commandType: 'AddTrack',
        params: {
          type: 'video',
        },
      };

      const result = AddTrackSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate audio track with name', () => {
      const command = {
        commandType: 'AddTrack',
        params: {
          type: 'audio',
          name: 'Background Music',
        },
      };

      const result = AddTrackSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should reject invalid track type', () => {
      const command = {
        commandType: 'AddTrack',
        params: {
          type: 'subtitle',
        },
      };

      const result = AddTrackSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  describe('DeleteTrackSchema', () => {
    it('should validate valid DeleteTrack command', () => {
      const command = {
        commandType: 'DeleteTrack',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
        },
      };

      const result = DeleteTrackSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  describe('MuteTrackSchema', () => {
    it('should validate mute true', () => {
      const command = {
        commandType: 'MuteTrack',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          muted: true,
        },
      };

      const result = MuteTrackSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate mute false', () => {
      const command = {
        commandType: 'MuteTrack',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          muted: false,
        },
      };

      const result = MuteTrackSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Effect Command Schemas
  // ==========================================================================

  describe('AddEffectSchema', () => {
    it('should validate brightness effect', () => {
      const command = {
        commandType: 'AddEffect',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          effectType: 'brightness',
          params: { value: 1.2 },
        },
      };

      const result = AddEffectSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate chroma_key effect with params', () => {
      const command = {
        commandType: 'AddEffect',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          effectType: 'chroma_key',
          params: {
            keyColor: '#00ff00',
            similarity: 0.4,
            smoothness: 0.1,
          },
        },
      };

      const result = AddEffectSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should reject invalid effect type', () => {
      const command = {
        commandType: 'AddEffect',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          effectType: 'invalidEffect',
          params: {},
        },
      };

      const result = AddEffectSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  describe('UpdateEffectSchema', () => {
    it('should validate valid UpdateEffect command', () => {
      const command = {
        commandType: 'UpdateEffect',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          effectId: '550e8400-e29b-41d4-a716-446655440001',
          params: { value: 0.8 },
        },
      };

      const result = UpdateEffectSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  describe('RemoveEffectSchema', () => {
    it('should validate valid RemoveEffect command', () => {
      const command = {
        commandType: 'RemoveEffect',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          effectId: '550e8400-e29b-41d4-a716-446655440001',
        },
      };

      const result = RemoveEffectSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Transition Command Schemas
  // ==========================================================================

  describe('AddTransitionSchema', () => {
    it('should validate crossfade transition', () => {
      const command = {
        commandType: 'AddTransition',
        params: {
          clipAId: '550e8400-e29b-41d4-a716-446655440000',
          clipBId: '550e8400-e29b-41d4-a716-446655440001',
          type: 'crossfade',
          duration: 1.0,
        },
      };

      const result = AddTransitionSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate all transition types', () => {
      const types = ['crossfade', 'dissolve', 'wipe', 'slide', 'zoom', 'iris', 'push', 'fade'];

      for (const type of types) {
        const command = {
          commandType: 'AddTransition',
          params: {
            clipAId: '550e8400-e29b-41d4-a716-446655440000',
            clipBId: '550e8400-e29b-41d4-a716-446655440001',
            type,
            duration: 0.5,
          },
        };

        const result = AddTransitionSchema.safeParse(command);
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid transition type', () => {
      const command = {
        commandType: 'AddTransition',
        params: {
          clipAId: '550e8400-e29b-41d4-a716-446655440000',
          clipBId: '550e8400-e29b-41d4-a716-446655440001',
          type: 'invalid',
          duration: 1.0,
        },
      };

      const result = AddTransitionSchema.safeParse(command);
      expect(result.success).toBe(false);
    });

    it('should reject negative duration', () => {
      const command = {
        commandType: 'AddTransition',
        params: {
          clipAId: '550e8400-e29b-41d4-a716-446655440000',
          clipBId: '550e8400-e29b-41d4-a716-446655440001',
          type: 'crossfade',
          duration: -1.0,
        },
      };

      const result = AddTransitionSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // Keyframe Command Schemas
  // ==========================================================================

  describe('AddKeyframeSchema', () => {
    it('should validate valid AddKeyframe command', () => {
      const command = {
        commandType: 'AddKeyframe',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          paramPath: 'effects.0.brightness',
          time: 2.5,
          value: 1.2,
        },
      };

      const result = AddKeyframeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should accept optional easing', () => {
      const command = {
        commandType: 'AddKeyframe',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          paramPath: 'opacity',
          time: 0,
          value: 0,
          easing: 'easeInOut',
        },
      };

      const result = AddKeyframeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate all easing types', () => {
      const easings = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'cubicBezier', 'spring'];

      for (const easing of easings) {
        const command = {
          commandType: 'AddKeyframe',
          params: {
            clipId: '550e8400-e29b-41d4-a716-446655440000',
            paramPath: 'scale',
            time: 1.0,
            value: 1.5,
            easing,
          },
        };

        const result = AddKeyframeSchema.safeParse(command);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('UpdateKeyframeSchema', () => {
    it('should validate updating value', () => {
      const command = {
        commandType: 'UpdateKeyframe',
        params: {
          keyframeId: '550e8400-e29b-41d4-a716-446655440000',
          value: 0.5,
        },
      };

      const result = UpdateKeyframeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate updating time', () => {
      const command = {
        commandType: 'UpdateKeyframe',
        params: {
          keyframeId: '550e8400-e29b-41d4-a716-446655440000',
          time: 3.0,
        },
      };

      const result = UpdateKeyframeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate updating easing', () => {
      const command = {
        commandType: 'UpdateKeyframe',
        params: {
          keyframeId: '550e8400-e29b-41d4-a716-446655440000',
          easing: 'spring',
        },
      };

      const result = UpdateKeyframeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  describe('DeleteKeyframeSchema', () => {
    it('should validate valid DeleteKeyframe command', () => {
      const command = {
        commandType: 'DeleteKeyframe',
        params: {
          keyframeId: '550e8400-e29b-41d4-a716-446655440000',
        },
      };

      const result = DeleteKeyframeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Caption Command Schemas
  // ==========================================================================

  describe('AddCaptionSchema', () => {
    it('should validate valid AddCaption command', () => {
      const command = {
        commandType: 'AddCaption',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          text: 'Hello, World!',
          startTime: 0,
          endTime: 3.0,
        },
      };

      const result = AddCaptionSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should accept optional style', () => {
      const command = {
        commandType: 'AddCaption',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          text: 'Styled Caption',
          startTime: 5.0,
          endTime: 8.0,
          style: {
            fontFamily: 'Arial',
            fontSize: 24,
            color: '#ffffff',
          },
        },
      };

      const result = AddCaptionSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should reject empty text', () => {
      const command = {
        commandType: 'AddCaption',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          text: '',
          startTime: 0,
          endTime: 1.0,
        },
      };

      const result = AddCaptionSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  describe('UpdateCaptionSchema', () => {
    it('should validate updating text', () => {
      const command = {
        commandType: 'UpdateCaption',
        params: {
          captionId: '550e8400-e29b-41d4-a716-446655440000',
          text: 'Updated text',
        },
      };

      const result = UpdateCaptionSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate updating style', () => {
      const command = {
        commandType: 'UpdateCaption',
        params: {
          captionId: '550e8400-e29b-41d4-a716-446655440000',
          style: { fontSize: 32 },
        },
      };

      const result = UpdateCaptionSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Export Command Schemas
  // ==========================================================================

  describe('ExportVideoSchema', () => {
    it('should validate basic export', () => {
      const command = {
        commandType: 'ExportVideo',
        params: {
          preset: 'mp4-h264-1080p',
          outputPath: '/output/video.mp4',
        },
      };

      const result = ExportVideoSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should accept optional range', () => {
      const command = {
        commandType: 'ExportVideo',
        params: {
          preset: 'webm-vp9-720p',
          outputPath: '/output/video.webm',
          range: {
            start: 10.0,
            end: 30.0,
          },
        },
      };

      const result = ExportVideoSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should reject empty preset', () => {
      const command = {
        commandType: 'ExportVideo',
        params: {
          preset: '',
          outputPath: '/output/video.mp4',
        },
      };

      const result = ExportVideoSchema.safeParse(command);
      expect(result.success).toBe(false);
    });

    it('should reject empty outputPath', () => {
      const command = {
        commandType: 'ExportVideo',
        params: {
          preset: 'mp4-h264-1080p',
          outputPath: '',
        },
      };

      const result = ExportVideoSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // Discriminated Union Schema
  // ==========================================================================

  describe('EditCommandSchema', () => {
    it('should discriminate InsertClip command', () => {
      const command = {
        commandType: 'InsertClip',
        params: {
          trackId: '550e8400-e29b-41d4-a716-446655440000',
          assetId: '550e8400-e29b-41d4-a716-446655440001',
          timelineStart: 0,
        },
      };

      const result = EditCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.commandType).toBe('InsertClip');
      }
    });

    it('should discriminate AddEffect command', () => {
      const command = {
        commandType: 'AddEffect',
        params: {
          clipId: '550e8400-e29b-41d4-a716-446655440000',
          effectType: 'gaussian_blur',
          params: { radius: 5 },
        },
      };

      const result = EditCommandSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.commandType).toBe('AddEffect');
      }
    });

    it('should reject unknown command type', () => {
      const command = {
        commandType: 'UnknownCommand',
        params: {},
      };

      const result = EditCommandSchema.safeParse(command);
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // Full EditScript Schema
  // ==========================================================================

  describe('EditScriptSchema', () => {
    it('should validate complete EditScript', () => {
      const script: EditScript = {
        intent: 'Remove the middle section from 5s to 10s',
        commands: [
          {
            commandType: 'SplitClip',
            params: {
              clipId: '550e8400-e29b-41d4-a716-446655440000',
              atTimelineSec: 5,
            },
          },
          {
            commandType: 'SplitClip',
            params: {
              clipId: '550e8400-e29b-41d4-a716-446655440001',
              atTimelineSec: 10,
            },
          },
          {
            commandType: 'DeleteClip',
            params: {
              clipId: '550e8400-e29b-41d4-a716-446655440002',
            },
          },
        ],
        requires: [],
        qcRules: [],
        risk: {
          level: 'low',
          reasons: [],
        },
        explanation: 'Split at 5s and 10s, then delete the middle segment',
      };

      const result = EditScriptSchema.safeParse(script);
      expect(result.success).toBe(true);
    });

    it('should validate EditScript with requirements', () => {
      const script: EditScript = {
        intent: 'Add video to timeline',
        commands: [
          {
            commandType: 'InsertClip',
            params: {
              trackId: '550e8400-e29b-41d4-a716-446655440000',
              assetId: '550e8400-e29b-41d4-a716-446655440001',
              timelineStart: 0,
              sourceIn: 0,
            },
          },
        ],
        requires: [
          {
            type: 'asset',
            id: '550e8400-e29b-41d4-a716-446655440001',
            description: 'Main video file',
          },
          {
            type: 'track',
            id: '550e8400-e29b-41d4-a716-446655440000',
            description: 'Video track 1',
          },
        ],
        qcRules: ['Check clip doesn\'t overlap existing clips'],
        risk: {
          level: 'medium',
          reasons: ['Creates new clip on timeline'],
        },
        explanation: 'Adds the main video to the first video track',
      };

      const result = EditScriptSchema.safeParse(script);
      expect(result.success).toBe(true);
    });

    it('should reject empty intent', () => {
      const script = {
        intent: '',
        commands: [
          {
            commandType: 'DeleteClip',
            params: {
              clipId: '550e8400-e29b-41d4-a716-446655440000',
            },
          },
        ],
        requires: [],
        qcRules: [],
        risk: { level: 'low', reasons: [] },
        explanation: 'Test',
      };

      const result = EditScriptSchema.safeParse(script);
      expect(result.success).toBe(false);
    });

    it('should reject empty commands array', () => {
      const script = {
        intent: 'Do nothing',
        commands: [],
        requires: [],
        qcRules: [],
        risk: { level: 'low', reasons: [] },
        explanation: 'No commands',
      };

      const result = EditScriptSchema.safeParse(script);
      expect(result.success).toBe(false);
    });

    it('should validate all risk levels', () => {
      const levels = ['low', 'medium', 'high'];

      for (const level of levels) {
        const script = {
          intent: 'Test',
          commands: [
            {
              commandType: 'DeleteClip',
              params: {
                clipId: '550e8400-e29b-41d4-a716-446655440000',
              },
            },
          ],
          requires: [],
          qcRules: [],
          risk: { level, reasons: [] },
          explanation: 'Test',
        };

        const result = EditScriptSchema.safeParse(script);
        expect(result.success).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Type Enums
  // ==========================================================================

  describe('EffectType enum', () => {
    const allEffectTypes = [
      // Color effects
      'brightness', 'contrast', 'saturation', 'hue', 'color_balance',
      'color_wheels', 'gamma', 'levels', 'curves', 'lut',
      // Transform effects
      'crop', 'flip', 'mirror', 'rotate',
      // Blur/Sharpen
      'gaussian_blur', 'box_blur', 'motion_blur', 'radial_blur', 'sharpen', 'unsharp_mask',
      // Stylize
      'vignette', 'glow', 'film_grain', 'chromatic_aberration', 'noise', 'pixelate', 'posterize',
      // Transitions
      'cross_dissolve', 'fade', 'wipe', 'slide', 'zoom',
      // Audio
      'volume', 'gain', 'eq_band', 'compressor', 'limiter',
      'noise_reduction', 'reverb', 'delay',
      // Text
      'text_overlay', 'subtitle',
      // AI
      'background_removal', 'auto_reframe', 'face_blur', 'object_tracking',
      // Keying
      'chroma_key', 'luma_key', 'hsl_qualifier',
      // Compositing
      'blend_mode', 'opacity',
      // Audio normalization
      'loudness_normalize',
    ];

    it('should validate all 52 effect types', () => {
      for (const effect of allEffectTypes) {
        const result = EffectType.safeParse(effect);
        expect(result.success, `EffectType should accept '${effect}'`).toBe(true);
      }
    });

    it('should have exactly 52 valid values', () => {
      expect(EffectType.options).toHaveLength(52);
    });

    it('should reject legacy camelCase effect types', () => {
      const legacyTypes = ['chromaKey', 'colorCorrection', 'fadeIn', 'fadeOut', 'blur', 'scale'];
      for (const type of legacyTypes) {
        const result = EffectType.safeParse(type);
        expect(result.success, `EffectType should reject legacy '${type}'`).toBe(false);
      }
    });

    it('should accept compositing effect types from Rust backend', () => {
      expect(EffectType.safeParse('blend_mode').success).toBe(true);
      expect(EffectType.safeParse('opacity').success).toBe(true);
      expect(EffectType.safeParse('loudness_normalize').success).toBe(true);
    });
  });

  describe('TransitionType enum', () => {
    it('should validate all transition types', () => {
      const transitions = [
        'crossfade', 'dissolve', 'wipe', 'slide',
        'zoom', 'iris', 'push', 'fade',
      ];

      for (const transition of transitions) {
        const result = TransitionType.safeParse(transition);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('EasingType enum', () => {
    it('should validate all easing types', () => {
      const easings = [
        'linear', 'easeIn', 'easeOut', 'easeInOut',
        'cubicBezier', 'spring',
      ];

      for (const easing of easings) {
        const result = EasingType.safeParse(easing);
        expect(result.success).toBe(true);
      }
    });
  });
});
