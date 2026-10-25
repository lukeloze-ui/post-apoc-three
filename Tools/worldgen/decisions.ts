// The big damage decisions (SX 02 "Decide the big things once"). Hand-picked, not random, so they can be checked and
// tuned by eye. The districts step copies them into the districts.json header.
import type { Compass } from '../../src/world/districts';

/**
 * The north-west flank of the moor took the worst of the storm. The centre sits on Sourton Down (SX 548 935), between
 * the A30 and Sourton Tors: strikes are thickest over the Meldon valley and the west edge of the moor, visible from
 * Yes Tor and High Willhays, while Okehampton (about 4 km east) gets the thinner outer pocking.
 */
export const STORM = {
  worstSide: 'north-west' as Compass,
  e: 254800,
  n: 93500,
  why: 'Sourton Down, SX 548 935: worst over the Meldon valley and the west edge of the moor; Okehampton gets the fringe.',
};

/**
 * The major bridges that stand, whatever the later bridge-state roll says. Ids are features.json bridge ids.
 * Two survivors: one crossing of each Okement, so the town is not cut off on both sides.
 */
export const SURVIVORS: readonly { name: string; bridgeIds: readonly string[]; why: string }[] = [
  {
    name: 'Meldon Viaduct',
    // The rail record and the Granite Way path on its deck are one structure.
    bridgeIds: ['br-w1119234348', 'br-w504026050'],
    why: 'Open wrought-iron lattice piers and spans, far below the mark: the wave went through it, not against it. The dramatic survivor.',
  },
  {
    name: 'A30 East Okement bridge',
    // Both carriageways.
    bridgeIds: ['br-w24843017', 'br-w24843023'],
    why: 'Modern concrete dual carriageway, the one way east over the East Okement once the town bridges are gone.',
  },
];
