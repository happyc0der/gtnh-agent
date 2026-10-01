import type { GardenBlock } from './blocks.ts';
import type { GameState } from './game-state.ts';

/**
 * Food on the GTNH 2.8.4 test server: what each food is worth, which raw foods are safe, what
 * HarvestCraft's gardens and the farm animals drop, and Spice of Life's diminishing returns.
 * Pure data and functions, shared by System 1 (which food to eat), the play loop (when to go
 * and get food, and when there is enough) and the planner's food route. Every number was read
 * in the server's own jars and configs (javap; docs/gtnh-compatibility.md, "Food"):
 *  - HungerOverhaul 1.0.0-jenkins104 with modifyFoodValues=true and useHOFoodValues=true
 *    (config/HungerOverhaul/HungerOverhaul.cfg) sets its own values through AppleCore's
 *    GetFoodValues event: ModuleVanilla, ModuleHarvestCraft and ModuleBOP name them food by
 *    food; any other food gets max(1, round(hunger / foodHungerDivider)), the divider 2.0.
 *    Seen live: an apple gave 1 (food 8 -> 9).
 *  - Spice of Life 2.2.3-carrot (config/SpiceOfLife.cfg) then scales each food by how often it
 *    was eaten among the player's last 20 meals, rounding the result DOWN (see mealPoints).
 */

/**
 * Hunger points restored by each food the agent may eat, under HungerOverhaul's tables.
 * ModuleVanilla (Items fields named through Forge's deobfuscation map and the vanilla jar's
 * Items class): bread and pumpkin pie 3; cooked beef, porkchop, chicken and fish, baked potato
 * and mushroom stew 2; apple, carrot, potato, melon, cookie and the raw meats 1.
 * ModuleHarvestCraft: every crop in ItemRegistry.PamCropItems 1 (it sets cropfoodRestore to 1),
 * but cantaloupe 2; raw mutton 1. ModuleBOP: BiomesOPlenty:food 1 at meta 0 (berries) and 8
 * (persimmons, from ripe persimmon leaves).
 */
export const FOOD_POINTS: ReadonlyMap<string, number> = new Map([
  ['minecraft:bread', 3],
  ['minecraft:pumpkin_pie', 3],
  ['minecraft:cooked_beef', 2],
  ['minecraft:cooked_porkchop', 2],
  ['minecraft:cooked_chicken', 2],
  ['minecraft:cooked_fished', 2],
  ['minecraft:baked_potato', 2],
  ['minecraft:mushroom_stew', 2],
  ['harvestcraft:cantaloupeItem', 2],
  ['minecraft:apple', 1],
  ['minecraft:carrot', 1],
  ['minecraft:potato', 1],
  ['minecraft:melon', 1],
  ['minecraft:cookie', 1],
  ['minecraft:beef', 1],
  ['minecraft:porkchop', 1],
  ['harvestcraft:muttonrawItem', 1],
  ['BiomesOPlenty:food', 1],
  ['BiomesOPlenty:food@8', 1],
]);

/** HungerOverhaul's smallest value: what any other food restores at least. */
export const DEFAULT_FOOD_POINTS = 1;

/** Hunger points `item` restores before Spice of Life (FOOD_POINTS, else the minimum). */
export function foodPoints(item: string): number {
  return FOOD_POINTS.get(item) ?? DEFAULT_FOOD_POINTS;
}

/**
 * Raw foods that are never approved, and why (the vanilla jar's Item.registerItems and
 * ItemFishFood): food the agent must not eat raw. Cooking needs a furnace (cobblestone, which
 * needs a pickaxe): out of reach on a first day.
 */
export const UNSAFE_FOODS: ReadonlyMap<string, string> = new Map([
  [
    'minecraft:chicken',
    'raw chicken: Hunger for 30 s (a 30% chance), which drains more than it gives',
  ],
  ['minecraft:rotten_flesh', 'rotten flesh: Hunger for 30 s (an 80% chance)'],
  ['minecraft:spider_eye', 'spider eye: Poison for 5 s'],
  ['minecraft:poisonous_potato', 'poisonous potato: Poison for 5 s (a 60% chance)'],
  ['minecraft:fish@3', 'pufferfish: Poison, Hunger and Nausea'],
  ['minecraft:golden_apple', 'a golden apple: worth keeping'],
  ['minecraft:golden_apple@1', 'an enchanted golden apple: worth keeping'],
]);

// ---------------------------------------------------------------------------
// HarvestCraft's gardens
// ---------------------------------------------------------------------------

