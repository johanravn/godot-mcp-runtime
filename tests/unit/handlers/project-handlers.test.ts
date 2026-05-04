import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join, sep } from 'path';
import {
  handleTakeScreenshot,
  handleListAutoloads,
  handleAddAutoload,
  handleRemoveAutoload,
  handleUpdateAutoload,
  handleGetProjectFiles,
  handleSearchProject,
  handleGetSceneDependencies,
  handleGetProjectSettings,
  handleListProjects,
} from '../../../src/tools/project-tools.js';
import type { GodotRunner } from '../../../src/utils/godot-runner.js';
import { hasError, expectErrorMatching } from '../../helpers/assertions.js';
import { fixtureProjectPath } from '../../helpers/fixture-paths.js';
import { useTmpDirs } from '../../helpers/tmp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmp = useTmpDirs();
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Create a minimal tmp Godot project (project.godot only). */
function makeTmpProject(): string {
  return tmp.makeProject('mcp-test-');
}

/** Create an empty tmp directory (no project.godot inside). */
function makeTmpEmptyDir(): string {
  return tmp.make('mcp-empty-');
}

/** Create a minimal project with one autoload registered. */
function makeTmpProjectWithAutoload(name: string, path: string): string {
  const dir = makeTmpProject();
  const content = `config_version=5\n\n[autoload]\n${name}="*res://${path}"\n`;
  writeFileSync(join(dir, 'project.godot'), content, 'utf8');
  return dir;
}

function writeTmpPng(name: string): string {
  const dir = tmp.make('mcp-screenshot-');
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(PNG_BASE64, 'base64'));
  return path;
}

function createRuntimeRunner(response: Record<string, unknown>) {
  const calls: Array<{ command: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
  const runner = {
    activeSessionMode: 'spawned',
    activeProjectPath: fixtureProjectPath,
    activeProcess: { hasExited: false },
    async sendCommandWithErrors(
      command: string,
      params: Record<string, unknown> = {},
      timeoutMs?: number,
    ) {
      calls.push({ command, params, timeoutMs });
      return { response: JSON.stringify(response), runtimeErrors: [] };
    },
  } as unknown as GodotRunner;

  return { runner, calls };
}

// ---------------------------------------------------------------------------
// handleTakeScreenshot
// ---------------------------------------------------------------------------

describe('handleTakeScreenshot', () => {
  it('returns the full inline PNG by default', async () => {
    const screenshotPath = writeTmpPng('screenshot.png');
    const { runner, calls } = createRuntimeRunner({ path: screenshotPath });

    const result = await handleTakeScreenshot(runner, {});

    expect(hasError(result)).toBe(false);
    expect(calls).toEqual([{ command: 'screenshot', params: {}, timeoutMs: 10000 }]);
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0].type).toBe('image');
    expect(content[1].text).toBe(`Screenshot saved to: ${screenshotPath}`);
    const metadata = JSON.parse(content[2].text as string);
    expect(metadata).toMatchObject({ responseMode: 'full', path: screenshotPath });
  });

  it('returns the full inline PNG when responseMode is full', async () => {
    const screenshotPath = writeTmpPng('screenshot.png');
    const { runner, calls } = createRuntimeRunner({
      path: screenshotPath,
      width: 1920,
      height: 1080,
    });

    const result = await handleTakeScreenshot(runner, { responseMode: 'full' });

    expect(hasError(result)).toBe(false);
    expect(calls[0].params).toEqual({});
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0].type).toBe('image');
    const metadata = JSON.parse(content[2].text as string);
    expect(metadata).toMatchObject({
      responseMode: 'full',
      path: screenshotPath,
      size: { width: 1920, height: 1080 },
    });
  });

  it('returns a preview image plus path metadata in preview mode', async () => {
    const screenshotPath = writeTmpPng('screenshot.png');
    const previewPath = writeTmpPng('screenshot_preview.png');
    const { runner, calls } = createRuntimeRunner({
      path: screenshotPath,
      preview_path: previewPath,
      width: 3840,
      height: 2160,
      preview_width: 960,
      preview_height: 540,
    });

    const result = await handleTakeScreenshot(runner, {
      responseMode: 'preview',
      previewMaxWidth: 960,
      previewMaxHeight: 540,
    });

    expect(hasError(result)).toBe(false);
    expect(calls).toEqual([
      {
        command: 'screenshot',
        params: { previewMaxWidth: 960, previewMaxHeight: 540 },
        timeoutMs: 10000,
      },
    ]);
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    expect(content[0].type).toBe('image');
    const metadata = JSON.parse(content[2].text as string);
    expect(metadata).toMatchObject({
      responseMode: 'preview',
      path: screenshotPath,
      previewPath,
      size: { width: 3840, height: 2160 },
      previewSize: { width: 960, height: 540 },
    });
  });

  it('uses default preview dimensions when not specified', async () => {
    const screenshotPath = writeTmpPng('screenshot.png');
    const previewPath = writeTmpPng('screenshot_preview.png');
    const { runner, calls } = createRuntimeRunner({
      path: screenshotPath,
      preview_path: previewPath,
      width: 1920,
      height: 1080,
      preview_width: 960,
      preview_height: 540,
    });

    const result = await handleTakeScreenshot(runner, { responseMode: 'preview' });

    expect(hasError(result)).toBe(false);
    expect(calls[0].params).toEqual({ previewMaxWidth: 960, previewMaxHeight: 540 });
  });

  it('returns metadata only in path_only mode', async () => {
    const screenshotPath = writeTmpPng('screenshot.png');
    const { runner } = createRuntimeRunner({ path: screenshotPath });

    const result = await handleTakeScreenshot(runner, { responseMode: 'path_only' });

    expect(hasError(result)).toBe(false);
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    expect(content.some((item) => item.type === 'image')).toBe(false);
    const metadata = JSON.parse(content[1].text as string);
    expect(metadata).toMatchObject({ responseMode: 'path_only', path: screenshotPath });
  });

  it('rejects invalid responseMode', async () => {
    const { runner } = createRuntimeRunner({ path: writeTmpPng('screenshot.png') });

    const result = await handleTakeScreenshot(runner, { responseMode: 'small' });

    expectErrorMatching(result, /responseMode/);
  });

  it('rejects invalid preview dimensions', async () => {
    const { runner } = createRuntimeRunner({ path: writeTmpPng('screenshot.png') });

    const result = await handleTakeScreenshot(runner, {
      responseMode: 'preview',
      previewMaxWidth: 0,
    });

    expectErrorMatching(result, /preview dimensions/i);
  });

  it('errors when the screenshot file is missing', async () => {
    const { runner } = createRuntimeRunner({
      path: join(tmp.make('mcp-screenshot-'), 'missing.png'),
    });

    const result = await handleTakeScreenshot(runner, {});

    expectErrorMatching(result, /not found/i);
  });
});

