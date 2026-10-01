import { describe, expect, it } from 'vitest';
import { GARDEN_BLOCKS } from '../../src/domain/blocks.ts';
import {
  ANIMAL_DROPS,
  animalDrops,
  bestMeal,
  carriedFoodPoints,
  FOOD_ANIMALS,
  FOOD_GARDENS,
  FOOD_POINTS,
  FOOD_TASK_ID,
  foodPoints,
  GARDEN_BIOMES,
  GARDEN_DROPS,
  GARDEN_FOODS,
  gettingFood,
  MEAL_HISTORY_LENGTH,
  mealPoints,
  spiceOfLifeModifier,
  UNSAFE_FOODS,
} from '../../src/domain/food.ts';
import { SafetyConfigSchema } from '../../src/domain/safety.ts';
import { makeState } from '../fixtures/index.ts';

const APPROVED = SafetyConfigSchema.parse({}).approvedFoods;

describe('the approved foods (a reviewed allowlist)', () => {
  it('never holds a food that is unsafe raw, or worth keeping', () => {
    for (const unsafe of UNSAFE_FOODS.keys()) expect(APPROVED, unsafe).not.toContain(unsafe);
    // Raw chicken can give Hunger: chickens are no food animal either.
    expect(FOOD_ANIMALS.has('minecraft:Chicken')).toBe(false);
  });

  it('holds the produce of every land garden, the raw meat of the food animals, and berries', () => {
    for (const food of GARDEN_FOODS) expect(APPROVED, food).toContain(food);
    for (const animal of FOOD_ANIMALS) {
      const meat = ANIMAL_DROPS[animal]?.[0]?.item;
      expect(meat, animal).toBeDefined();
      expect(APPROVED, animal).toContain(meat);
    }
    expect(APPROVED).toContain('BiomesOPlenty:food'); // berries (meta 0)
    expect(APPROVED).toContain('BiomesOPlenty:food@8'); // persimmons
    expect(APPROVED).toContain('minecraft:apple');
  });

  it('has a value read in HungerOverhaul for every approved food (a crop is 1)', () => {
    for (const food of APPROVED) {
      expect(FOOD_POINTS.has(food) || GARDEN_FOODS.includes(food), food).toBe(true);
      expect(foodPoints(food), food).toBeGreaterThanOrEqual(1);
    }
    expect(foodPoints('minecraft:bread')).toBe(3);
    expect(foodPoints('minecraft:cooked_beef')).toBe(2);
    expect(foodPoints('harvestcraft:cantaloupeItem')).toBe(2);
    // Seen live: an apple gave 1 (food 8 -> 9).
    expect(foodPoints('minecraft:apple')).toBe(1);
    expect(foodPoints('harvestcraft:strawberryItem')).toBe(1);
  });
});

describe("HarvestCraft's gardens", () => {
  it('lists the drops of every land garden, and which of them are food', () => {
    expect(Object.keys(GARDEN_DROPS).sort()).toEqual([...GARDEN_BLOCKS].sort());
    expect(Object.keys(GARDEN_BIOMES).sort()).toEqual([...GARDEN_BLOCKS].sort());
    for (const notFood of [
      'minecraft:cactus',
      'minecraft:pumpkin',
      'minecraft:brown_mushroom',
      'minecraft:red_mushroom',
      'harvestcraft:cottonItem',
    ]) {
      expect(GARDEN_FOODS, notFood).not.toContain(notFood);
    }
    expect(GARDEN_FOODS).toContain('minecraft:carrot');
    expect(GARDEN_FOODS).toContain('harvestcraft:cactusfruitItem');
  });

  it('gets food from every land garden but the textile garden (cotton only)', () => {
    expect(FOOD_GARDENS).not.toContain('harvestcraft:textilegarden');
    expect(FOOD_GARDENS).toHaveLength(GARDEN_BLOCKS.length - 1);
  });
});

