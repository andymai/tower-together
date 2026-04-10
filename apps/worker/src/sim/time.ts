// Day cycle constants
export const DAY_TICK_MAX = 0x0a28; // 2600 ticks per day
export const DAY_TICK_INCOME = 0x08fc; // 2300: checkpoint where dayCounter increments
export const DAY_COUNTER_WRAP = 0x2ed4;

/**
 * Starting dayTick for a new game (from new_game_initializer at 0x10d8_07f6).
 * Value 2533 = daypartIndex 6 — game starts mid-day; first full daily checkpoint
 * sequence (0x000..0xa27) runs only on the second sim day.
 */
export const NEW_GAME_DAY_TICK = 0x9e5; // 2533

export interface TimeState {
	/** Current position within the day (0–2599). */
	dayTick: number;
	/** dayTick / 400, integer (0–6). */
	daypartIndex: number;
	/** Increments at checkpoint 0x08fc each day. Used for calendar logic. */
	dayCounter: number;
	/** (dayCounter % 12) % 3 >= 2 ? 1 : 0 */
	calendarPhaseFlag: number;
	/** 1–6 (6 = Tower). */
	starCount: number;
	/** Monotonically increasing tick counter since game start (for broadcast). */
	totalTicks: number;
}

/** Zero-based time state for unit tests and generic initialization. */
export function createTimeState(): TimeState {
	return {
		dayTick: 0,
		daypartIndex: 0,
		dayCounter: 0,
		calendarPhaseFlag: 0,
		starCount: 1,
		totalTicks: 0,
	};
}

/**
 * New-game time state matching new_game_initializer at 0x10d8_07f6.
 * Starts at tick 0x9e5 (daypart 6) so the first full day cycle begins on day 2.
 */
export function createNewGameTimeState(): TimeState {
	return {
		dayTick: NEW_GAME_DAY_TICK,
		daypartIndex: Math.floor(NEW_GAME_DAY_TICK / 400), // = 6
		dayCounter: 0,
		calendarPhaseFlag: 0,
		starCount: 1,
		totalTicks: 0,
	};
}

/**
 * Advance time by one tick. Returns the new state and whether the
 * DAY_TICK_INCOME checkpoint was just crossed (triggers income collection).
 */
export function advanceOneTick(t: TimeState): {
	time: TimeState;
	incomeCheckpoint: boolean;
} {
	const totalTicks = t.totalTicks + 1;
	let dayTick = t.dayTick + 1;
	let dayCounter = t.dayCounter;
	let calendarPhaseFlag = t.calendarPhaseFlag;
	let incomeCheckpoint = false;

	if (dayTick >= DAY_TICK_MAX) {
		dayTick = 0;
	}

	if (dayTick === DAY_TICK_INCOME) {
		dayCounter = t.dayCounter + 1;
		if (dayCounter >= DAY_COUNTER_WRAP) {
			dayCounter = 0;
		}
		calendarPhaseFlag = (dayCounter % 12) % 3 >= 2 ? 1 : 0;
		incomeCheckpoint = true;
	}

	return {
		time: {
			dayTick: dayTick,
			daypartIndex: Math.floor(dayTick / 400),
			dayCounter: dayCounter,
			calendarPhaseFlag: calendarPhaseFlag,
			starCount: t.starCount,
			totalTicks: totalTicks,
		},
		incomeCheckpoint,
	};
}

export function pre_day_4(t: TimeState): boolean {
	return t.daypartIndex < 4;
}