// ---------------------------------------------------------------------------
// handleListAutoloads
// ---------------------------------------------------------------------------

describe('handleListAutoloads', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleListAutoloads({});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleListAutoloads({ projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project directory', async () => {
    const result = await handleListAutoloads({ projectPath: '/does/not/exist' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('returns autoloads list for valid project', async () => {
    const result = await handleListAutoloads({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleAddAutoload
// ---------------------------------------------------------------------------

describe('handleAddAutoload', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleAddAutoload({
      autoloadName: 'MyManager',
      autoloadPath: 'autoload/my.gd',
    });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleAddAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
      autoloadPath: 'autoload/my.gd',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleAddAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
      autoloadPath: 'autoload/my.gd',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing autoloadName', async () => {
    const result = await handleAddAutoload({
      projectPath: fixtureProjectPath,
      autoloadPath: 'autoload/my.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing autoloadPath', async () => {
    const result = await handleAddAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'MyManager',
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects autoloadPath containing ..', async () => {
    const result = await handleAddAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'MyManager',
      autoloadPath: '../outside.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('registers autoload in a fresh tmp project', async () => {
    const dir = makeTmpProject();
    const result = await handleAddAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      autoloadPath: 'scripts/test.gd',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleRemoveAutoload
// ---------------------------------------------------------------------------

describe('handleRemoveAutoload', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleRemoveAutoload({ autoloadName: 'MyManager' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleRemoveAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleRemoveAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing autoloadName', async () => {
    const result = await handleRemoveAutoload({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when named autoload does not exist', async () => {
    const result = await handleRemoveAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'NonExistentAutoload',
    });
    expect(hasError(result)).toBe(true);
  });

  it('removes an existing autoload in a tmp project', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/test.gd');
    const result = await handleRemoveAutoload({ projectPath: dir, autoloadName: 'TestManager' });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleUpdateAutoload
// ---------------------------------------------------------------------------

describe('handleUpdateAutoload', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleUpdateAutoload({ autoloadName: 'MyManager' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleUpdateAutoload({
      projectPath: '../evil',
      autoloadName: 'MyManager',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleUpdateAutoload({
      projectPath: '/ghost',
      autoloadName: 'MyManager',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing autoloadName', async () => {
    const result = await handleUpdateAutoload({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('rejects autoloadPath containing ..', async () => {
    const result = await handleUpdateAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'MyManager',
      autoloadPath: '../escape.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns isError when named autoload does not exist', async () => {
    const result = await handleUpdateAutoload({
      projectPath: fixtureProjectPath,
      autoloadName: 'NonExistentAutoload',
      autoloadPath: 'scripts/new.gd',
    });
    expect(hasError(result)).toBe(true);
  });

  it('updates an existing autoload in a tmp project', async () => {
    const dir = makeTmpProjectWithAutoload('TestManager', 'scripts/old.gd');
    const result = await handleUpdateAutoload({
      projectPath: dir,
      autoloadName: 'TestManager',
      autoloadPath: 'scripts/new.gd',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGetProjectFiles
// ---------------------------------------------------------------------------

describe('handleGetProjectFiles', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetProjectFiles({});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetProjectFiles({ projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetProjectFiles({ projectPath: '/ghost' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('returns file tree for valid project', async () => {
    const result = await handleGetProjectFiles({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleSearchProject
// ---------------------------------------------------------------------------

describe('handleSearchProject', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleSearchProject({ pattern: 'Node2D' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleSearchProject({ projectPath: '../evil', pattern: 'Node2D' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleSearchProject({ projectPath: '/ghost', pattern: 'Node2D' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing pattern', async () => {
    const result = await handleSearchProject({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(true);
  });

  it('returns results for valid project and pattern', async () => {
    const result = await handleSearchProject({
      projectPath: fixtureProjectPath,
      pattern: 'Node2D',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGetSceneDependencies
// ---------------------------------------------------------------------------

describe('handleGetSceneDependencies', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetSceneDependencies({ scenePath: 'main.tscn' });
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: '../evil',
      scenePath: 'main.tscn',
    });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: '/ghost',
      scenePath: 'main.tscn',
    });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('rejects missing scenePath', async () => {
    const result = await handleGetSceneDependencies({ projectPath: fixtureProjectPath });
    expectErrorMatching(result, /scenePath/i);
  });

  it('rejects scenePath containing ..', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: '../outside.tscn',
    });
    // handleGetSceneDependencies validates scenePath inline ("Invalid scenePath")
    // rather than via validateSceneArgs ("Invalid scene path") — match either.
    expectErrorMatching(result, /invalid scene\s?path/i);
  });

  it('returns isError when scene file does not exist', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: 'nonexistent.tscn',
    });
    expect(hasError(result)).toBe(true);
  });

  it('returns dependencies for the fixture main.tscn', async () => {
    const result = await handleGetSceneDependencies({
      projectPath: fixtureProjectPath,
      scenePath: 'main.tscn',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleGetProjectSettings
// ---------------------------------------------------------------------------

describe('handleGetProjectSettings', () => {
  it('rejects missing projectPath', async () => {
    const result = await handleGetProjectSettings({});
    expectErrorMatching(result, /projectPath/i);
  });

  it('rejects projectPath containing ..', async () => {
    const result = await handleGetProjectSettings({ projectPath: '../evil' });
    expectErrorMatching(result, /invalid project path/i);
  });

  it('rejects nonexistent project', async () => {
    const result = await handleGetProjectSettings({ projectPath: '/ghost' });
    expectErrorMatching(result, /not a valid godot project/i);
  });

  it('returns settings for valid project', async () => {
    const result = await handleGetProjectSettings({ projectPath: fixtureProjectPath });
    expect(hasError(result)).toBe(false);
  });

  it('returns filtered section when section is provided', async () => {
    const result = await handleGetProjectSettings({
      projectPath: fixtureProjectPath,
      section: 'application',
    });
    expect(hasError(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleListProjects
// ---------------------------------------------------------------------------

describe('handleListProjects', () => {
  it('rejects missing directory', async () => {
    const result = await handleListProjects({});
    expect(hasError(result)).toBe(true);
  });

  it('rejects directory containing ..', async () => {
    const result = await handleListProjects({ directory: '../evil' });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent directory', async () => {
    const result = await handleListProjects({ directory: '/ghost/path' });
    expect(hasError(result)).toBe(true);
  });

  it('returns a list (possibly empty) for a valid directory', async () => {
    // Fresh empty dir — guarantees no ambient Godot projects scanned.
    const dir = makeTmpEmptyDir();
    const result = await handleListProjects({ directory: dir });
    expect(hasError(result)).toBe(false);
  });

  it('finds a project in a tmp dir that contains one', async () => {
    const dir = makeTmpProject();
    // parentDir is the dir that contains dir
    const parentDir = join(dir, '..').replace(/[/\\]$/, '');
    const projectName = dir.split(sep).pop()!;
    const result = await handleListProjects({ directory: parentDir });
    expect(hasError(result)).toBe(false);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain(projectName);
  });
});
