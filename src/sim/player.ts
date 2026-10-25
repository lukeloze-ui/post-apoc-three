// The player: where the party stands and how it moves. Pure state and a step function; no three, no DOM.
// Local frame as in world/terrain.ts: x metres east, y metres north. Yaw 0 is north, clockwise, in degrees.
import { defaultParty, loadBand, loadShare, type LoadBand, type Party } from './load';
import { carriedKg } from './pack';
import { partyConditionEffort, partyConditionPace } from './condition';
import { newHazardState, stepHazards, type HazardEvent, type HazardRng, type HazardState } from './hazards';
import type { Conditions } from '../world/conditions';
import { newWalkState, speedMs, stepWalk, RECOVER_PER_HOUR, type GroundType, type WalkState } from './walking';

/** What the player needs to know about the ground. The game builds one over the real surface; tests use a fake. */
export interface WalkWorld {
  /** Patch extent, metres. The player stays inside it. */
  sizeX: number;
  sizeY: number;
  /** Ground height, metres: what feet stand on. */
  heightAt(x: number, y: number): number;
  /** A road class within the road's half-width, otherwise the landcover type. */
  groundTypeAt(x: number, y: number): GroundType;
  /** Depth of standing water, metres (0 or less when dry). */
  waterDepthAt?(x: number, y: number): number;
  /** Damage blockers and ground debris merged with the ground type (world/conditions.ts), for the current day. */
  conditionsAt?(x: number, y: number): Conditions;
  /** Days since d0-00:00 (GameClock.gameDays); hazards need it for the gas days. Absent: day 0. */
  gameDays?(): number;
  /** Sun altitude in degrees; below -6 it is dark and rough ground trips you. Absent: broad daylight. */
  sunAltitude?(): number;
}

/** WASD as -1..1 axes: forward is +1 for W, right is +1 for D. */
export interface PlayerInput {
  forward: number;
  right: number;
}

/** Water deeper than this stops the player. */
export const MAX_WADE_DEPTH_M = 1;
/** The grade is the surface slope over this distance either side of the player, along the direction of motion. */
export const GRADE_HALF_BASELINE_M = 3;
/** Grades beyond this are treated as this steep. */
export const MAX_GRADE = 0.6;
/** Closest the player gets to the patch edge, metres. */
export const EDGE_MARGIN_M = 1;
/** Longest slice of game time simulated in one go, so a big dt cannot jump over a lake or a road. */
export const MAX_SUB_SEC = 2;
/** A forced rest passes this many times faster than game time, so the player is not left standing for minutes. */
export const REST_TIME_SPEEDUP = 30;