/**
 * What breaking a garden drops: 3 items (gardendropAmount=3, gardensdropSeeds=false), each a
 * random one of this list, in BlockGarden.getDropList's order (javap of
 * harvestcraft-1.3.2-GTNH). Registry names as the inventory reports them: HarvestCraft
 * registers its items under their field names (GameRegistry.registerItem(item, "...Item")).
 * The vanilla blocks among them (cactus, pumpkin, mushrooms) are no food; cotton neither.
 */
export const GARDEN_DROPS: Readonly<Record<GardenBlock, readonly string[]>> = {
  'harvestcraft:berrygarden': [
    'harvestcraft:blackberryItem',
    'harvestcraft:blueberryItem',
    'harvestcraft:candleberryItem',
    'harvestcraft:raspberryItem',
    'harvestcraft:strawberryItem',
    'harvestcraft:grapeItem',
  ],
  'harvestcraft:desertgarden': ['harvestcraft:cactusfruitItem', 'minecraft:cactus'],
  'harvestcraft:grassgarden': [
    'harvestcraft:asparagusItem',
    'harvestcraft:barleyItem',
    'harvestcraft:oatsItem',
    'harvestcraft:ryeItem',
    'harvestcraft:cornItem',
    'harvestcraft:bambooshootItem',
  ],
  'harvestcraft:gourdgarden': [
    'harvestcraft:cantaloupeItem',
    'harvestcraft:cucumberItem',
    'harvestcraft:wintersquashItem',
    'harvestcraft:zucchiniItem',
    'minecraft:pumpkin',
  ],
  'harvestcraft:groundgarden': [
    'harvestcraft:beetItem',
    'harvestcraft:onionItem',
    'harvestcraft:parsnipItem',
    'harvestcraft:peanutItem',
    'harvestcraft:radishItem',
    'harvestcraft:rutabagaItem',
    'harvestcraft:sweetpotatoItem',
    'harvestcraft:turnipItem',
    'harvestcraft:rhubarbItem',
    'minecraft:potato',
    'minecraft:carrot',
  ],
  'harvestcraft:herbgarden': [
    'harvestcraft:celeryItem',
    'harvestcraft:garlicItem',
    'harvestcraft:gingerItem',
    'harvestcraft:spiceleafItem',
    'harvestcraft:ediblerootItem',
    'harvestcraft:tealeafItem',
    'harvestcraft:coffeebeanItem',
    'harvestcraft:mustardseedsItem',
  ],
  'harvestcraft:leafygarden': [
    'harvestcraft:broccoliItem',
    'harvestcraft:cauliflowerItem',
    'harvestcraft:leekItem',
    'harvestcraft:lettuceItem',
    'harvestcraft:scallionItem',
    'harvestcraft:artichokeItem',
    'harvestcraft:brusselsproutItem',
    'harvestcraft:cabbageItem',
    'harvestcraft:spinachItem',
  ],
  'harvestcraft:mushroomgarden': [
    'minecraft:brown_mushroom',
    'minecraft:red_mushroom',
    'harvestcraft:whitemushroomItem',
  ],
  'harvestcraft:stalkgarden': [
    'harvestcraft:beanItem',
    'harvestcraft:soybeanItem',
    'harvestcraft:bellpepperItem',
    'harvestcraft:chilipepperItem',
    'harvestcraft:eggplantItem',
    'harvestcraft:okraItem',
    'harvestcraft:peasItem',
    'harvestcraft:tomatoItem',
  ],
  'harvestcraft:textilegarden': ['harvestcraft:cottonItem'],
  'harvestcraft:tropicalgarden': [
    'harvestcraft:pineappleItem',
    'harvestcraft:kiwiItem',
    'minecraft:melon',
    'harvestcraft:curryleafItem',
    'harvestcraft:sesameseedsItem',
  ],
};

/** Items a garden drops that are no food: vanilla blocks, and cotton (ItemSeeds). */
const GARDEN_NON_FOOD: ReadonlySet<string> = new Set([
  'minecraft:cactus',
  'minecraft:pumpkin',
  'minecraft:brown_mushroom',
  'minecraft:red_mushroom',
  'harvestcraft:cottonItem',
]);

/**
 * The garden produce that is food: ItemPamSeedFood (an ItemFood with no potion effect and no
 * code of its own on eating), plus the vanilla potato, carrot and melon slice. Raw and safe.
 */
export const GARDEN_FOODS: readonly string[] = [
  ...new Set(Object.values(GARDEN_DROPS).flatMap((drops) => drops)),
].filter((item) => !GARDEN_NON_FOOD.has(item));

