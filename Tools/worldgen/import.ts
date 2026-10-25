// Reads raw downloads from the gitignored Tools/worldgen/raw/ and writes base terrain and features.
import { runSteps, type Step } from './steps';

export const steps: Step[] = [];

await runSteps('worldgen:import', steps);
