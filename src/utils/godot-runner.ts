import { fileURLToPath } from 'url';
import { join, dirname, normalize } from 'path';
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import { createSocket } from 'dgram';
import { randomBytes } from 'crypto';

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Debug mode from environment
const DEBUG_MODE = process.env.DEBUG === 'true';

// Bridge readiness polling
const BRIDGE_WAIT_SPAWNED_TIMEOUT_MS = 8000;
const BRIDGE_WAIT_SPAWNED_INTERVAL_MS = 300;
const BRIDGE_WAIT_ATTACHED_TIMEOUT_MS = 15000;
const BRIDGE_WAIT_ATTACHED_INTERVAL_MS = 500;
const BRIDGE_PING_TIMEOUT_MS = 1000;
const BRIDGE_HOST = '127.0.0.1';

/**
 * Normalize a path for cross-platform comparison.
 * Folds Windows backslashes to forward slashes and strips trailing slashes,
 * so Node's `path.normalize` output matches Godot's `globalize_path("res://")`.
 */
export function normalizeForCompare(p: string): string {
  return normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Extract JSON from Godot output by finding the first { or [ and matching to the end.
 * This strips debug logs, version banners, and other noise.
 */
export function extractJson(output: string): string {
  // Find the first occurrence of { or [
  const jsonStartBrace = output.indexOf('{');
  const jsonStartBracket = output.indexOf('[');

  let jsonStart = -1;
  if (jsonStartBrace === -1 && jsonStartBracket === -1) {
    return output; // No JSON found, return as-is
  } else if (jsonStartBrace === -1) {
    jsonStart = jsonStartBracket;
  } else if (jsonStartBracket === -1) {
    jsonStart = jsonStartBrace;
  } else {
    jsonStart = Math.min(jsonStartBrace, jsonStartBracket);
  }

  // Extract from JSON start to end
  const jsonPart = output.substring(jsonStart);

  // Try to parse to validate, if it fails return original
  try {
    JSON.parse(jsonPart.trim());
    return jsonPart.trim();
  } catch {
    // If the extracted part isn't valid JSON, try to find the last } or ]
    const lastBrace = jsonPart.lastIndexOf('}');
    const lastBracket = jsonPart.lastIndexOf(']');
    const lastEnd = Math.max(lastBrace, lastBracket);

    if (lastEnd > 0) {
      const extracted = jsonPart.substring(0, lastEnd + 1);
      try {
        JSON.parse(extracted);
        return extracted;
      } catch {
        return output; // Return original if still can't parse
      }
    }
    return output;
  }
}

/**
 * Strip Godot banner and debug lines from output, keeping only meaningful content.
 */
export function cleanOutput(output: string): string {
  const lines = output.split('\n');
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) return false;
    // Skip Godot version banner
    if (trimmed.startsWith('Godot Engine v')) return false;
    // Skip debug lines
    if (trimmed.startsWith('[DEBUG]')) return false;
    // Skip info lines that are just status updates
    if (trimmed.startsWith('[INFO] Operation:')) return false;
    if (trimmed.startsWith('[INFO] Executing operation:')) return false;
    return true;
  });
  return cleanedLines.join('\n');
}

export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
  totalErrorsWritten: number;
  exitCode: number | null;
  hasExited: boolean;
  sessionToken: string;
}

export type RuntimeSessionMode = 'spawned' | 'attached';

export interface RuntimeBridgeEndpoint {
  host: string;
  port: number;
}

export interface RuntimeSession {
  id: string;
  mode: RuntimeSessionMode;
  projectPath: string;
  bridge: RuntimeBridgeEndpoint;
  sessionToken: string;
  createdAt: number;
  process?: GodotProcess;
  pid?: number;
}

export interface RuntimeStopResult {
  sessionId: string;
  mode: RuntimeSessionMode;
  projectPath: string;
  bridge: RuntimeBridgeEndpoint;
  output: string[];
  errors: string[];
  externalProcessPreserved?: boolean;
}

export interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  strictPathValidation?: boolean;
}

export interface OperationParams {
  [key: string]: unknown;
}

export interface OperationResult {
  stdout: string;
  stderr: string;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  outputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
}

// Parameter mappings between snake_case and camelCase
const parameterMappings: Record<string, string> = {
  project_path: 'projectPath',
  scene_path: 'scenePath',
  root_node_type: 'rootNodeType',
  parent_node_path: 'parentNodePath',
  node_type: 'nodeType',
  node_name: 'nodeName',
  texture_path: 'texturePath',
  node_path: 'nodePath',
  output_path: 'outputPath',
  mesh_item_names: 'meshItemNames',
  new_path: 'newPath',
  file_path: 'filePath',
  script_path: 'scriptPath',
};

