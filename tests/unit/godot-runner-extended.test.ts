import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanOutput,
  normalizeForCompare,
  validateProjectArgs,
  validateSceneArgs,
} from '../../src/utils/godot-runner.js';
import { fixtureProjectPath, fixtureScenePath } from '../helpers/fixture-paths.js';

// ─── cleanOutput ─────────────────────────────────────────────────────────────

describe('cleanOutput', () => {
  it('strips the Godot version banner line', () => {
    const input = 'Godot Engine v4.3.stable.official\n{"ok": true}';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('strips [DEBUG] lines', () => {
    const input = '[DEBUG] some internal info\n{"ok": true}';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('strips [INFO] Operation: lines', () => {
    const input = '[INFO] Operation: add_node\n{"ok": true}';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('strips [INFO] Executing operation: lines', () => {
    const input = '[INFO] Executing operation: add_node\n{"ok": true}';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('strips empty lines', () => {
    const input = '\n\n{"ok": true}\n\n';
    expect(cleanOutput(input)).toBe('{"ok": true}');
  });

  it('passes through lines that are not banner or debug', () => {
    const input = 'some normal output line\nanother line';
    expect(cleanOutput(input)).toBe('some normal output line\nanother line');
  });

  it('strips multiple banner and debug lines, keeps content', () => {
    const input = [
      'Godot Engine v4.3.stable.official',
      '[DEBUG] loading project',
      '[INFO] Operation: create_scene',
      '',
      '{"result": "done"}',
    ].join('\n');
    expect(cleanOutput(input)).toBe('{"result": "done"}');
  });

  it('does not strip [INFO] lines that are not Operation or Executing operation', () => {
    const input = '[INFO] some other info line';
    expect(cleanOutput(input)).toBe('[INFO] some other info line');
  });
});

// ─── normalizeForCompare ──────────────────────────────────────────────────────

describe('normalizeForCompare', () => {
  it('converts Windows backslashes to forward slashes', () => {
    const result = normalizeForCompare('C:\\Users\\foo\\project');
    expect(result).not.toContain('\\');
  });

  it('strips a trailing slash', () => {
    const result = normalizeForCompare('/some/path/');
    expect(result.endsWith('/')).toBe(false);
  });

  it('strips a trailing backslash', () => {
    // After replace, trailing backslash becomes trailing slash which is then stripped
    const result = normalizeForCompare('C:\\project\\');
    expect(result.endsWith('/')).toBe(false);
    expect(result.endsWith('\\')).toBe(false);
  });

  it('handles mixed separators', () => {
    const result = normalizeForCompare('C:\\Users/foo\\project/scenes');
    expect(result).not.toContain('\\');
    expect(result.endsWith('/')).toBe(false);
  });

  it('is stable on paths that are already normalized', () => {
    const clean = '/some/clean/path';
    expect(normalizeForCompare(clean)).toBe(clean);
  });
});

// ─── validateProjectArgs ─────────────────────────────────────────────────────

describe('validateProjectArgs', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tmpDirs.length = 0;
  });

  it('returns isError when projectPath is missing', () => {
    const result = validateProjectArgs({});
    expect('isError' in result).toBe(true);
  });

  it('returns isError when projectPath contains ..', () => {
    const result = validateProjectArgs({ projectPath: '/some/../path' });
    expect('isError' in result).toBe(true);
  });

  it('returns isError when directory exists but has no project.godot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'godot-test-'));
    tmpDirs.push(dir);
    const result = validateProjectArgs({ projectPath: dir });
    expect('isError' in result).toBe(true);
  });

  it('returns validated shape with projectPath for a valid Godot project', () => {
    const result = validateProjectArgs({ projectPath: fixtureProjectPath });
    expect('isError' in result).toBe(false);
    expect((result as { projectPath: string }).projectPath).toBe(fixtureProjectPath);
  });
});

// ─── validateSceneArgs ───────────────────────────────────────────────────────

describe('validateSceneArgs', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tmpDirs.length = 0;
  });

  it('returns isError when projectPath is missing', () => {
    const result = validateSceneArgs({});
    expect('isError' in result).toBe(true);
  });

  it('returns isError when projectPath contains ..', () => {
    const result = validateSceneArgs({ projectPath: '/some/../path' });
    expect('isError' in result).toBe(true);
  });

  it('returns isError when directory exists but has no project.godot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'godot-test-'));
    tmpDirs.push(dir);
    const result = validateSceneArgs({ projectPath: dir });
    expect('isError' in result).toBe(true);
  });

  it('returns isError when scenePath contains ..', () => {
    const result = validateSceneArgs({
      projectPath: fixtureProjectPath,
      scenePath: '../outside.tscn',
    });
    expect('isError' in result).toBe(true);
  });

  it('returns isError when sceneRequired (default) and scene file does not exist', () => {
    const result = validateSceneArgs({
      projectPath: fixtureProjectPath,
      scenePath: 'nonexistent.tscn',
    });
    expect('isError' in result).toBe(true);
  });

  it('returns { projectPath, scenePath: "" } when sceneRequired:false and scenePath is absent', () => {
    const result = validateSceneArgs({ projectPath: fixtureProjectPath }, { sceneRequired: false });
    expect('isError' in result).toBe(false);
    const typed = result as { projectPath: string; scenePath: string };
    expect(typed.projectPath).toBe(fixtureProjectPath);
    expect(typed.scenePath).toBe('');
  });

  it('returns validated shape for a valid project and scene', () => {
    const result = validateSceneArgs({
      projectPath: fixtureProjectPath,
      scenePath: fixtureScenePath,
    });
    expect('isError' in result).toBe(false);
    const typed = result as { projectPath: string; scenePath: string };
    expect(typed.projectPath).toBe(fixtureProjectPath);
    expect(typed.scenePath).toBe(fixtureScenePath);
  });

  it('does not check scene existence when sceneRequired:false and scenePath is provided', () => {
    // The implementation only stat-checks scene files when sceneRequired is true
    const result = validateSceneArgs(
      { projectPath: fixtureProjectPath, scenePath: 'ghost.tscn' },
      { sceneRequired: false },
    );
    expect('isError' in result).toBe(false);
    const typed = result as { projectPath: string; scenePath: string };
    expect(typed.scenePath).toBe('ghost.tscn');
  });
});
