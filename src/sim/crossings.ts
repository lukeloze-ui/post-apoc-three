// Crossing water (SX 02 'Bridge out' and 'Standing water', SX 03 draining). Pure: the caller describes the water edge
// as a CrossingSite and gets back the options; resolve() plays one out with an injectable rng (gameplay, not world data).
// Days are whole game days (floor of GameClock.gameDays). Metres, seconds and kg as elsewhere in src/sim.
import { partyPace, type Party, type Person } from './load';
import { getItem } from './items';
import type { Pack, PackEntry } from './pack';

export type CrossingKind = 'ford' | 'wade' | 'swim' | 'raft' | 'detour';

/** Where the party stands at the water. Built by the caller from features rivers, lakes and the district bridges. */
export interface CrossingSite {
  /** Moving water of a river or stream, or still water (lake, basin, the Levels). */
  water: 'river' | 'stream' | 'standing';
  /** Metres across to the far bank. */
  widthM: number;
  /** Rivers only: a gravel bar or riffle, shallower than the channel. */
  shallow?: boolean;
  /** Standing water only: metres deep along the crossing (hazards.waterDepth). */
  depthM?: number;
  /** Extra metres to walk round: to a standing bridge, a shallow point or the head of the water. Absent when none. */
  detourM?: number;
}

/** Rng for gameplay events: next() is a float in [0, 1). */
export interface CrossingRng {
  next(): number;
}

export interface CrossingOption {
  kind: CrossingKind;
  available: boolean;
  /** For the HUD: why it is not available, or what it costs. */
  label: string;
  /** Game seconds to get across (or round). */
  timeSec: number;
  /** Multiplies fatigue while crossing (walking.ts extraEffort); 1 is a normal walk. */
  effort: number;
  /** 0 (none) to 1 (high): the chance that resolve() goes wrong. */
  risk: number;
  /** Whether unsealed gear gets wet (and may be lost). */
  soaks: boolean;
}

/** Depth and speed of the water at a site, metres and metres per second. */
export interface WaterState {
  depthM: number;
  flowMs: number;
}

/** Days 0 to 5 the rivers are in huge flood; they fall from day 6 to a low floor. */
export const FLOOD_LAST_DAY = 5;
export const RIVER_FLOOD_DEPTH_M = 2.5;
export const RIVER_FLOOD_FLOW_MS = 3;
/** On day 6 the rivers have dropped to these, and lose the fall per day after, down to the floor. */
export const RIVER_DAY6_DEPTH_M = 1.6;
export const RIVER_DAY6_FLOW_MS = 1.8;
export const RIVER_FALL_DEPTH_M = 0.4;
export const RIVER_FALL_FLOW_MS = 0.7;
export const RIVER_FLOOR_DEPTH_M = 0.8;
export const RIVER_FLOOR_FLOW_MS = 0.8;
/** A shallow point (bar or riffle) is this fraction of the channel's depth and flow. */
export const SHALLOW_DEPTH_SHARE = 0.3;
export const SHALLOW_FLOW_SHARE = 0.5;
export const STREAM_DEPTH_M = 0.3;
export const STREAM_FLOOD_DEPTH_M = 0.4;
export const STREAM_FLOW_MS = 0.6;
export const STREAM_FLOOD_FLOW_MS = 1;

/** Deepest water a ford counts as: about knee height. */
export const FORD_MAX_DEPTH_M = 0.5;
/** Walking pace through water, metres per second at pace 1. */
export const FORD_SPEED_MS = 1;
export const WADE_SPEED_MS = 0.5;
export const SWIM_SPEED_MS = 0.4;
export const DETOUR_SPEED_MS = 1.2;
export const FORD_EFFORT = 1.3;
export const WADE_EFFORT = 2.5;
export const SWIM_EFFORT = 5;
/** Game seconds lost to getting out, drying off and retrieving what can be retrieved. */
export const SLIP_SEC = 5 * 60;
export const SWEPT_SEC = 25 * 60;
/** Chance that each unsealed pack entry is lost when swept away. */
export const SWEPT_LOSS_CHANCE = 0.35;
export const NEED_RAFT = 'need a raft';

/** Waist height by body weight: about 1.0 m for a 75 kg adult, 0.72 m for a 40 kg child. */
export function waistDepth(p: Person): number {
  return 0.4 + 0.008 * p.bodyKg;
}