// Reverse mapping from camelCase to snake_case
const reverseParameterMappings: Record<string, string> = {};
for (const [snakeCase, camelCase] of Object.entries(parameterMappings)) {
  reverseParameterMappings[camelCase] = snakeCase;
}

export function logDebug(message: string): void {
  if (DEBUG_MODE) {
    console.error(`[DEBUG] ${message}`);
  }
}

export function logError(message: string): void {
  console.error(`[SERVER] ${message}`);
}

export function normalizeParameters(params: OperationParams): OperationParams {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      let normalizedKey = key;

      if (key.includes('_') && parameterMappings[key]) {
        normalizedKey = parameterMappings[key];
      }

      const value = params[key];
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[normalizedKey] = normalizeParameters(value as OperationParams);
      } else {
        result[normalizedKey] = value;
      }
    }
  }

  return result;
}

export function convertCamelToSnakeCase(params: OperationParams): OperationParams {
  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const snakeKey =
        reverseParameterMappings[key] ||
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

      const value = params[key];
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[snakeKey] = convertCamelToSnakeCase(value as OperationParams);
      } else {
        result[snakeKey] = value;
      }
    }
  }

  return result;
}

export function validatePath(path: string): boolean {
  if (!path || path.includes('..')) {
    return false;
  }
  return true;
}

/**
 * Extract the first [ERROR] message from GDScript stderr output.
 * Falls back to a generic message if no [ERROR] line is found.
 */
export function extractGdError(stderr: string): string {
  const errLine = stderr.split('\n').find((l) => l.includes('[ERROR]'));
  return errLine
    ? errLine.replace(/.*\[ERROR\]\s*/, '').trim()
    : 'see get_debug_output for details';
}

export function createErrorResponse(
  message: string,
  possibleSolutions: string[] = [],
): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  logError(`Error response: ${message}`);
  if (possibleSolutions.length > 0) {
    logError(`Possible solutions: ${possibleSolutions.join(', ')}`);
  }

  const response: {
    content: Array<{ type: 'text'; text: string }>;
    isError: boolean;
  } = {
    content: [{ type: 'text', text: message }],
    isError: true,
  };

  if (possibleSolutions.length > 0) {
    response.content.push({
      type: 'text',
      text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
    });
  }

  return response;
}

// --- Shared validation helpers ---

interface ValidatedProjectArgs {
  projectPath: string;
}

interface ValidatedSceneArgs {
  projectPath: string;
  scenePath: string;
}

type ValidationErrorResult = ReturnType<typeof createErrorResponse>;

