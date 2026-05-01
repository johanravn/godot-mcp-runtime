/**
 * Fake GodotRunner for handler unit tests.
 *
 * Handler tests should *not* mock the real GodotRunner internals or the
 * Godot binary. They want to assert: "given this validated input, did the
 * handler call executeOperation with the right (operation, params,
 * projectPath), and did it shape the result correctly?"
 *
 * Build a FakeRunner with `createFakeRunner({ stdout, stderr })` for the
 * happy path, or `createFakeRunner({ throws: new Error(...) })` to exercise
 * the catch branch. Inspect `runner.calls` after the handler runs.
 */

import type {
  GodotRunner,
  OperationParams,
  OperationResult,
} from '../../src/utils/godot-runner.js';

export interface FakeRunnerCall {
  operation: string;
  params: OperationParams;
  projectPath: string;
  timeoutMs?: number;
}

export interface FakeRunnerOptions {
  /** Stdout the runner returns. Default: empty string. */
  stdout?: string;
  /** Stderr the runner returns. Default: empty string. */
  stderr?: string;
  /** If set, executeOperation throws this instead of returning. */
  throws?: Error;
  /** Override per call by index. Each entry shadows the defaults above. */
  responses?: Array<Partial<Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'>>>;
}

export interface FakeRunner {
  /** Recorded calls to executeOperation, in order. */
  calls: FakeRunnerCall[];
  /** The runner cast to GodotRunner — pass directly to handlers. */
  asRunner: GodotRunner;
  /** Mutate the default response after construction. */
  setResponse(opts: Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'>): void;
}

export function createFakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const calls: FakeRunnerCall[] = [];
  let defaults: Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'> = {
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    throws: options.throws,
  };
  const responses = options.responses ?? [];

  const fake = {
    calls,
    setResponse(opts: Pick<FakeRunnerOptions, 'stdout' | 'stderr' | 'throws'>) {
      defaults = { ...defaults, ...opts };
    },
    async executeOperation(
      operation: string,
      params: OperationParams,
      projectPath: string,
      timeoutMs?: number,
    ): Promise<OperationResult> {
      const callIndex = calls.length;
      calls.push({ operation, params, projectPath, timeoutMs });
      const override = responses[callIndex] ?? {};
      const merged = { ...defaults, ...override };
      if (merged.throws) throw merged.throws;
      return { stdout: merged.stdout ?? '', stderr: merged.stderr ?? '' };
    },
  };

  return {
    calls,
    asRunner: fake as unknown as GodotRunner,
    setResponse: fake.setResponse,
  };
}