/** Depth times speed above which the current knocks a person over (m2/s): about 0.83 for the adult, 0.58 for the child. */
export function flowLimit(p: Person): number {
  return 0.3 + 0.007 * p.bodyKg;
}

/** The party wades only as deep, and against only as strong a current, as its smallest member. */
export function wadeLimit(party: Party): number {
  return Math.min(...party.people.map(waistDepth));
}

export function partyFlowLimit(party: Party): number {
  return Math.min(...party.people.map(flowLimit));
}

/** Depth and flow of the water on a game day. */
export function waterState(site: CrossingSite, day: number): WaterState {
  const d = Math.floor(day);
  if (site.water === 'standing') return { depthM: site.depthM ?? 0, flowMs: 0 };
  const flood = d <= FLOOD_LAST_DAY;
  if (site.water === 'stream') {
    return flood
      ? { depthM: STREAM_FLOOD_DEPTH_M, flowMs: STREAM_FLOOD_FLOW_MS }
      : { depthM: STREAM_DEPTH_M, flowMs: STREAM_FLOW_MS };
  }
  const after = Math.max(0, d - FLOOD_LAST_DAY - 1);
  const depth = flood ? RIVER_FLOOD_DEPTH_M : Math.max(RIVER_FLOOR_DEPTH_M, RIVER_DAY6_DEPTH_M - RIVER_FALL_DEPTH_M * after);
  const flow = flood ? RIVER_FLOOD_FLOW_MS : Math.max(RIVER_FLOOR_FLOW_MS, RIVER_DAY6_FLOW_MS - RIVER_FALL_FLOW_MS * after);
  return site.shallow
    ? { depthM: depth * SHALLOW_DEPTH_SHARE, flowMs: flow * SHALLOW_FLOW_SHARE }
    : { depthM: depth, flowMs: flow };
}

const fmtMin = (sec: number): string => `${Math.max(1, Math.round(sec / 60))} min`;

/** The ways across the water, in the order the HUD lists them. Unavailable ones are kept so the HUD can say why. */
export function assess(site: CrossingSite, party: Party, day: number): CrossingOption[] {
  const { depthM, flowMs } = waterState(site, day);
  const pace = partyPace(party.pack, party.people);
  const dv = depthM * flowMs;
  const calm = dv <= partyFlowLimit(party);
  const out: CrossingOption[] = [];

  const ford = depthM <= FORD_MAX_DEPTH_M && calm;
  out.push({
    kind: 'ford',
    available: ford,
    label: ford ? `ford, ${fmtMin(site.widthM / (FORD_SPEED_MS * pace))}` : 'too deep or fast to ford',
    timeSec: site.widthM / (FORD_SPEED_MS * pace),
    effort: FORD_EFFORT,
    risk: 0.02 + 0.1 * (dv / partyFlowLimit(party)),
    soaks: false,
  });

  const wade = !ford && depthM <= wadeLimit(party) && calm;
  out.push({
    kind: 'wade',
    available: wade,
    label: wade
      ? `wade, ${fmtMin(site.widthM / (WADE_SPEED_MS * pace))}, gear gets wet`
      : ford
        ? 'no need to wade'
        : depthM > wadeLimit(party)
          ? 'too deep to wade'
          : 'current too strong to wade',
    timeSec: site.widthM / (WADE_SPEED_MS * pace),
    effort: WADE_EFFORT,
    risk: Math.min(0.9, 0.05 + 0.3 * (depthM / wadeLimit(party)) + 0.2 * (dv / partyFlowLimit(party))),
    soaks: true,
  });

  // Swimming is always possible, but only worth it when the others are not.
  out.push({
    kind: 'swim',
    available: !ford && !wade,
    label: ford || wade ? 'no need to swim' : `swim, ${fmtMin(site.widthM / SWIM_SPEED_MS)}, unsealed gear is lost or soaked`,
    timeSec: site.widthM / SWIM_SPEED_MS,
    effort: SWIM_EFFORT,
    risk: Math.min(0.9, 0.1 + 0.15 * flowMs + 0.04 * Math.max(0, site.widthM - 10) / 10),
    soaks: true,
  });

  out.push({
    kind: 'raft',
    available: false,
    label: NEED_RAFT,
    timeSec: site.widthM / (WADE_SPEED_MS * 2 * pace),
    effort: 2,
    risk: 0.05,
    soaks: false,
  });

  const detour = site.detourM !== undefined && site.detourM >= 0;
  out.push({
    kind: 'detour',
    available: detour,
    label: detour ? `walk round, ${Math.round(site.detourM!)} m, ${fmtMin(site.detourM! / (DETOUR_SPEED_MS * pace))}` : 'no way round that you know of',
    timeSec: (site.detourM ?? 0) / (DETOUR_SPEED_MS * pace),
    effort: 1,
    risk: 0.02,
    soaks: false,
  });
  return out;
}