export function validateProjectArgs(
  args: OperationParams,
): ValidatedProjectArgs | ValidationErrorResult {
  if (!args.projectPath) {
    return createErrorResponse('projectPath is required', [
      'Provide a valid path to a Godot project directory',
    ]);
  }

  if (!validatePath(args.projectPath as string)) {
    return createErrorResponse('Invalid project path', [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  const projectFile = join(args.projectPath as string, 'project.godot');
  if (!existsSync(projectFile)) {
    return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
      'Ensure the path points to a directory containing a project.godot file',
    ]);
  }

  return { projectPath: args.projectPath as string };
}

export function validateSceneArgs(
  args: OperationParams,
  opts?: { sceneRequired?: boolean },
): ValidatedSceneArgs | ValidationErrorResult {
  const projectResult = validateProjectArgs(args);
  if ('isError' in projectResult) return projectResult;

  const sceneRequired = opts?.sceneRequired !== false;

  if (!args.scenePath) {
    if (sceneRequired) {
      return createErrorResponse('scenePath is required', [
        'Provide the scene file path relative to the project',
      ]);
    }
    return { projectPath: projectResult.projectPath, scenePath: '' };
  }

  if (!validatePath(args.scenePath as string)) {
    return createErrorResponse('Invalid scene path', [
      'Provide a valid path without ".." or other potentially unsafe characters',
    ]);
  }

  if (sceneRequired) {
    const sceneFullPath = join(projectResult.projectPath, args.scenePath as string);
    if (!existsSync(sceneFullPath)) {
      return createErrorResponse(`Scene file does not exist: ${args.scenePath}`, [
        'Ensure the scene path is correct',
        'Use create_scene to create a new scene first',
      ]);
    }
  }

  return { projectPath: projectResult.projectPath, scenePath: args.scenePath as string };
}

export class GodotRunner {
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private bridgeScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private injectedProjects: Set<string> = new Set();
  private runtimeSessions: Map<string, RuntimeSession> = new Map();
  private strictPathValidation: boolean;
  public defaultSessionId: string | null = null;
  public activeProcess: GodotProcess | null = null;
  public activeProjectPath: string | null = null;
  public activeSessionMode: RuntimeSessionMode | null = null;

  constructor(config?: GodotServerConfig) {
    this.strictPathValidation = config?.strictPathValidation ?? false;
    this.operationsScriptPath = join(__dirname, '..', 'scripts', 'godot_operations.gd');
    this.bridgeScriptPath = join(__dirname, '..', 'scripts', 'mcp_bridge.gd');
    logDebug(`Operations script path: ${this.operationsScriptPath}`);

    if (config?.godotPath) {
      const normalizedPath = normalize(config.godotPath);
      if (this.isValidGodotPathSync(normalizedPath)) {
        this.godotPath = normalizedPath;
        logDebug(`Custom Godot path provided: ${this.godotPath}`);
      } else {
        console.warn(`[SERVER] Invalid custom Godot path provided: ${normalizedPath}`);
      }
    }
  }

  private isValidGodotPathSync(path: string): boolean {
    try {
      logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch {
      logDebug(`Invalid Godot path: ${path}`);
      return false;
    }
  }

  private spawnAsync(
    cmd: string,
    args: string[],
    timeoutMs: number = 10000,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const err = new Error(`Process exited with code ${code}`) as Error & {
            stdout: string;
            stderr: string;
            code: number | null;
          };
          err.stdout = stdout;
          err.stderr = stderr;
          err.code = code;
          reject(err);
        }
      });
    });
  }

  private async isValidGodotPath(path: string): Promise<boolean> {
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      logDebug(`Validating Godot path: ${path}`);

      if (path !== 'godot' && !existsSync(path)) {
        logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      await this.spawnAsync(path, ['--version']);

      logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch {
      logDebug(`Invalid Godot path: ${path}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  async detectGodotPath(): Promise<void> {
    if (this.godotPath && (await this.isValidGodotPath(this.godotPath))) {
      logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      }
    }

    const osPlatform = process.platform;
    logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = ['godot'];

    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`,
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`,
      );
    }

    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    logError(`Could not find Godot in common locations for ${osPlatform}`);

    if (this.strictPathValidation) {
      throw new Error(
        'Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.',
      );
    } else {
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }
      logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
    }
  }

  getGodotPath(): string | null {
    return this.godotPath;
  }

  async getVersion(): Promise<string> {
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const { stdout } = await this.spawnAsync(this.godotPath, ['--version']);
    return stdout.trim();
  }

  isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string,
    timeoutMs: number = 30000,
  ): Promise<OperationResult> {
    logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    logDebug(`Original operation params: ${JSON.stringify(params)}`);

    this.repairOrphanedBridge(projectPath);

    const snakeCaseParams = convertCamelToSnakeCase(params);
    logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);

    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const paramsJson = JSON.stringify(snakeCaseParams);
    const args = [
      '--headless',
      '--path',
      projectPath,
      '--script',
      this.operationsScriptPath,
      operation,
      paramsJson,
      ...(DEBUG_MODE ? ['--debug-godot'] : []),
    ];

    logDebug(`Command: ${this.godotPath} ${args.join(' ')}`);

    function cleanStdout(stdout: string): string {
      if (stdout.includes('{') || stdout.includes('[')) {
        return extractJson(stdout);
      }
      return cleanOutput(stdout);
    }

    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await this.spawnAsync(this.godotPath, args, timeoutMs));
    } catch (error: unknown) {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        stdout = execError.stdout;
        stderr = execError.stderr;
      } else {
        throw error;
      }
    }

    // If the process produced no operation output but has errors, initialization
    // failed before the script ran. Autoload errors are the most common cause.
    const operationRan = stdout.trim().length > 0 || stderr.includes('[INFO] Operation:');
    if (!operationRan && (stderr.includes('ERROR:') || stderr.includes('SCRIPT ERROR:'))) {
      throw new Error(
        `Headless Godot failed before the operation could run — likely an autoload initialization error.\n` +
          `Stderr:\n${stderr.trim()}\n\n` +
          `Use list_autoloads and remove_autoload to inspect or remove the failing autoload, then retry.`,
      );
    }

    return { stdout: cleanStdout(stdout), stderr };
  }

  launchEditor(projectPath: string): ChildProcess {
    if (!this.godotPath) {
      throw new Error('Godot path not set. Call detectGodotPath first.');
    }
    return spawn(this.godotPath, ['-e', '--path', projectPath], { stdio: 'pipe' });
  }

  private createRuntimeSessionId(): string {
    return `runtime_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  }

  private async allocateBridgePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.once('error', (err) => {
        socket.close();
        reject(err);
      });
      socket.bind(0, BRIDGE_HOST, () => {
        const { port } = socket.address() as { port: number };
        socket.close(() => resolve(port));
      });
    });
  }

  private findSessionByProject(projectPath: string): RuntimeSession | null {
    const expectedPath = normalizeForCompare(projectPath);
    for (const session of this.runtimeSessions.values()) {
      if (normalizeForCompare(session.projectPath) === expectedPath) {
        return session;
      }
    }
    return null;
  }

  private isSessionUsable(session: RuntimeSession): boolean {
    if (session.mode === 'attached') return true;
    return session.process !== undefined && !session.process.hasExited;
  }

  private syncLegacyActiveSession(): void {
    const session = this.defaultSessionId ? this.runtimeSessions.get(this.defaultSessionId) : null;
    if (!session) {
      this.defaultSessionId = null;
      this.activeProcess = null;
      this.activeProjectPath = null;
      this.activeSessionMode = null;
      return;
    }
    this.activeProcess = session.process ?? null;
    this.activeProjectPath = session.projectPath;
    this.activeSessionMode = session.mode;
  }

  private setDefaultSession(sessionId: string | null): void {
    this.defaultSessionId = sessionId;
    this.syncLegacyActiveSession();
  }

  private writeBridgeConfig(projectPath: string, session: RuntimeSession): void {
    const mcpDir = join(projectPath, '.mcp');
    if (!existsSync(mcpDir)) {
      mkdirSync(mcpDir, { recursive: true });
    }
    writeFileSync(join(mcpDir, '.gdignore'), '', 'utf8');
    writeFileSync(
      join(mcpDir, 'bridge_config.json'),
      JSON.stringify(
        {
          host: session.bridge.host,
          port: session.bridge.port,
          session_token: session.sessionToken,
          session_id: session.id,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  private removeBridgeConfig(projectPath: string): void {
    const configPath = join(projectPath, '.mcp', 'bridge_config.json');
    try {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
        logDebug(`Removed bridge config at ${configPath}`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove bridge config: ${err}`);
    }
  }

  private sessionSummary(session: RuntimeSession): Record<string, unknown> {
    return {
      sessionId: session.id,
      mode: session.mode,
      projectPath: session.projectPath,
      pid: session.pid ?? session.process?.process.pid ?? null,
      bridge: session.bridge,
      running: this.isSessionUsable(session),
      createdAt: session.createdAt,
    };
  }

  getRuntimeSessionSummaries(): Array<Record<string, unknown>> {
    return Array.from(this.runtimeSessions.values()).map((session) => this.sessionSummary(session));
  }

  resolveRuntimeSession(sessionId?: string): { session?: RuntimeSession; error?: string } {
    if (sessionId) {
      const session = this.runtimeSessions.get(sessionId);
      if (!session) {
        return {
          error: `No runtime session found for sessionId '${sessionId}'. Active sessions: ${JSON.stringify(this.getRuntimeSessionSummaries())}`,
        };
      }
      if (!this.isSessionUsable(session)) {
        return {
          session,
          error: `Runtime session '${sessionId}' is no longer running.`,
        };
      }
      return { session };
    }

    const activeSessions = Array.from(this.runtimeSessions.values()).filter((session) =>
      this.isSessionUsable(session),
    );
    if (activeSessions.length === 0) {
      if (this.runtimeSessions.size === 1) {
        const session = this.runtimeSessions.values().next().value!;
        return {
          session,
          error: `Runtime session '${session.id}' is no longer running.`,
        };
      }
      return { error: 'No active runtime session.' };
    }
    if (activeSessions.length > 1) {
      return {
        error: `Multiple runtime sessions are active. Pass sessionId to select one: ${JSON.stringify(activeSessions.map((session) => this.sessionSummary(session)))}`,
      };
    }
    return { session: activeSessions[0] };
  }

  async runProject(
    projectPath: string,
    scene?: string,
    background: boolean = false,
  ): Promise<RuntimeSession> {
    if (!this.godotPath) {
      throw new Error('Godot path not set. Call detectGodotPath first.');
    }

    const existingSession = this.findSessionByProject(projectPath);
    if (existingSession && this.isSessionUsable(existingSession)) {
      throw new Error(
        `Project already has active runtime session '${existingSession.id}'. Stop that session before starting another runtime for the same project.`,
      );
    }
    if (existingSession) {
      this.stopProject(existingSession.id);
    }

    try {
      this.injectBridgeAutoload(projectPath);
    } catch (err) {
      logDebug(`Non-fatal: Failed to inject bridge autoload: ${err}`);
    }

    const cmdArgs = ['--path', projectPath];
    if (scene && validatePath(scene)) {
      logDebug(`Adding scene parameter: ${scene}`);
      cmdArgs.push(scene);
    }

    logDebug(`Running Godot project: ${projectPath}`);
    const bridgePort = await this.allocateBridgePort();
    const sessionToken = randomBytes(16).toString('hex');
    const sessionId = this.createRuntimeSessionId();
    const spawnOptions: SpawnOptions = {
      stdio: 'pipe',
      env: {
        ...process.env,
        MCP_BRIDGE_PORT: String(bridgePort),
        MCP_SESSION_TOKEN: sessionToken,
      },
    };
    if (background) {
      spawnOptions.env = { ...spawnOptions.env, MCP_BACKGROUND: '1' };
    }
    const proc = spawn(this.godotPath, cmdArgs, spawnOptions);
    const output: string[] = [];
    const errors: string[] = [];

    const godotProcess: GodotProcess = {
      process: proc,
      output,
      errors,
      totalErrorsWritten: 0,
      exitCode: null,
      hasExited: false,
      sessionToken,
    };

    const session: RuntimeSession = {
      id: sessionId,
      mode: 'spawned',
      projectPath,
      bridge: { host: BRIDGE_HOST, port: bridgePort },
      sessionToken,
      createdAt: Date.now(),
      process: godotProcess,
      pid: proc.pid,
    };
    this.writeBridgeConfig(projectPath, session);

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      output.push(...lines);
      if (output.length > 500) output.splice(0, output.length - 500);
      lines.forEach((line: string) => {
        if (line.trim()) logDebug(`[Godot stdout] ${line}`);
      });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      godotProcess.totalErrorsWritten += lines.length;
      errors.push(...lines);
      if (errors.length > 500) errors.splice(0, errors.length - 500);
      lines.forEach((line: string) => {
        if (line.trim()) logDebug(`[Godot stderr] ${line}`);
      });
    });

    proc.on('exit', (code: number | null) => {
      logDebug(`Godot process exited with code ${code}`);
      godotProcess.exitCode = code;
      godotProcess.hasExited = true;
      this.syncLegacyActiveSession();
    });

    proc.on('error', (err: Error) => {
      console.error('Failed to start Godot process:', err);
      errors.push(`Process error: ${err.message}`);
      godotProcess.hasExited = true;
      this.syncLegacyActiveSession();
    });

    this.runtimeSessions.set(session.id, session);
    this.setDefaultSession(session.id);
    return session;
  }

  async attachProject(projectPath: string): Promise<RuntimeSession> {
    const existingSession = this.findSessionByProject(projectPath);
    if (existingSession && this.isSessionUsable(existingSession)) {
      this.setDefaultSession(existingSession.id);
      return existingSession;
    }
    if (existingSession) {
      this.stopProject(existingSession.id);
    }

    this.injectBridgeAutoload(projectPath);
    const bridgePort = await this.allocateBridgePort();
    const session: RuntimeSession = {
      id: this.createRuntimeSessionId(),
      mode: 'attached',
      projectPath,
      bridge: { host: BRIDGE_HOST, port: bridgePort },
      sessionToken: randomBytes(16).toString('hex'),
      createdAt: Date.now(),
    };
    this.writeBridgeConfig(projectPath, session);
    this.runtimeSessions.set(session.id, session);
    this.setDefaultSession(session.id);
    return session;
  }

  stopProject(sessionId?: string): RuntimeStopResult | null {
    let session: RuntimeSession | undefined;
    if (sessionId) {
      // Direct lookup — works even for dead sessions (cleanup after crash).
      session = this.runtimeSessions.get(sessionId);
    } else if (this.runtimeSessions.size === 1) {
      session = this.runtimeSessions.values().next().value!;
    } else {
      // Multiple sessions: resolveRuntimeSession picks the sole usable one.
      const resolved = this.resolveRuntimeSession();
      session = resolved.session;
    }
    if (!session) {
      return null;
    }

    if (session.mode === 'attached') {
      this.cleanupBridgeAutoload(session.projectPath);
      this.removeBridgeConfig(session.projectPath);
      this.runtimeSessions.delete(session.id);
      if (this.defaultSessionId === session.id) {
        this.setDefaultSession(this.runtimeSessions.keys().next().value ?? null);
      } else {
        this.syncLegacyActiveSession();
      }
      return {
        sessionId: session.id,
        mode: 'attached',
        projectPath: session.projectPath,
        bridge: session.bridge,
        output: [],
        errors: [],
        externalProcessPreserved: true,
      };
    }

    if (!session.process) {
      return null;
    }

    logDebug(`Stopping Godot process for runtime session ${session.id}`);
    session.process.process.kill();
    const result: RuntimeStopResult = {
      sessionId: session.id,
      mode: 'spawned',
      projectPath: session.projectPath,
      bridge: session.bridge,
      output: session.process.output,
      errors: session.process.errors,
    };
    this.cleanupBridgeAutoload(session.projectPath);
    this.removeBridgeConfig(session.projectPath);
    this.runtimeSessions.delete(session.id);
    if (this.defaultSessionId === session.id) {
      this.setDefaultSession(this.runtimeSessions.keys().next().value ?? null);
    } else {
      this.syncLegacyActiveSession();
    }

    return result;
  }

  stopAllProjects(): RuntimeStopResult[] {
    const results: RuntimeStopResult[] = [];
    for (const sessionId of Array.from(this.runtimeSessions.keys())) {
      const result = this.stopProject(sessionId);
      if (result) results.push(result);
    }
    return results;
  }

  hasActiveRuntimeSession(sessionId?: string): boolean {
    const resolved = this.resolveRuntimeSession(sessionId);
    return resolved.session !== undefined && !resolved.error;
  }

  private removeAutoloadEntry(
    projectPath: string,
    entryName: string,
    scriptFilename: string,
  ): void {
    try {
      const projectFile = join(projectPath, 'project.godot');
      if (existsSync(projectFile)) {
        let content = readFileSync(projectFile, 'utf8');
        const autoloadEntry = `${entryName}="*res://${scriptFilename}"`;

        if (content.includes(autoloadEntry)) {
          content = content.replace(
            new RegExp(`\\n?${autoloadEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'),
            '',
          );
          content = content.replace(/\[autoload\]\s*(?=\n\[|\n*$)/g, '');
          content = content.trimEnd() + '\n';
          writeFileSync(projectFile, content, 'utf8');
          logDebug(`Removed ${entryName} autoload from project.godot`);
        }
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to clean ${entryName} from project.godot: ${err}`);
    }

    try {
      const scriptFile = join(projectPath, scriptFilename);
      if (existsSync(scriptFile)) {
        unlinkSync(scriptFile);
        logDebug(`Removed ${scriptFilename} from project`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${scriptFilename}: ${err}`);
    }

    try {
      const uidFile = join(projectPath, `${scriptFilename}.uid`);
      if (existsSync(uidFile)) {
        unlinkSync(uidFile);
        logDebug(`Removed ${scriptFilename}.uid from project`);
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to remove ${scriptFilename}.uid: ${err}`);
    }
  }

  /**
   * Idempotent within a session: short-circuits on `injectedProjects` so a
   * second `attach_project`/`run_project` call does not rewrite `project.godot`.
   */
  injectBridgeAutoload(projectPath: string): void {
    if (this.injectedProjects.has(projectPath)) {
      logDebug('Bridge already injected for this project, skipping');
      return;
    }

    // Ensure .mcp/ directory exists with .gdignore so Godot skips it
    const mcpDir = join(projectPath, '.mcp');
    if (!existsSync(mcpDir)) {
      mkdirSync(mcpDir, { recursive: true });
    }
    writeFileSync(join(mcpDir, '.gdignore'), '', 'utf8');
    logDebug('Created .mcp/.gdignore');

    // Also add .mcp/ to .gitignore if not already present
    const gitignorePath = join(projectPath, '.gitignore');
    const mcpGitignoreEntry = '.mcp/';
    if (existsSync(gitignorePath)) {
      const gitignoreContent = readFileSync(gitignorePath, 'utf8');
      if (!gitignoreContent.includes(mcpGitignoreEntry)) {
        const newline = gitignoreContent.endsWith('\n') ? '' : '\n';
        writeFileSync(gitignorePath, gitignoreContent + newline + mcpGitignoreEntry + '\n', 'utf8');
        logDebug('Added .mcp/ to existing .gitignore');
      }
    } else {
      writeFileSync(gitignorePath, mcpGitignoreEntry + '\n', 'utf8');
      logDebug('Created .gitignore with .mcp/ entry');
    }

    // Clean up legacy screenshot server if present
    this.removeAutoloadEntry(projectPath, 'McpScreenshotServer', 'mcp_screenshot_server.gd');

    const destScript = join(projectPath, 'mcp_bridge.gd');
    copyFileSync(this.bridgeScriptPath, destScript);
    logDebug(`Copied bridge autoload to ${destScript}`);

    const projectFile = join(projectPath, 'project.godot');
    let content = readFileSync(projectFile, 'utf8');

    const autoloadEntry = 'McpBridge="*res://mcp_bridge.gd"';

    if (content.includes(autoloadEntry)) {
      logDebug('Bridge autoload already present, skipping injection');
      if (!existsSync(destScript)) {
        copyFileSync(this.bridgeScriptPath, destScript);
        logDebug('Re-copied missing bridge script');
      }
      this.injectedProjects.add(projectPath);
      return;
    }

    const autoloadSectionRegex = /^\[autoload\]\s*$/m;
    if (autoloadSectionRegex.test(content)) {
      content = content.replace(autoloadSectionRegex, `[autoload]\n${autoloadEntry}`);
    } else {
      content = content.trimEnd() + `\n\n[autoload]\n${autoloadEntry}\n`;
    }

    writeFileSync(projectFile, content, 'utf8');
    logDebug('Injected bridge autoload into project.godot');
    this.injectedProjects.add(projectPath);
  }

  cleanupBridgeAutoload(projectPath: string): void {
    this.removeAutoloadEntry(projectPath, 'McpBridge', 'mcp_bridge.gd');
    this.injectedProjects.delete(projectPath);
  }

  private repairOrphanedBridge(projectPath: string): void {
    const projectFile = join(projectPath, 'project.godot');
    const bridgeScript = join(projectPath, 'mcp_bridge.gd');
    if (!existsSync(projectFile)) return;
    if (existsSync(bridgeScript)) return;
    try {
      const content = readFileSync(projectFile, 'utf8');
      if (content.includes('McpBridge=')) {
        this.removeAutoloadEntry(projectPath, 'McpBridge', 'mcp_bridge.gd');
        logDebug('Cleaned up orphaned McpBridge autoload entry');
      }
    } catch (err) {
      logDebug(`Non-fatal: Failed to check/repair orphaned bridge: ${err}`);
    }
  }

  sendCommand(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
    sessionId?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const resolved = this.resolveRuntimeSession(sessionId);
      if (!resolved.session || resolved.error) {
        reject(new Error(resolved.error || 'No active runtime session'));
        return;
      }
      const session = resolved.session;
      const socket = createSocket('udp4');
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(
            new Error(`Command '${command}' timed out after ${timeoutMs}ms. Is the game running?`),
          );
        }
      }, timeoutMs);

      socket.on('message', (msg) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.close();
          resolve(msg.toString('utf8'));
        }
      });

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.close();
          reject(new Error(`UDP error for command '${command}': ${err.message}`));
        }
      });

      const payload = JSON.stringify({ command, session_token: session.sessionToken, ...params });
      const message = Buffer.from(payload);
      socket.send(message, session.bridge.port, session.bridge.host, (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timer);
          socket.close();
          reject(new Error(`Failed to send command '${command}': ${err.message}`));
        }
      });
    });
  }

  getErrorCount(): number {
    const resolved = this.resolveRuntimeSession();
    return resolved.session?.process?.totalErrorsWritten ?? 0;
  }

  getErrorsSince(marker: number, sessionId?: string): string[] {
    const resolved = this.resolveRuntimeSession(sessionId);
    const process = resolved.session?.process;
    if (!process) return [];
    const { errors, totalErrorsWritten } = process;
    const delta = totalErrorsWritten - marker;
    if (delta <= 0) return [];
    const window = delta >= errors.length ? errors.slice() : errors.slice(errors.length - delta);
    return window.filter((line) => line.trim() !== '');
  }

  private static readonly SCRIPT_ERROR_PATTERNS = [
    'SCRIPT ERROR:',
    'USER SCRIPT ERROR:',
    'GDScript error',
  ];

  extractRuntimeErrors(lines: string[]): string[] {
    return lines.filter((line) => GodotRunner.SCRIPT_ERROR_PATTERNS.some((p) => line.includes(p)));
  }

  async sendCommandWithErrors(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
    sessionId?: string,
  ): Promise<{ response: string; runtimeErrors: string[] }> {
    const resolved = this.resolveRuntimeSession(sessionId);
    if (!resolved.session) {
      throw new Error(resolved.error || 'No active runtime session');
    }
    const session = resolved.session;
    const marker = session.process?.totalErrorsWritten ?? 0;
    const response = await this.sendCommand(command, params, timeoutMs, session.id);
    const newErrors = this.getErrorsSince(marker, session.id);
    const runtimeErrors = session.mode === 'spawned' ? this.extractRuntimeErrors(newErrors) : [];
    return { response, runtimeErrors };
  }

  async waitForBridgeAttached(
    sessionId?: string,
    timeoutMs: number = BRIDGE_WAIT_ATTACHED_TIMEOUT_MS,
    intervalMs: number = BRIDGE_WAIT_ATTACHED_INTERVAL_MS,
  ): Promise<{ ready: boolean; error?: string }> {
    const resolved = this.resolveRuntimeSession(sessionId);
    if (!resolved.session) {
      return { ready: false, error: resolved.error || 'No active attached runtime session' };
    }
    const session = resolved.session;
    const deadline = Date.now() + timeoutMs;
    const expectedPath = normalizeForCompare(session.projectPath);

    while (Date.now() < deadline) {
      try {
        const response = await this.sendCommand('ping', {}, BRIDGE_PING_TIMEOUT_MS, session.id);
        const parsed = JSON.parse(response);
        if (parsed.status === 'pong' && parsed.session_token === session.sessionToken) {
          if (expectedPath && parsed.project_path) {
            const bridgePath = normalizeForCompare(parsed.project_path);
            if (bridgePath !== expectedPath) {
              return {
                ready: false,
                error: `Bridge is running for a different project (${bridgePath}), expected ${expectedPath}`,
              };
            }
          }
          if (typeof parsed.pid === 'number') {
            session.pid = parsed.pid;
          }
          return { ready: true };
        }
      } catch {
        // Expected: ping will fail until bridge is listening
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      ready: false,
      error:
        'Bridge did not respond within timeout — is Godot running with the McpBridge autoload?',
    };
  }

  async waitForBridge(
    sessionId?: string,
    timeoutMs: number = BRIDGE_WAIT_SPAWNED_TIMEOUT_MS,
    intervalMs: number = BRIDGE_WAIT_SPAWNED_INTERVAL_MS,
  ): Promise<{ ready: boolean; error?: string }> {
    const resolved = this.resolveRuntimeSession(sessionId);
    if (!resolved.session) {
      return { ready: false, error: resolved.error || 'No active spawned Godot process to verify' };
    }
    const session = resolved.session;
    const deadline = Date.now() + timeoutMs;
    const expectedToken = session.sessionToken;
    const expectedPath = normalizeForCompare(session.projectPath);

    if (!session.process || !expectedToken) {
      return { ready: false, error: 'No active spawned Godot process to verify' };
    }

    while (Date.now() < deadline) {
      if (session.process.hasExited) {
        const lastErrors = this.getRecentErrors(20, session.id);
        const errorText = lastErrors.length > 0 ? `\nLast stderr:\n${lastErrors.join('\n')}` : '';
        return {
          ready: false,
          error: `Process exited with code ${session.process.exitCode} before bridge was ready.${errorText}`,
        };
      }

      try {
        const response = await this.sendCommand(
          'ping',
          { session_token: expectedToken },
          BRIDGE_PING_TIMEOUT_MS,
          session.id,
        );
        const parsed = JSON.parse(response);
        if (parsed.status === 'pong' && parsed.session_token === expectedToken) {
          if (expectedPath && parsed.project_path) {
            const bridgePath = normalizeForCompare(parsed.project_path);
            if (bridgePath !== expectedPath) {
              return {
                ready: false,
                error: `Bridge reports project ${bridgePath}, expected ${expectedPath}`,
              };
            }
          }
          if (typeof parsed.pid === 'number') {
            session.pid = parsed.pid;
          }
          return { ready: true };
        }
      } catch {
        // Expected: ping will fail until bridge is listening
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      ready: false,
      error: 'Bridge did not respond with the expected session token within timeout',
    };
  }

  getRecentErrors(count: number = 20, sessionId?: string): string[] {
    const resolved = this.resolveRuntimeSession(sessionId);
    const process = resolved.session?.process;
    if (!process) return [];
    return process.errors.slice(-count).filter((line) => line.trim() !== '');
  }
}
