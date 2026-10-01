/**
 * Reads GregTech 5.09.51.482's ore generation and material tables straight from its jar:
 *
 *  - gregtech/api/enums/OreMixes  (each ore vein: an OreMixBuilder chain in <clinit>)
 *  - gregtech/api/enums/SmallOres (each small ore: a SmallOreBuilder chain in <clinit>)
 *  - gregtech/loaders/materials/MaterialsInit1.load() and Materials.<clinit> (each material's
 *    id and tool quality: constructor arguments or a MaterialBuilder chain)
 *  - Materials.setMultipliers() (ore multipliers, used by small-ore drops)
 *
 * The test server has no config overriding these (config/GregTech/WorldGeneration.cfg holds
 * only the general switches), so the builder values are what generates.
 */
import { chainCalls, chainRoot, interpret, parseClass, type Jar, type Value } from './jvm.ts';

export interface GtMaterial {
  /** The field name in Materials (e.g. "Diamond"). */
  key: string;
  /** mName, used in ore-dictionary names (e.g. "Diamond" -> oreDiamond, rawOreDiamond). */
  name: string;
  /** mMetaItemSubID: the material's id in GT's meta items and ore blocks. */
  id: number;
  /** mToolQuality: a GT tool's harvest level, and (for ores) the block's harvest data. */
  toolQuality: number;
  /** mOreMultiplier (default 1). */
  oreMultiplier: number;
}

export interface GtOreMix {
  key: string;
  name: string;
  enabled: boolean;
  minY: number;
  maxY: number;
  weight: number;
  density: number;
  size: number;
  /** Dimension names: "Overworld", "Nether", "TheEnd", "Twilight Forest", or a space body. */
  dims: string[];
  primary: string | null;
  secondary: string | null;
  between: string | null;
  sporadic: string | null;
}

export interface GtSmallOre {
  key: string;
  name: string;
  enabled: boolean;
  minY: number;
  maxY: number;
  /** Small ores attempted per chunk. */
  amount: number;
  dims: string[];
  material: string | null;
}

const MATERIALS = 'gregtech/api/enums/Materials';
const BUILDER = 'gregtech/api/enums/MaterialBuilder';

const int = (v: Value | undefined): number | null => (v?.t === 'int' ? v.v : null);
const str = (v: Value | undefined): string | null => (v?.t === 'str' ? v.v : null);
const material = (v: Value | undefined): string | null =>
  v?.t === 'static' && v.owner === MATERIALS ? v.name : null;

function classOf(jar: Jar, name: string): ReturnType<typeof parseClass> {
  const buf = jar.read(`${name}.class`);
  if (buf === null) throw new Error(`${jar.path}: ${name}.class not found`);
  return parseClass(buf);
}

/** Dimension names from enableInDim(...) arguments (strings or galacticgreg DimensionDefs). */
function dimsOf(args: Value[]): string[] {
  const arr = args[0];
  if (arr?.t !== 'array') return [];
  return arr.items.flatMap((d) =>
    d.t === 'str' ? [d.v] : d.t === 'static' ? [`${d.name} (space)`] : [],
  );
}

export function readOreMixes(jar: Jar): GtOreMix[] {
  const cls = 'gregtech/api/enums/OreMixes';
  const out: GtOreMix[] = [];
  for (const put of interpret(classOf(jar, cls), '<clinit>').puts) {
    if (put.owner !== cls || put.value.t !== 'new' || put.value.cls !== cls) continue;
    const builder = put.value.args?.[2];
    if (builder === undefined) continue;
    const mix: GtOreMix = {
      key: put.name,
      name: '',
      enabled: true,
      minY: 0,
      maxY: 0,
      weight: 0,
      density: 0,
      size: 0,
      dims: [],
      primary: null,
      secondary: null,
      between: null,
      sporadic: null,
    };
    for (const call of chainCalls(builder)) {
      const [a, b] = call.args;
      switch (call.name) {
        case 'name':
          mix.name = str(a) ?? '';
          break;
        case 'disabledByDefault':
          mix.enabled = false;
          break;
        case 'heightRange':
          mix.minY = int(a) ?? 0;
          mix.maxY = int(b) ?? 0;
          break;
        case 'weight':
          mix.weight = int(a) ?? 0;
          break;
        case 'density':
          mix.density = int(a) ?? 0;
          break;
        case 'size':
          mix.size = int(a) ?? 0;
          break;
        case 'enableInDim':
          mix.dims.push(...dimsOf(call.args));
          break;
        case 'primary':
          mix.primary = material(a);
          break;
        case 'secondary':
          mix.secondary = material(a);
          break;
        case 'inBetween':
          mix.between = material(a);
          break;
        case 'sporadic':
          mix.sporadic = material(a);
          break;
        default:
          break;
      }
    }
    out.push(mix);
  }
  return out;
}

