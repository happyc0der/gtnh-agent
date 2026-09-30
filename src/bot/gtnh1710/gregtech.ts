import type { MachineStatus } from '../../domain/game-state.ts';
import { GT_MACHINE_IDS_VERSION, GT_MACHINE_NAMES } from './gt-machine-ids.ts';
import { ProtocolError, Reader } from './wire.ts';

/**
 * GregTech (GTNH) machine state from the "GregTech" plugin channel. Verified against
 * gregtech_nh 5.09.51.482 with javap (see docs/gtnh-compatibility.md, "Machines"):
 *
 *   message      = packetType:u8 payload
 *   TILE_ENTITY  (0) = x:i32 y:i16 z:i32 mID:i16 cover:i32 x6 common:u8 update:u8 redstone:u8 color:u8
 *   BLOCK_EVENT  (2) = dimension:i32 count:i32 packedXYZ:i64 x count  (eventId<<8 | value):i16 x count
 *
 * `common` is BaseMetaTileEntity's texture data: facing (bits 0-2) | active 8 | redstone 16 |
 * upgrade lock 32 | works 64 | muffler 128. When it changes, GregTech sends block event 0
 * (CHANGE_COMMON_DATA) with the new byte. Stored energy is never sent to clients.
 */
export const GT_CHANNEL = 'GregTech';
const TILE_ENTITY = 0;
const BLOCK_EVENT = 2;
/** GregTechTileClientEvents.CHANGE_COMMON_DATA */
export const GT_EVENT_CHANGE_COMMON_DATA = 0;
const MAX_BLOCK_EVENTS = 65_536;

export const GT_COMMON = {
  facing: 0b111,
  active: 8,
  redstone: 16,
  lockUpgrade: 32,
  works: 64,
  muffler: 128,
} as const;

export type GregTechMessage =
  | {
      type: 'gt-tile-entity';
      x: number;
      y: number;
      z: number;
      metaTileId: number;
      common: number;
    }
  | {
      type: 'gt-block-events';
      dimension: number;
      events: Array<{ x: number; y: number; z: number; eventId: number; value: number }>;
    }
  | { type: 'gt-other'; packetType: number };

/** GTNHLib CoordinatePacker: x (26 bits) << 38 | z (26 bits) << 12 | y (12 bits), each signed. */
export function unpackCoordinates(packed: bigint): { x: number; y: number; z: number } {
  return {
    x: Number(BigInt.asIntN(26, packed >> 38n)),
    y: Number(BigInt.asIntN(12, packed)),
    z: Number(BigInt.asIntN(26, packed >> 12n)),
  };
}

export function decodeGregTechMessage(data: Buffer): GregTechMessage {
  const r = new Reader(data);
  const packetType = r.u8();
  switch (packetType) {
    case TILE_ENTITY: {
      const x = r.i32();
      const y = r.i16();
      const z = r.i32();
      const metaTileId = r.i16();
      for (let i = 0; i < 6; i++) r.i32(); // cover ids
      const common = r.u8();
      r.u8(); // update data (machine specific)
      r.u8(); // redstone
      r.u8(); // colour
      return { type: 'gt-tile-entity', x, y, z, metaTileId, common };
    }
    case BLOCK_EVENT: {
      const dimension = r.i32();
      const count = r.i32();
      if (count < 0 || count > MAX_BLOCK_EVENTS) {
        throw new ProtocolError(`GregTech block event count ${count} out of range`);
      }
      const positions = Array.from({ length: count }, () => unpackCoordinates(r.i64()));
      const events = positions.map((p) => {
        const packed = r.i16();
        return { ...p, eventId: (packed >> 8) & 0xff, value: packed & 0xff };
      });
      return { type: 'gt-block-events', dimension, events };
    }
    default:
      return { type: 'gt-other', packetType };
  }
}

export interface MachineFlags {
  facing: string;
  active: boolean;
  works: boolean;
}

const FACINGS = ['down', 'up', 'north', 'south', 'west', 'east'];

export function machineFlags(common: number): MachineFlags {
  return {
    facing: FACINGS[common & GT_COMMON.facing] ?? `unknown(${common & GT_COMMON.facing})`,
    active: (common & GT_COMMON.active) !== 0,
    works: (common & GT_COMMON.works) !== 0,
  };
}

/**
 * The agent's machine status from GregTech's flags. "Enabled but not running" is `idle`
 * even though the reason (no power, no input, full output) is not visible; power is
 * reported separately as unknown. A machine switched off is an `error`: it needs a human.
 */
export function machineStatus(common: number): MachineStatus {
  const f = machineFlags(common);
  if (!f.works) return 'error';
  return f.active ? 'busy' : 'idle';
}

/**
 * Machine names for the server's GregTech version, or null for any other version: then no
 * GregTech block is treated as a machine (pipes and cables send the same packet with a
 * different meaning, and only the version-matched table tells them apart).
 */
export function machineNamesFor(
  gregtechNhVersion: string | undefined,
): ReadonlyMap<number, string> | null {
  return gregtechNhVersion === GT_MACHINE_IDS_VERSION ? GT_MACHINE_NAMES : null;
}
