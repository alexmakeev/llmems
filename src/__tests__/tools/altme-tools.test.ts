// src/__tests__/tools/altme-tools.test.ts
// Tests for ALTME_TOOLS definitions — structure and completeness.

import { describe, it, expect } from 'vitest';
import { ALTME_TOOLS } from '../../tools/altme-tools.ts';

describe('ALTME_TOOLS', () => {
  it('should have exactly 5 tools', () => {
    expect(ALTME_TOOLS).toHaveLength(5);
  });

  it('should define stay_silent tool', () => {
    const tool = ALTME_TOOLS.find(t => t.function.name === 'stay_silent');
    expect(tool).toBeDefined();
    expect(tool!.type).toBe('function');
    expect(tool!.function.parameters.properties).toEqual({});
  });

  it('should define set_behavior_instructions tool', () => {
    const tool = ALTME_TOOLS.find(t => t.function.name === 'set_behavior_instructions');
    expect(tool).toBeDefined();
    expect(tool!.type).toBe('function');
    expect(tool!.function.parameters.properties['new_instructions']).toBeDefined();
    expect(tool!.function.parameters.required).toContain('new_instructions');
  });

  it('all tools should have valid structure', () => {
    for (const tool of ALTME_TOOLS) {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe('object');
    }
  });

  it('stay_silent has no required parameters', () => {
    const tool = ALTME_TOOLS.find(t => t.function.name === 'stay_silent')!;
    expect(tool.function.parameters.required).toEqual([]);
  });

  it('set_behavior_instructions new_instructions is type string', () => {
    const tool = ALTME_TOOLS.find(t => t.function.name === 'set_behavior_instructions')!;
    expect(tool.function.parameters.properties['new_instructions']!.type).toBe('string');
  });

  it('should define search_quick tool', () => {
    const tool = ALTME_TOOLS.find(t => t.function.name === 'search_quick');
    expect(tool).toBeDefined();
    expect(tool!.type).toBe('function');
    expect(tool!.function.parameters.properties['query']).toBeDefined();
    expect(tool!.function.parameters.properties['query']!.type).toBe('string');
    expect(tool!.function.parameters.required).toContain('query');
  });

  it('should define web_research tool', () => {
    const tool = ALTME_TOOLS.find(t => t.function.name === 'web_research');
    expect(tool).toBeDefined();
    expect(tool!.type).toBe('function');
    expect(tool!.function.parameters.properties['query']).toBeDefined();
    expect(tool!.function.parameters.properties['query']!.type).toBe('string');
    expect(tool!.function.parameters.properties['caption']).toBeDefined();
    expect(tool!.function.parameters.properties['caption']!.type).toBe('string');
    expect(tool!.function.parameters.properties['filename']).toBeDefined();
    expect(tool!.function.parameters.properties['filename']!.type).toBe('string');
    expect(tool!.function.parameters.required).toEqual(['query', 'caption', 'filename']);
  });

  it('should define send_html_document tool', () => {
    const tool = ALTME_TOOLS.find(t => t.function.name === 'send_html_document');
    expect(tool).toBeDefined();
    expect(tool!.type).toBe('function');
    expect(tool!.function.parameters.properties['html_content']).toBeDefined();
    expect(tool!.function.parameters.properties['caption']).toBeDefined();
    expect(tool!.function.parameters.properties['summary']).toBeDefined();
    expect(tool!.function.parameters.properties['filename']).toBeDefined();
    expect(tool!.function.parameters.properties['filename']!.type).toBe('string');
    expect(tool!.function.parameters.required).toEqual(['html_content', 'caption', 'summary', 'filename']);
  });

  it('tool names are unique', () => {
    const names = ALTME_TOOLS.map(t => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
