import { describe, it, expect } from 'vitest';
import { createSocket } from 'dgram';
import type { Socket } from 'dgram';
import {
  cleanOutput,
  GodotRunner,
  normalizeForCompare,
  validateProjectArgs,
  validateSceneArgs,
} from '../../src/utils/godot-runner.js';
import { fixtureProjectPath, fixtureScenePath } from '../helpers/fixture-paths.js';
import { useTmpDirs } from '../helpers/tmp.js';

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
    expect(normalizeForCompare('C:\\Users\\foo\\project')).toBe('C:/Users/foo/project');
  });

  it('strips a trailing slash', () => {
    expect(normalizeForCompare('/some/path/')).toBe('/some/path');
  });

  it('strips a trailing backslash', () => {
    expect(normalizeForCompare('C:\\project\\')).toBe('C:/project');
  });

  it('handles mixed separators', () => {
    expect(normalizeForCompare('C:\\Users/foo\\project/scenes')).toBe(
      'C:/Users/foo/project/scenes',
    );
  });

  it('is stable on paths that are already normalized', () => {
    const clean = '/some/clean/path';
    expect(normalizeForCompare(clean)).toBe(clean);
  });
});

// ─── validateProjectArgs ─────────────────────────────────────────────────────

describe('validateProjectArgs', () => {
  const tmp = useTmpDirs();

  it('returns isError when projectPath is missing', () => {
    const result = validateProjectArgs({});
    expect('isError' in result).toBe(true);
  });

  it('returns isError when projectPath contains ..', () => {
    const result = validateProjectArgs({ projectPath: '/some/../path' });
    expect('isError' in result).toBe(true);
  });

  it('returns isError when directory exists but has no project.godot', () => {
    const dir = tmp.make('godot-test-');
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
  const tmp = useTmpDirs();

  it('returns isError when projectPath is missing', () => {
    const result = validateSceneArgs({});
    expect('isError' in result).toBe(true);
  });

  it('returns isError when projectPath contains ..', () => {
    const result = validateSceneArgs({ projectPath: '/some/../path' });
    expect('isError' in result).toBe(true);
  });

  it('returns isError when directory exists but has no project.godot', () => {
    const dir = tmp.make('godot-test-');
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

// ─── runtime sessions ───────────────────────────────────────────────────────

function startUdpResponder(port: number, label: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.on('message', (msg, rinfo) => {
      const parsed = JSON.parse(msg.toString('utf8')) as {
        command?: string;
        session_token?: string;
      };
      const response = JSON.stringify({
        label,
        command: parsed.command,
        session_token: parsed.session_token,
      });
      socket.send(response, rinfo.port, rinfo.address);
    });
    socket.bind(port, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.close(() => resolve()));
}

describe('GodotRunner runtime sessions', () => {
  const tmp = useTmpDirs();

  it('routes UDP commands to the selected runtime session', async () => {
    const runner = new GodotRunner();
    const firstProject = tmp.makeProject('mcp-runtime-a-');
    const secondProject = tmp.makeProject('mcp-runtime-b-');
    const firstSession = await runner.attachProject(firstProject);
    const secondSession = await runner.attachProject(secondProject);
    const sockets: Socket[] = [];

    try {
      sockets.push(await startUdpResponder(firstSession.bridge.port, 'first'));
      sockets.push(await startUdpResponder(secondSession.bridge.port, 'second'));

      const firstResponse = JSON.parse(
        await runner.sendCommand('ping', {}, 1000, firstSession.id),
      ) as { label: string; session_token: string };
      const secondResponse = JSON.parse(
        await runner.sendCommand('ping', {}, 1000, secondSession.id),
      ) as { label: string; session_token: string };

      expect(firstResponse).toMatchObject({
        label: 'first',
        session_token: firstSession.sessionToken,
      });
      expect(secondResponse).toMatchObject({
        label: 'second',
        session_token: secondSession.sessionToken,
      });
      await expect(runner.sendCommand('ping', {}, 1000)).rejects.toThrow(
        /Multiple runtime sessions/,
      );
    } finally {
      for (const socket of sockets) {
        await closeSocket(socket);
      }
      runner.stopAllProjects();
    }
  });
});