/**
 * Where each garden generates (PamGardenGenerator.generateSurface, by Forge BiomeDictionary
 * types of the biome at the chunk's corner; none in DEAD biomes; gardenRarity=2 tries per
 * chunk), in a player's words. The test world's generator is Realistic World Gen: its Hot
 * Forest and Hot Plains are HOT, SAVANNA, PLAINS and SPARSE; its Hot Desert HOT, DRY, SANDY
 * (rwg.biomes.base.BaseBiomes).
 */
export const GARDEN_BIOMES: Readonly<Record<GardenBlock, string>> = {
  'harvestcraft:berrygarden': 'forests, hills, cold and wet biomes',
  'harvestcraft:desertgarden': 'deserts and beaches (it grows on sand)',
  'harvestcraft:grassgarden': 'plains that are not cold (Hot Plains, Hot Forest)',
  'harvestcraft:gourdgarden': 'plains and forests',
  'harvestcraft:groundgarden': 'savannas, hills, mountains and mesas (Hot Forest, Hot Plains)',
  'harvestcraft:herbgarden': 'forests that are not cold, and wet biomes',
  'harvestcraft:leafygarden': 'forests that are not cold, and wet biomes',
  'harvestcraft:mushroomgarden': 'forests (on fallen logs) and wet biomes',
  'harvestcraft:stalkgarden': 'plains and forests that are not cold, and wet biomes',
  'harvestcraft:textilegarden': 'cold, hilly and wet biomes',
  'harvestcraft:tropicalgarden': 'hot and wet biomes: jungles, Hot Forest, Hot Desert',
};

/** The gardens whose drops include food: every land garden but the textile garden. */
export const FOOD_GARDENS: readonly GardenBlock[] = (
  Object.keys(GARDEN_DROPS) as GardenBlock[]
).filter((g) => GARDEN_DROPS[g].some((item) => !GARDEN_NON_FOOD.has(item)));

// ---------------------------------------------------------------------------
// Farm animals
// ---------------------------------------------------------------------------

/**
 * What a farm animal drops when the player kills it (looting 0), read in the vanilla jar's
 * dropFewItems (EntityCow wh, EntityPig wo, EntitySheep wp, EntityChicken wg) and in
 * HarvestCraft's PamSheepDrops (sheepdropMutton=true; Et Futurum's own mutton is off,
 * enableMutton=false): a cow 1-3 raw beef and 0-2 leather, a pig 1-3 raw porkchops, a sheep
 * 1-3 raw mutton and its wool (1; none once sheared, which a wild sheep is not; white is
 * `minecraft:wool`, other colours carry their damage), a chicken 1 raw chicken and 0-2
 * feathers. A burning animal drops its meat cooked.
 */
export const ANIMAL_DROPS: Readonly<
  Record<string, ReadonlyArray<{ item: string; min: number; max: number }>>
> = {
  'minecraft:Cow': [
    { item: 'minecraft:beef', min: 1, max: 3 },
    { item: 'minecraft:leather', min: 0, max: 2 },
  ],
  'minecraft:Pig': [{ item: 'minecraft:porkchop', min: 1, max: 3 }],
  'minecraft:Sheep': [
    { item: 'harvestcraft:muttonrawItem', min: 1, max: 3 },
    { item: 'minecraft:wool', min: 1, max: 1 },
  ],
  'minecraft:Chicken': [
    { item: 'minecraft:chicken', min: 1, max: 1 },
    { item: 'minecraft:feather', min: 0, max: 2 },
  ],
};

/**
 * Animals hunted for food: their raw meat is safe to eat. Not chickens: raw chicken can give
 * Hunger (UNSAFE_FOODS), and there is no furnace yet to cook it.
 */
export const FOOD_ANIMALS: ReadonlySet<string> = new Set([
  'minecraft:Cow',
  'minecraft:Pig',
  'minecraft:Sheep',
]);

/** The items an animal's kill can put into the inventory (empty for other creatures). */
export function animalDrops(type: string): string[] {
  return (ANIMAL_DROPS[type] ?? []).map((d) => d.item);
}

// ---------------------------------------------------------------------------
// Spice of Life: the same food again is worth less
// ---------------------------------------------------------------------------

/** Spice of Life's food history: the last 20 foods eaten (food.history.length=20). */
export const MEAL_HISTORY_LENGTH = 20;