export interface PersonStatus {
  id: string;
  name: string;
  band: LoadBand;
  stamina: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class Player {
  /** Feet height, metres; always the surface height at (x, y). */
  z = 0;
  walk: WalkState;
  /** Ground under the player and the grade along the direction of motion (facing when standing still). */
  groundType: GroundType = 'field';
  grade = 0;
  /** Conditions here when the world provides them; speedFactor and effortFactor feed the walking model. */
  conditions: Conditions | null = null;
  speedFactor = 1;
  effortFactor = 1;
  /** Modelled pace here, metres per game second; 0 while resting. */
  paceMs = 0;
  /** Metres per game second actually covered in the last step. */
  movedMs = 0;
  resting = false;
  /** Injuries, wetness, exposure and gas dose (sim/hazards.ts). */
  hazards: HazardState;
  /** Hazard events since the caller last took them, for the HUD. */
  private events: HazardEvent[] = [];

  constructor(
    public x: number,
    public y: number,
    public yaw: number,
    public party: Party = defaultParty(),
    /** Gameplay rng for trips and injuries; tests pass a seeded one. */
    private readonly rng: HazardRng = { next: Math.random },
  ) {
    this.walk = newWalkState(party);
    this.hazards = newHazardState(party);
  }

  /** The hazard events since the last call (trips, injuries, stuck, gas, collapse). */
  takeEvents(): HazardEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Roll the hazards for a step of dt seconds over metres; returns the extra game seconds lost. */
  private rollHazards(dt: number, metres: number, world: WalkWorld): number {
    const res = stepHazards(
      this.hazards,
      this.party,
      {
        hazards: this.conditions?.hazards ?? { tripInDark: false, injuryRisk: 0, trapRisk: 0, gas: false, waterDepth: 0, impassable: false },
        groundType: this.groundType,
        grade: this.grade,
        movedM: metres,
        dtSec: dt,
        gameDays: world.gameDays?.() ?? 0,
        sunAltitude: world.sunAltitude?.() ?? 90,
        stamina: this.walk.stamina,
        walking: metres > 0,
      },
      this.rng,
    );
    if (res.events.length) this.events.push(...res.events);
    return res.lostSec;
  }

  get stamina(): Readonly<Record<string, number>> {
    return this.walk.stamina;
  }

  /** Each person's load band and stamina, for the HUD. */
  status(): PersonStatus[] {
    return this.party.people.map((p) => ({
      id: p.id,
      name: p.name,
      band: loadBand(loadShare(carriedKg(this.party.pack, p.id), p.bodyKg)),
      stamina: this.walk.stamina[p.id] ?? 1,
    }));
  }

  /** Read the ground, grade and pace at the current spot, heading along (dx, dy) (a unit vector). */
  sense(world: WalkWorld, dx: number, dy: number): void {
    const b = GRADE_HALF_BASELINE_M;
    this.z = world.heightAt(this.x, this.y);
    this.conditions = world.conditionsAt?.(this.x, this.y) ?? null;
    this.groundType = this.conditions?.groundType ?? world.groundTypeAt(this.x, this.y);
    this.speedFactor = (this.conditions?.speedFactor ?? 1) * partyConditionPace(this.hazards.conditions, this.party);
    this.effortFactor = (this.conditions?.effortFactor ?? 1) * partyConditionEffort(this.hazards.conditions, this.party);
    const rise = world.heightAt(this.x + dx * b, this.y + dy * b) - world.heightAt(this.x - dx * b, this.y - dy * b);
    this.grade = clamp(rise / (2 * b), -MAX_GRADE, MAX_GRADE);
    this.resting = this.walk.restLeftSec > 0;
    this.paceMs = this.resting ? 0 : speedMs(this.groundType, this.grade, this.party, this.speedFactor, this.walk.stamina);
  }

  /**
   * Advance by dt game seconds. Returns the game seconds that actually passed, which is dt unless the party took a
   * forced rest, which runs REST_TIME_SPEEDUP times faster. The caller advances the clock by the return value.
   */
  step(dt: number, input: PlayerInput, world: WalkWorld): number {
    let left = dt;
    let passed = 0;
    while (left > 1e-9) {
      const sub = Math.min(left, MAX_SUB_SEC);
      passed += this.substep(sub, input, world);
      left -= sub;
    }
    return passed;
  }

  private substep(dt: number, input: PlayerInput, world: WalkWorld): number {
    const yaw = (this.yaw * Math.PI) / 180;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const f = clamp(input.forward, -1, 1);
    const r = clamp(input.right, -1, 1);
    // WASD relative to yaw: forward is (sin, cos), right is (cos, -sin).
    let dx = sin * f + cos * r;
    let dy = cos * f - sin * r;
    const len = Math.hypot(dx, dy);
    const wants = len > 1e-6;
    if (wants) {
      dx /= len;
      dy /= len;
    } else {
      dx = sin;
      dy = cos;
    }
    this.movedMs = 0;

    if (this.walk.restLeftSec > 0) {
      const take = Math.min(dt * REST_TIME_SPEEDUP, this.walk.restLeftSec);
      stepWalk(this.walk, this.party, this.groundType, 0, take);
      this.rollHazards(take, 0, world);
      this.sense(world, dx, dy);
      return take;
    }

    this.sense(world, dx, dy);
    if (!wants || this.hazards.collapsed) {
      // Standing still: stamina comes back and the walked-since-rest clock winds down.
      const hours = dt / 3600;
      for (const p of this.party.people) {
        this.walk.stamina[p.id] = Math.min(1, (this.walk.stamina[p.id] ?? 1) + RECOVER_PER_HOUR * hours);
      }
      this.walk.walkedSec = Math.max(0, this.walk.walkedSec - dt);
      return dt + this.rollHazards(dt, 0, world);
    }

    const metres = stepWalk(this.walk, this.party, this.groundType, this.grade, dt, this.speedFactor, this.effortFactor);
    const x0 = this.x;
    const y0 = this.y;
    this.moveTo(x0 + dx * metres, y0 + dy * metres, world);
    const moved = Math.hypot(this.x - x0, this.y - y0);
    this.movedMs = moved / dt;
    this.sense(world, dx, dy);
    return dt + this.rollHazards(dt, moved, world);
  }

  /** Move to (nx, ny) kept inside the patch; if deep water or impassable ground is in the way, slide along one axis or stay put. */
  private moveTo(nx: number, ny: number, world: WalkWorld): void {
    const cx = clamp(nx, EDGE_MARGIN_M, world.sizeX - EDGE_MARGIN_M);
    const cy = clamp(ny, EDGE_MARGIN_M, world.sizeY - EDGE_MARGIN_M);
    const here = world.waterDepthAt?.(this.x, this.y) ?? 0;
    const stuck = this.conditions?.hazards.impassable ?? false;
    // Only refuse water that is deep and no shallower than where we already stand, so a player caught in it can wade out;
    // likewise impassable ground only stops a player who is not already standing on it.
    const open = (x: number, y: number): boolean => {
      const d = world.waterDepthAt?.(x, y) ?? 0;
      if (d > MAX_WADE_DEPTH_M && d >= here) return false;
      return stuck || !(world.conditionsAt?.(x, y).hazards.impassable ?? false);
    };
    if (open(cx, cy)) {
      this.x = cx;
      this.y = cy;
    } else if (open(cx, this.y)) {
      this.x = cx;
    } else if (open(this.x, cy)) {
      this.y = cy;
    }
  }
}

/** A player standing at (x, y), with ground, grade and pace already read. */
export function createPlayer(
  x: number,
  y: number,
  yaw: number,
  world: WalkWorld,
  party: Party = defaultParty(),
  rng?: HazardRng,
): Player {
  const p = new Player(x, y, yaw, party, rng);
  p.sense(world, Math.sin((yaw * Math.PI) / 180), Math.cos((yaw * Math.PI) / 180));
  return p;
}