/** The HUD lines at a water edge: one per option. */
export function crossingLines(options: readonly CrossingOption[]): string[] {
  return options.map((o) => `${o.kind}: ${o.label}${o.available ? `  (risk ${Math.round(o.risk * 100)}%)` : ''}`);
}

/** What water does to gear that is not sealed: nothing, needs drying, or ruined (quilt, food that spoils, electronics). */
export type WetEffect = 'safe' | 'wet' | 'ruined';

const WET_EFFECT: Readonly<Record<string, WetEffect>> = {
  tin_food: 'safe',
  water: 'safe',
  gas_canister: 'safe',
  spade: 'safe',
  hatchet: 'safe',
  crowbar: 'safe',
  pellet_tin: 'safe',
  dry_bag: 'safe',
  binoculars: 'wet',
  rifle_l403a1: 'wet',
  rifle_sa80a3: 'wet',
  air_rifle: 'wet',
  magazine_30: 'wet',
  round: 'wet',
  camping_kit: 'ruined',
  dried_meat: 'ruined',
};

export function wetEffect(itemId: string): WetEffect {
  getItem(itemId);
  return WET_EFFECT[itemId] ?? 'wet';
}

export interface ItemLoss {
  itemId: string;
  qty: number;
  carrier: string;
}

export type CrossingResult = 'crossed' | 'slipped' | 'swept' | 'blocked';

export interface CrossingOutcome {
  result: CrossingResult;
  /** Game seconds taken, including any recovery. */
  timeSec: number;
  /** Swept away downstream and gone. */
  lost: ItemLoss[];
  /** Soaked through and spoiled: remove from the pack. */
  ruined: ItemLoss[];
  /** Wet; they work again once dried. */
  soaked: ItemLoss[];
  /** Fatigue multiplier for the crossing, from the option. */
  effort: number;
}

const item = (e: PackEntry): ItemLoss => ({ itemId: e.itemId, qty: e.qty, carrier: e.carrier });

/** Sort the unsealed pack by what water does to it. Sealed entries are untouched. */
function soak(pack: Pack, out: CrossingOutcome, lose: (e: PackEntry) => boolean): void {
  for (const e of pack) {
    if (e.sealed) continue;
    if (lose(e)) {
      out.lost.push(item(e));
      continue;
    }
    const w = wetEffect(e.itemId);
    if (w === 'ruined') out.ruined.push(item(e));
    else if (w === 'wet') out.soaked.push(item(e));
  }
}

/** Play out one option. A ford and a detour are safe but for a small slip; wading may slip; swimming may be swept away. */
export function resolve(option: CrossingOption, party: Party, rng: CrossingRng): CrossingOutcome {
  const out: CrossingOutcome = { result: 'crossed', timeSec: option.timeSec, lost: [], ruined: [], soaked: [], effort: option.effort };
  if (!option.available) return { ...out, result: 'blocked', timeSec: 0 };
  const bad = rng.next() < option.risk;
  switch (option.kind) {
    case 'ford':
    case 'detour':
    case 'raft':
      if (bad && option.kind === 'ford') {
        // A slip in the shallows: a wetting, not a loss.
        out.result = 'slipped';
        out.timeSec += SLIP_SEC;
        soak(party.pack, out, () => false);
      }
      return out;
    case 'wade':
      soak(party.pack, out, () => false);
      if (bad) {
        out.result = 'slipped';
        out.timeSec += SLIP_SEC;
      }
      return out;
    case 'swim':
      if (bad) {
        out.result = 'swept';
        out.timeSec += SWEPT_SEC;
        soak(party.pack, out, () => rng.next() < SWEPT_LOSS_CHANCE);
      } else soak(party.pack, out, () => false);
      return out;
  }
}

/** Take the lost and ruined items out of the pack. Wet items stay: drying is another system's job. */
export function applyOutcome(pack: Pack, outcome: CrossingOutcome): void {
  for (const l of [...outcome.lost, ...outcome.ruined]) {
    const k = pack.findIndex((e) => !e.sealed && e.itemId === l.itemId && e.carrier === l.carrier);
    if (k >= 0) pack.splice(k, 1);
  }
}