describe('farm animals', () => {
  it('drop raw meat, and more (vanilla dropFewItems; HarvestCraft mutton)', () => {
    expect(animalDrops('minecraft:Cow')).toEqual(['minecraft:beef', 'minecraft:leather']);
    expect(animalDrops('minecraft:Pig')).toEqual(['minecraft:porkchop']);
    expect(animalDrops('minecraft:Sheep')).toEqual([
      'harvestcraft:muttonrawItem',
      'minecraft:wool',
    ]);
    expect(animalDrops('minecraft:Zombie')).toEqual([]);
    expect([...FOOD_ANIMALS].sort()).toEqual(['minecraft:Cow', 'minecraft:Pig', 'minecraft:Sheep']);
  });
});

describe('Spice of Life: the same food again is worth less', () => {
  it('follows the installed formula', () => {
    for (const count of [0, 1, 2, 3, 4]) expect(spiceOfLifeModifier(count, 1)).toBe(1);
    expect(spiceOfLifeModifier(5, 1)).toBe(0.875);
    expect(spiceOfLifeModifier(6, 3)).toBe(0.75);
    // Past 12 the first term is gone; the second gives 1/hunger while count - 8 < hunger.
    expect(spiceOfLifeModifier(12, 3)).toBe(0);
    expect(spiceOfLifeModifier(10, 3)).toBeCloseTo(1 / 3);
  });

  it('rounds the points down: a 1-point food eaten 5 times lately restores nothing', () => {
    const apples = (n: number): string[] => Array<string>(n).fill('minecraft:apple');
    expect(mealPoints('minecraft:apple', apples(4))).toBe(1);
    expect(mealPoints('minecraft:apple', apples(5))).toBe(0);
    expect(mealPoints('minecraft:bread', Array<string>(5).fill('minecraft:bread'))).toBe(2);
    // Only the last 20 meals count.
    const old = [...Array<string>(MEAL_HISTORY_LENGTH).fill('minecraft:carrot'), ...apples(5)];
    expect(mealPoints('minecraft:apple', old)).toBe(1);
  });

  it('picks the carried food that restores the most now, never a protected one', () => {
    const items = { 'minecraft:apple': 3, 'minecraft:bread': 1, 'minecraft:carrot': 2 };
    expect(bestMeal(items, APPROVED)).toEqual({ item: 'minecraft:bread', points: 3 });
    expect(bestMeal(items, APPROVED, [], (i) => i === 'minecraft:bread')).toEqual({
      item: 'minecraft:apple',
      points: 1,
    });
    // Apples eaten 5 times lately: the carrot.
    const lately = Array<string>(5).fill('minecraft:apple');
    expect(bestMeal({ 'minecraft:apple': 3, 'minecraft:carrot': 2 }, APPROVED, lately)).toEqual({
      item: 'minecraft:carrot',
      points: 1,
    });
    // Nothing that would restore anything: none (eating it would waste it).
    expect(bestMeal({ 'minecraft:apple': 3 }, APPROVED, lately)).toBeNull();
    expect(bestMeal({ 'minecraft:rotten_flesh': 9 }, APPROVED)).toBeNull();
  });

  it('counts what the carried food restores, eaten meal by meal', () => {
    // Six apples: five restore 1 each, the sixth nothing (five apples in the history).
    expect(carriedFoodPoints({ 'minecraft:apple': 6 }, APPROVED)).toBe(5);
    // Variety: three apples and three carrots restore 6.
    expect(carriedFoodPoints({ 'minecraft:apple': 3, 'minecraft:carrot': 3 }, APPROVED)).toBe(6);
    expect(carriedFoodPoints({ 'minecraft:bread': 6 }, APPROVED, [], () => false, 10)).toBe(10);
    expect(carriedFoodPoints({}, APPROVED)).toBe(0);
  });
});

describe('getting food', () => {
  const onFoodTask = (timeOfDay: number, status: 'active' | 'paused' = 'active') =>
    makeState((w) => {
      w.task = { taskId: FOOD_TASK_ID, goal: 'Get food', subgoal: '0/10', status };
      w.timeOfDay = timeOfDay;
    });

  it('is the food task, active, by day', () => {
    expect(gettingFood(onFoodTask(6000))).toBe(true);
    expect(gettingFood(onFoodTask(12_500))).toBe(false); // evening: the shelter comes first
    expect(gettingFood(onFoodTask(18_000))).toBe(false);
    expect(gettingFood(onFoodTask(6000, 'paused'))).toBe(false);
    expect(gettingFood(makeState())).toBe(false); // another task
  });
});
