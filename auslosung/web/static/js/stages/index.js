// Welche Bühne zu welcher Ziehungsart gehört
import { WheelStage } from "./wheel.js";
import { RouletteStage } from "./roulette.js";
import { PlinkoStage } from "./plinko.js";

export const STAGES = { wheel: WheelStage, roulette: RouletteStage, plinko: PlinkoStage };