export function readSmallOres(jar: Jar): GtSmallOre[] {
  const cls = 'gregtech/api/enums/SmallOres';
  const out: GtSmallOre[] = [];
  for (const put of interpret(classOf(jar, cls), '<clinit>').puts) {
    if (put.owner !== cls || put.value.t !== 'new' || put.value.cls !== cls) continue;
    const builder = put.value.args?.[2];
    if (builder === undefined) continue;
    const small: GtSmallOre = {
      key: put.name,
      name: '',
      enabled: true,
      minY: 0,
      maxY: 0,
      amount: 0,
      dims: [],
      material: null,
    };
    for (const call of chainCalls(builder)) {
      const [a, b] = call.args;
      if (call.name === 'name') small.name = str(a) ?? '';
      else if (call.name === 'disabledByDefault') small.enabled = false;
      else if (call.name === 'heightRange') {
        small.minY = int(a) ?? 0;
        small.maxY = int(b) ?? 0;
      } else if (call.name === 'amount') small.amount = int(a) ?? 0;
      else if (call.name === 'enableInDim') small.dims.push(...dimsOf(call.args));
      else if (call.name === 'ore') small.material = material(a);
    }
    out.push(small);
  }
  return out;
}

export function readMaterials(jar: Jar): Map<string, GtMaterial> {
  const out = new Map<string, GtMaterial>();
  const sources: Array<[string, string]> = [
    [MATERIALS, '<clinit>'],
    ['gregtech/loaders/materials/MaterialsInit1', 'load'],
  ];
  for (const [cls, method] of sources) {
    for (const put of interpret(classOf(jar, cls), method).puts) {
      if (put.owner !== MATERIALS) continue;
      const root = chainRoot(put.value);
      if (root.t !== 'new') continue;
      const args = root.args ?? [];
      if (root.cls === MATERIALS) {
        // (int id, TextureSet, float speed, int durability, int toolQuality, ...): the name is
        // the 7th argument of the short constructor and the 11th of the long ones.
        const id = int(args[0]);
        if (id === null) continue;
        out.set(put.name, {
          key: put.name,
          name: str(args.length > 8 ? args[10] : args[6]) ?? put.name,
          id,
          toolQuality: int(args[4]) ?? 0,
          oreMultiplier: 1,
        });
      } else if (root.cls === BUILDER) {
        // new MaterialBuilder(int id, TextureSet, String defaultLocalName) + setters.
        const id = int(args[0]);
        if (id === null) continue;
        const m: GtMaterial = {
          key: put.name,
          name: put.name,
          id,
          toolQuality: 0,
          oreMultiplier: 1,
        };
        for (const call of chainCalls(put.value)) {
          if (call.name === 'setName') m.name = str(call.args[0]) ?? m.name;
          if (call.name === 'setToolQuality') m.toolQuality = int(call.args[0]) ?? m.toolQuality;
        }
        out.set(put.name, m);
      }
    }
  }
  // Ore multipliers: Materials.X.setOreMultiplier(n) in setMultipliers().
  for (const call of interpret(classOf(jar, MATERIALS), 'setMultipliers').calls) {
    if (call.name !== 'setOreMultiplier' || call.recv === null) continue;
    const root = chainRoot(call.recv);
    const n = int(call.args[0]);
    if (root.t === 'static' && root.owner === MATERIALS && n !== null) {
      const m = out.get(root.name);
      if (m !== undefined) m.oreMultiplier = n;
    }
  }
  return out;
}

/**
 * GT's own harvest rules for its ore blocks (TileEntityOres.getHarvestData and
 * BlockOresAbstract.getHarvestLevel, 5.09.51.482, with activateHarvestLevelChange=false):
 * the block's world metadata is max(base, min(7, toolQuality - (small ? 1 : 0))), base 3 in
 * black/red granite and 0 elsewhere; the harvest level is that metadata, except 5 and 6 give 2.
 */
export function gtOreHarvestLevel(toolQuality: number, small: boolean, stoneType = 0): number {
  const base = stoneType === 3 || stoneType === 4 ? 3 : 0;
  const meta = Math.max(base, Math.min(7, toolQuality - (small ? 1 : 0)));
  return meta === 5 || meta === 6 ? 2 : meta % 8;
}
