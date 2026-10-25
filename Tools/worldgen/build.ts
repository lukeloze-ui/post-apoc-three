// Derives everything except the base terrain/features from committed data in public/world.
// Deterministic: re-running gives byte-identical output.
import { runSteps, type Step } from './steps';
import { districtsStep } from './steps/districts';
import { cratersStep } from './steps/craters';
import { fillStep } from './steps/fill';
import { floodStep } from './steps/flood';

export const steps: Step[] = [floodStep, fillStep, districtsStep, cratersStep];

await runSteps('worldgen', steps);
