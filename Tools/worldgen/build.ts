// Derives everything except the base terrain/features from committed data in public/world.
// Deterministic: re-running gives byte-identical output.
import { runSteps, type Step } from './steps';
import { floodStep } from './steps/flood';

export const steps: Step[] = [floodStep];

await runSteps('worldgen', steps);
