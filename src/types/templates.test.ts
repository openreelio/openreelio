import { describe, it, expect } from 'vitest';
import {
  getParamDefault,
  createTemplateInstance,
  getTextValue,
  getColorValue,
  getNumberValue,
  getBooleanValue,
  getInstanceValue,
  filterByCategory,
  searchTemplates,
  createBuiltinLibrary,
  LOWER_THIRD_SIMPLE,
  TITLE_CARD_CENTERED,
  END_SCREEN_SUBSCRIBE,
  BUILTIN_TEMPLATES,
} from './templates';
import type {
  TemplateParam,
  TemplateInstance,
  MotionGraphicsTemplate,
} from './templates';

describe('Template types', () => {
  describe('getParamDefault', () => {
    it('should get text default', () => {
      const param = LOWER_THIRD_SIMPLE.parameters[0];
      const value = getParamDefault(param);
      expect(value.type).toBe('text');
      if (value.type === 'text') {
        expect(value.value).toBe('John Smith');
      }
    });

    it('should get color default', () => {
      const param = LOWER_THIRD_SIMPLE.parameters[2];
      const value = getParamDefault(param);
      expect(value.type).toBe('color');
      if (value.type === 'color') {
        expect(value.value).toBe('#000000CC');
      }
    });

    it('should get number default', () => {
      const param = TITLE_CARD_CENTERED.parameters[2];
      const value = getParamDefault(param);
      expect(value.type).toBe('number');
      if (value.type === 'number') {
        expect(value.value).toBe(0.7);
      }
    });

    it('should get toggle default as boolean', () => {
      const toggleParam: TemplateParam = {
        id: 'show_icon',
        name: 'Show Icon',
        paramType: { type: 'toggle', default: true, label: 'Display icon' },
      };
      const value = getParamDefault(toggleParam);
      expect(value.type).toBe('boolean');
      if (value.type === 'boolean') {
        expect(value.value).toBe(true);
      }
    });

    it('should get choice default as text', () => {
      const choiceParam: TemplateParam = {
        id: 'position',
        name: 'Position',
        paramType: {
          type: 'choice',
          default: 'bottom',
          options: ['top', 'bottom', 'left', 'right'],
          label: 'Position',
        },
      };
      const value = getParamDefault(choiceParam);
      expect(value.type).toBe('text');
      if (value.type === 'text') {
        expect(value.value).toBe('bottom');
      }
    });
  });

  describe('createTemplateInstance', () => {
    it('should create instance with defaults', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      expect(instance.templateId).toBe('lower_third_simple');
      expect(instance.duration).toBe(5);
      expect(Object.keys(instance.values).length).toBe(5);
    });

    it('should populate all parameter values', () => {
      const instance = createTemplateInstance(TITLE_CARD_CENTERED);
      expect(instance.values['title']).toBeDefined();
      expect(instance.values['subtitle']).toBeDefined();
      expect(instance.values['bg_opacity']).toBeDefined();
    });

    it('should use template default duration', () => {
      const instance = createTemplateInstance(END_SCREEN_SUBSCRIBE);
      expect(instance.duration).toBe(10);
    });
  });

  describe('getInstanceValue', () => {
    it('should return value for existing param', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      const value = getInstanceValue(instance, 'primary_text');
      expect(value).toBeDefined();
      expect(value?.type).toBe('text');
    });

    it('should return undefined for missing param', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      const value = getInstanceValue(instance, 'nonexistent');
      expect(value).toBeUndefined();
    });
  });

  describe('getTextValue', () => {
    it('should get text value from instance', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      const value = getTextValue(instance, 'primary_text');
      expect(value).toBe('John Smith');
    });

    it('should return undefined for missing param', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      const value = getTextValue(instance, 'nonexistent');
      expect(value).toBeUndefined();
    });

    it('should return undefined for non-text param', () => {
      const instance = createTemplateInstance(TITLE_CARD_CENTERED);
      const value = getTextValue(instance, 'bg_opacity');
      expect(value).toBeUndefined();
    });
  });

  describe('getColorValue', () => {
    it('should get color value from instance', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      const value = getColorValue(instance, 'bg_color');
      expect(value).toBe('#000000CC');
    });

    it('should return undefined for non-color param', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      const value = getColorValue(instance, 'primary_text');
      expect(value).toBeUndefined();
    });
  });

  describe('getNumberValue', () => {
    it('should get number value from instance', () => {
      const instance = createTemplateInstance(TITLE_CARD_CENTERED);
      const value = getNumberValue(instance, 'bg_opacity');
      expect(value).toBe(0.7);
    });

    it('should return undefined for non-number param', () => {
      const instance = createTemplateInstance(TITLE_CARD_CENTERED);
      const value = getNumberValue(instance, 'title');
      expect(value).toBeUndefined();
    });
  });

  describe('getBooleanValue', () => {
    it('should get boolean value from instance', () => {
      const instance: TemplateInstance = {
        templateId: 'test',
        values: {
          enabled: { type: 'boolean', value: true },
        },
        duration: 5,
      };
      const value = getBooleanValue(instance, 'enabled');
      expect(value).toBe(true);
    });

    it('should return undefined for non-boolean param', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      const value = getBooleanValue(instance, 'primary_text');
      expect(value).toBeUndefined();
    });
  });

  describe('filterByCategory', () => {
    it('should filter by lower third', () => {
      const filtered = filterByCategory(BUILTIN_TEMPLATES, 'lowerThird');
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe('lower_third_simple');
    });

    it('should filter by end screen', () => {
      const filtered = filterByCategory(BUILTIN_TEMPLATES, 'endScreen');
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe('end_screen_subscribe');
    });

    it('should filter by title card', () => {
      const filtered = filterByCategory(BUILTIN_TEMPLATES, 'titleCard');
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe('title_card_centered');
    });

    it('should return empty array for no matches', () => {
      const filtered = filterByCategory(BUILTIN_TEMPLATES, 'transition');
      expect(filtered.length).toBe(0);
    });

    it('should return empty array for custom category', () => {
      const filtered = filterByCategory(BUILTIN_TEMPLATES, 'custom');
      expect(filtered.length).toBe(0);
    });
  });

  describe('searchTemplates', () => {
    it('should search by name', () => {
      const results = searchTemplates(BUILTIN_TEMPLATES, 'lower');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('lower_third_simple');
    });

    it('should search by tag', () => {
      const results = searchTemplates(BUILTIN_TEMPLATES, 'youtube');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('end_screen_subscribe');
    });

    it('should search by description', () => {
      const results = searchTemplates(BUILTIN_TEMPLATES, 'subtitle');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('title_card_centered');
    });

    it('should be case insensitive', () => {
      const results = searchTemplates(BUILTIN_TEMPLATES, 'TITLE');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return multiple matches', () => {
      const results = searchTemplates(BUILTIN_TEMPLATES, 'title');
      expect(results.length).toBe(2); // lower third has 'title' param, title card has 'title' in name
    });

    it('should return empty array for no matches', () => {
      const results = searchTemplates(BUILTIN_TEMPLATES, 'xyznonexistent');
      expect(results.length).toBe(0);
    });
  });

  describe('built-in templates', () => {
    it('should have 3 built-in templates', () => {
      expect(BUILTIN_TEMPLATES.length).toBe(3);
    });

    it('should create library with built-ins', () => {
      const library = createBuiltinLibrary();
      expect(library.templates.length).toBe(3);
    });

    it('should create independent library copies', () => {
      const library1 = createBuiltinLibrary();
      const library2 = createBuiltinLibrary();
      library1.templates.push({
        id: 'test',
        name: 'Test',
        description: '',
        category: 'custom',
        version: '1.0.0',
        parameters: [],
        elements: [],
        defaultDuration: 5,
        tags: [],
      });
      expect(library1.templates.length).toBe(4);
      expect(library2.templates.length).toBe(3);
    });

    it('lower third should have correct structure', () => {
      expect(LOWER_THIRD_SIMPLE.category).toBe('lowerThird');
      expect(LOWER_THIRD_SIMPLE.parameters.length).toBe(5);
      expect(LOWER_THIRD_SIMPLE.defaultDuration).toBe(5);
      expect(LOWER_THIRD_SIMPLE.version).toBe('1.0.0');
      expect(LOWER_THIRD_SIMPLE.tags).toContain('lower third');
    });

    it('title card should have correct structure', () => {
      expect(TITLE_CARD_CENTERED.category).toBe('titleCard');
      expect(TITLE_CARD_CENTERED.defaultDuration).toBe(4);
      expect(TITLE_CARD_CENTERED.parameters.length).toBe(3);
      expect(TITLE_CARD_CENTERED.tags).toContain('chapter');
    });

    it('end screen should have correct structure', () => {
      expect(END_SCREEN_SUBSCRIBE.category).toBe('endScreen');
      expect(END_SCREEN_SUBSCRIBE.defaultDuration).toBe(10);
      expect(END_SCREEN_SUBSCRIBE.parameters.length).toBe(3);
      expect(END_SCREEN_SUBSCRIBE.tags).toContain('subscribe');
    });

    it('all built-ins should have required fields', () => {
      for (const template of BUILTIN_TEMPLATES) {
        expect(template.id).toBeTruthy();
        expect(template.name).toBeTruthy();
        expect(template.description).toBeTruthy();
        expect(template.category).toBeTruthy();
        expect(template.version).toBeTruthy();
        expect(template.defaultDuration).toBeGreaterThan(0);
        expect(Array.isArray(template.parameters)).toBe(true);
        expect(Array.isArray(template.elements)).toBe(true);
        expect(Array.isArray(template.tags)).toBe(true);
      }
    });

    it('all parameters should have required fields', () => {
      for (const template of BUILTIN_TEMPLATES) {
        for (const param of template.parameters) {
          expect(param.id).toBeTruthy();
          expect(param.name).toBeTruthy();
          expect(param.paramType).toBeDefined();
          expect(param.paramType.type).toBeTruthy();
        }
      }
    });
  });

  describe('TemplateInstance modification', () => {
    it('should allow modifying instance values', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      instance.values['primary_text'] = { type: 'text', value: 'Jane Doe' };
      expect(getTextValue(instance, 'primary_text')).toBe('Jane Doe');
    });

    it('should allow modifying instance duration', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      instance.duration = 10;
      expect(instance.duration).toBe(10);
    });

    it('should allow adding new values', () => {
      const instance = createTemplateInstance(LOWER_THIRD_SIMPLE);
      instance.values['custom_param'] = { type: 'text', value: 'custom value' };
      expect(getTextValue(instance, 'custom_param')).toBe('custom value');
    });
  });

  describe('edge cases', () => {
    it('should handle empty template parameters', () => {
      const emptyTemplate: MotionGraphicsTemplate = {
        id: 'empty',
        name: 'Empty',
        description: '',
        category: 'custom',
        version: '1.0.0',
        parameters: [],
        elements: [],
        defaultDuration: 5,
        tags: [],
      };
      const instance = createTemplateInstance(emptyTemplate);
      expect(Object.keys(instance.values).length).toBe(0);
      expect(instance.duration).toBe(5);
    });

    it('should handle empty search query', () => {
      const results = searchTemplates(BUILTIN_TEMPLATES, '');
      expect(results.length).toBe(3); // All templates match empty string
    });

    it('should handle whitespace in search query', () => {
      const results = searchTemplates(BUILTIN_TEMPLATES, 'lower third');
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
