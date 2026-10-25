// Reads raw downloads from the gitignored Tools/worldgen/raw/ and writes base terrain and features.
// The synthetic stand-in supplies everything first; the OS Terrain 50 step then overwrites its heights
// with real ones, and the OSM step overwrites its landcover and features (it reads the real heights).
import { osmStep } from './import/osm';
import { terrain50Step } from './import/terrain50';
import { runSteps, type Step } from './steps';
import { syntheticStep } from './synthetic';

export const steps: Step[] = [syntheticStep, terrain50Step, osmStep];

await runSteps('worldgen:import', steps);
