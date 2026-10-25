// Derives everything except the base terrain/features from committed data in public/world.
// Deterministic: re-running gives byte-identical output.
import { runSteps, type Step } from './steps';
import { blockersStep } from './steps/blockers';
import { districtsStep } from './steps/districts';
import { cratersStep } from './steps/craters';
import { fillStep } from './steps/fill';
import { floodStep } from './steps/flood';
import { groundStep } from './steps/ground';
import { overridesStep } from './steps/overrides';

// overridesStep follows every damage step: hand fixes (Tools/worldgen/overrides.json) win over them. groundStep comes
// after it, so ground debris is placed from the fixed districts.
export const steps: Step[] = [floodStep, fillStep, districtsStep, cratersStep, blockersStep, overridesStep, groundStep];

await runSteps('worldgen', steps);
