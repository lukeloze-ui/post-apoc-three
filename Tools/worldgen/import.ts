// Reads raw downloads from the gitignored Tools/worldgen/raw/ and writes base terrain and features.
// The synthetic stand-in still supplies landcover and features until the OSM import replaces them;
// the OS Terrain 50 step then overwrites its heights with real ones.
import { terrain50Step } from './import/terrain50';
import { runSteps, type Step } from './steps';
import { syntheticStep } from './synthetic';

export const steps: Step[] = [syntheticStep, terrain50Step];

await runSteps('worldgen:import', steps);
