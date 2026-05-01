# Tests

Index of what is tested where. Update this file when adding a new test file or fixture.

See `../CONTRIBUTING.md` for the testing philosophy (when, what, how).

## Layout

```
tests/
├── unit/             Pure-function and shape-contract tests. No Godot, no I/O.
├── integration/      Tests that touch fixtures or run real Godot.
│                     Godot-required tests skip when GODOT_PATH is unset.
├── fixtures/         Committed test inputs.
│   └── godot-project/  Minimal Godot 4 project (Node2D + Label + Sprite2D)
└── README.md         This file.
```

## Coverage map

| File                          | Covers                                                                                                                   | Notes                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `unit/godot-runner.test.ts`   | `normalizeParameters`, `convertCamelToSnakeCase`, `validatePath`, `extractGdError`, `createErrorResponse`, `extractJson` | First batch from dev-bootstrap |
| `integration/fixture.test.ts` | Smoke check that `tests/fixtures/godot-project/` is well-formed                                                          | No Godot required              |

(Add new rows here as test files land.)

## Running

```
npm test              # full suite
npm run test:watch    # watch mode during development
npm run test:coverage # v8 coverage report (no enforcement, just visibility)
```

## Godot-required tests

Tests that need a real Godot process gate themselves with `it.skipIf(!process.env.GODOT_PATH)`. Set `GODOT_PATH` to your Godot 4.x executable to run them locally:

```
# bash / git bash
GODOT_PATH="D:/Godot/Godot_v4.5.1/Godot_v4.5.1-stable_mono_win64.exe" npm test

# PowerShell
$env:GODOT_PATH = "D:/Godot/Godot_v4.5.1/Godot_v4.5.1-stable_mono_win64.exe"; npm test
```

CI does not install Godot, so those tests skip there. This is intentional — runtime/headless integration is verified locally before merge, not in the cloud.

## Adding a fixture

Use a sibling directory under `tests/fixtures/` rather than mutating an existing fixture in place. Existing tests may depend on the current shape.

If the fixture exercises tools that require Godot, add a row to the coverage map noting it requires `GODOT_PATH`.
