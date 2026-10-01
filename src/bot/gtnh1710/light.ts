/**
 * How the 1.7.10 server lights a mob, mirrored exactly: Java's float arithmetic (every float
 * operation rounded with Math.fround) and MathHelper's sine table. Verified in
 * minecraft_server.1.7.10.jar with Forge 10.13.4.1614's patches applied, and in the mod jars
 * that touch it (docs/gtnh-compatibility.md, "Spiders in the light"):
 *  - Entity.getBrightness(1.0F) reads World.getLightBrightness at floor(posX),
 *    floor(posY - yOffset + boxHeight * 0.66), floor(posZ) (0 when that column is not
 *    loaded); yOffset is 0 for mobs. That is the provider's brightness table at
 *    World.getBlockLightValue (see the world model).
 *  - The darkness of the time of day is World.skylightSubtracted, which WorldServer.tick sets
 *    every tick to calculateSkylightSubtracted(1.0F): Forge routes it through
 *    WorldProvider.getSunBrightnessFactor, which the overworld's provider keeps as World's
 *    (WorldProviderSurface, and BiomesOPlenty's WorldProviderSurfaceBOP, which replaces it
 *    on this server, override neither it nor calculateCelestialAngle).
 *  - No mod changes it on the server: Galacticraft's getRainStrength mixin and Darkerer's
 *    only change the client, TConstruct's OverworldProvider is never registered.
 */

const f = Math.fround;

let sinTable: Float32Array | null = null;

/** MathHelper.cos: SIN_TABLE[(int)(x * 10430.378F + 16384.0F) & 65535], 65536 floats. */
export function mcCos(x: number): number {
  if (sinTable === null) {
    sinTable = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) sinTable[i] = Math.sin((i * Math.PI * 2) / 65536);
  }
  return sinTable[Math.trunc(f(f(x * f(10430.378)) + 16384)) & 65535] as number;
}

/** WorldProvider.calculateCelestialAngle(worldTime, partialTicks): 0 is noon, 0.5 midnight. */
export function celestialAngle(worldTime: number, partialTicks: number): number {
  const j = Math.trunc(worldTime) % 24000; // (int)(worldTime % 24000L)
  let a = f(f(f(f(j) + f(partialTicks)) / 24000) - 0.25);
  if (a < 0) a = f(a + 1);
  if (a > 1) a = f(a - 1);
  const raw = a;
  a = f(1 - f((Math.cos(a * Math.PI) + 1) / 2));
  return f(raw + f(f(a - raw) / 3));
}

/**
 * World.getSunBrightnessFactor(partialTicks): the sun's light, 0-1, dimmed by the rain
 * strength and by the thunder strength weighted by the rain (getWeightedThunderStrength),
 * both 0-1 as the server keeps them.
 */
export function sunBrightnessFactor(
  worldTime: number,
  rain: number,
  thunder: number,
  partialTicks = 1,
): number {
  const angle = celestialAngle(worldTime, partialTicks);
  let b = f(1 - f(f(mcCos(f(f(angle * f(3.1415927)) * 2)) * 2) + 0.5));
  if (b < 0) b = 0;
  if (b > 1) b = 1;
  b = f(1 - b);
  b = f(b * (1 - f(rain * 5) / 16));
  return f(b * (1 - f(f(thunder * rain) * 5) / 16));
}

/**
 * World.calculateSkylightSubtracted(1.0F): how much the sky's light is dimmed now, 0 (day) to
 * 11 (night): 3 at noon in the rain, 5 at noon in a thunderstorm.
 */
export function skylightSubtracted(worldTime: number, rain: number, thunder: number): number {
  return Math.trunc(f(f(1 - sunBrightnessFactor(worldTime, rain, thunder, 1)) * 11));
}

/**
 * WorldProvider.generateLightBrightnessTable as the overworld has it (no minimum light):
 * the brightness of each light level, 0-15. Level 11 is 0.41, level 12 0.50000006.
 */
export const OVERWORLD_BRIGHTNESS: readonly number[] = Array.from({ length: 16 }, (_, i) => {
  const dark = f(1 - f(f(i) / 15));
  return f(f(f(1 - dark) / f(f(dark * 3) + 1)) * 1);
});

/**
 * The height at which Entity.getBrightness reads the light of a mob standing with its feet
 * at `feetY`: its box's height (a float) x 0.66 above the feet.
 */
export function lightPointY(feetY: number, height: number): number {
  return feetY + f(height) * 0.66;
}
