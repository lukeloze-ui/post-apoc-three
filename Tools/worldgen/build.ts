// Derives everything except the base terrain/features from committed data in public/world.
// Deterministic: re-running gives byte-identical output.
import { runSteps, type Step } from './steps';

export const steps: Step[] = [];

await runSteps('worldgen', steps);
