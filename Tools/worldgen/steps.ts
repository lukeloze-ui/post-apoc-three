export interface Step {
  name: string;
  run(): void | Promise<void>;
}

/** Runs steps in order, logging each. Each step makes its own RNG from its own seed constant. */
export async function runSteps(label: string, steps: readonly Step[]): Promise<void> {
  console.log(`[${label}] ${steps.length} step(s)`);
  for (const step of steps) {
    const t0 = performance.now();
    console.log(`[${label}] ${step.name}: start`);
    await step.run();
    console.log(`[${label}] ${step.name}: done in ${(performance.now() - t0).toFixed(0)} ms`);
  }
  console.log(`[${label}] finished`);
}
