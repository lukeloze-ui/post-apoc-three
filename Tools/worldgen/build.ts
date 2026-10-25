// Derives everything except the base terrain/features from committed data in public/world.
// Deterministic: re-running gives byte-identical output.
import { runSteps, type Step } from './steps';
import { districtsStep } from './steps/districts';
import { cratersStep } from './steps/craters';
import { fillStep } from './steps/fill';
import { floodStep } from './steps/flood';
import { groundStep } from './steps/ground';
import { overridesStep } from './steps/overrides';

// overridesStep stays last: hand fixes (Tools/worldgen/overrides.json) win over every generated step.
export const steps: Step[] = [floodStep, fillStep, districtsStep, cratersStep, groundStep, overridesStep];

await runSteps('worldgen', steps);
