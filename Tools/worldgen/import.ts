// Reads raw downloads from the gitignored Tools/worldgen/raw/ and writes base terrain and features.
// Until real OS data is imported, the synthetic stand-in supplies terrain and features.
import { runSteps, type Step } from './steps';
import { syntheticStep } from './synthetic';

export const steps: Step[] = [syntheticStep];

await runSteps('worldgen:import', steps);
