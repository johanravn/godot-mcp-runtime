/**
 * Gate for tests that require a real Godot binary.
 *
 * CI does not have Godot installed. Locally, set `GODOT_PATH` to enable
 * these tests. Use `itGodot` exactly like `it`:
 *
 *     import { itGodot } from '../helpers/godot-skip.js';
 *     itGodot('runs a real headless Godot operation', async () => { ... });
 *
 * When `GODOT_PATH` is unset, the case is skipped (not failed).
 */

import { it } from 'vitest';

export const hasGodot = Boolean(process.env.GODOT_PATH);

export const itGodot = it.skipIf(!hasGodot);