/**
 * Spice of Life's multiplier for a food eaten `count` times among the last
 * MEAL_HISTORY_LENGTH meals, with `hunger` its HungerOverhaul value, from the installed
 * formula (food.modifier.formula):
 *   MAX(IF(count>=4 && distinct_food_groups_eaten<=5, 1 - (count-4)/8, 1),
 *       IF((count-8) < food_hunger_value, 1/MAX(food_hunger_value,2), 0))
 * No food groups are configured (config/SpiceOfLife holds only the disabled example), so the
 * group condition always holds and `count` counts the food itself.
 */
export function spiceOfLifeModifier(count: number, hunger: number): number {
  const first = count >= 4 ? 1 - (count - 4) / 8 : 1;
  const second = count - 8 < hunger ? 1 / Math.max(hunger, 2) : 0;
  return Math.max(first, second);
}

/**
 * Hunger points `item` restores now, with `recentMeals` the foods eaten lately (newest first):
 * HungerOverhaul's value times Spice of Life's multiplier, rounded down
 * (food.hunger.rounding.mode=floor). So a 1-point food eaten 5 times among the last 20 meals
 * restores nothing until those meals fall out of the history: variety is food here.
 * (Spice of Life's new.player.food.eaten.threshold of 10 lifts this for a new player's first
 * 10 meals; the agent assumes it is past them, which can only underrate a food.)
 */
export function mealPoints(item: string, recentMeals: readonly string[]): number {
  const count = recentMeals.slice(0, MEAL_HISTORY_LENGTH).filter((m) => m === item).length;
  const points = foodPoints(item);
  return Math.floor(points * spiceOfLifeModifier(count, points));
}

/**
 * The carried food to eat now: the one, among `approved` foods held and not `excluded`
 * (protected items), that restores the most now; ties go to the earlier in `approved`. Null
 * when none would restore anything (eating it would waste it).
 */
export function bestMeal(
  items: Readonly<Record<string, number>>,
  approved: readonly string[],
  recentMeals: readonly string[] = [],
  excluded: (item: string) => boolean = () => false,
): { item: string; points: number } | null {
  let best: { item: string; points: number } | null = null;
  for (const item of approved) {
    if ((items[item] ?? 0) <= 0 || excluded(item)) continue;
    const points = mealPoints(item, recentMeals);
    if (points > 0 && (best === null || points > best.points)) best = { item, points };
  }
  return best;
}

/**
 * How many hunger points the carried food would restore, eaten one meal at a time the way
 * System 1 eats (bestMeal each time, each meal joining the history), stopping at `cap`.
 */
export function carriedFoodPoints(
  items: Readonly<Record<string, number>>,
  approved: readonly string[],
  recentMeals: readonly string[] = [],
  excluded: (item: string) => boolean = () => false,
  cap = 40,
): number {
  const left: Record<string, number> = { ...items };
  const history = recentMeals.slice(0, MEAL_HISTORY_LENGTH);
  let total = 0;
  while (total < cap) {
    const meal = bestMeal(left, approved, history, excluded);
    if (meal === null) break;
    total += meal.points;
    left[meal.item] = (left[meal.item] ?? 0) - 1;
    history.unshift(meal.item);
    history.length = Math.min(history.length, MEAL_HISTORY_LENGTH);
  }
  return Math.min(total, cap);
}

// ---------------------------------------------------------------------------
// Getting food
// ---------------------------------------------------------------------------

/**
 * The task the play loop gets food under (src/app/food.ts): hungry with no food carried, in
 * daylight, play turns to it as it turns to the night shelter at dusk, and goes back to the
 * quest once enough food is carried.
 */
export const FOOD_TASK_ID = 'get-food';

/**
 * Hunger points a food trip brings back: about a day of food. Seen live, the food bar fell from
 * 20 to 8 over a game day or two of play, and most foods here restore 1 (FOOD_POINTS), so this
 * is about ten foods, and with gardens' mixed produce, not ten of one kind.
 */
export const FOOD_TRIP_POINTS = 10;

/**
 * The current task is the food task (FOOD_TASK_ID), active, and it is day: the agent is out
 * getting food, so too little food is the task, not a reason to stop. System 1 then goes on
 * with the task's steps below minHunger instead of retreating or pausing
 * (deterministic-router.ts), and the safety policy lets the steps that get food run
 * (safety-policy.ts dangerGate). At dusk the night shelter comes first, as for any task.
 */
export function gettingFood(state: GameState): boolean {
  return (
    state.currentTask?.taskId === FOOD_TASK_ID &&
    state.currentTask.status === 'active' &&
    state.time.known &&
    state.time.value.phase === 'day'
  );
}
