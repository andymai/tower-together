// Audio system: viewport-driven facility sound effects + time-of-day ambience.
//
// Effects are sampled from the families currently visible in the camera's
// world view; the next sample is chosen when the previous one ends, never
// repeating the same file twice in a row. Ambience tracks loop and are gated
// on the in-game hour. The rooster fires once when the day clock crosses 6 AM.

export type SoundFamily = "food" | "office" | "crowd" | "transport";

const TILE_TO_FAMILY: Partial<Record<string, SoundFamily>> = {
	restaurant: "food",
	fastFood: "food",
	office: "office",
	lobby: "crowd",
	cinema: "crowd",
	partyHall: "crowd",
	elevator: "transport",
	elevatorExpress: "transport",
	elevatorService: "transport",
	escalator: "transport",
};

const FAMILY_SOUNDS: Record<SoundFamily, string[]> = {
	food: ["/sounds/dishes.mp3"],
	office: ["/sounds/fax.mp3", "/sounds/telephone.mp3"],
	crowd: ["/sounds/crowd.mp3"],
	transport: ["/sounds/elevator.mp3"],
};

const MORNING_AMBIENCE_SRC = "/sounds/morning-ambience.mp3";
const NIGHT_AMBIENCE_SRC = "/sounds/night-ambience.mp3";
const ROOSTER_SRC = "/sounds/rooster.mp3";

const EFFECT_VOLUME = 0.55;
const AMBIENCE_VOLUME = 0.25;
const ROOSTER_VOLUME = 0.7;

// Daybreak hour in the GameScene's 7AM-anchored hour scale: 30 == 6 AM.
const DAYBREAK_HOUR = 30;

export function tileFamily(tileType: string): SoundFamily | null {
	return TILE_TO_FAMILY[tileType] ?? null;
}

function makeLoop(src: string, volume: number): HTMLAudioElement {
	const audio = new Audio(src);
	audio.loop = true;
	audio.volume = volume;
	audio.preload = "auto";
	return audio;
}

export class SoundManager {
	private currentEffect: HTMLAudioElement | null = null;
	private lastEffectSrc: string | null = null;
	private morningAmbience: HTMLAudioElement;
	private nightAmbience: HTMLAudioElement;
	private rooster: HTMLAudioElement;
	private prevHour: number | null = null;
	private destroyed = false;

	constructor() {
		this.morningAmbience = makeLoop(MORNING_AMBIENCE_SRC, AMBIENCE_VOLUME);
		this.nightAmbience = makeLoop(NIGHT_AMBIENCE_SRC, AMBIENCE_VOLUME);
		this.rooster = new Audio(ROOSTER_SRC);
		this.rooster.volume = ROOSTER_VOLUME;
		this.rooster.preload = "auto";
	}

	destroy(): void {
		this.destroyed = true;
		this.currentEffect?.pause();
		this.currentEffect = null;
		this.morningAmbience.pause();
		this.nightAmbience.pause();
		this.rooster.pause();
	}

	updateAmbience(hour: number): void {
		if (this.destroyed) return;
		const cyclic = ((hour % 24) + 24) % 24;
		const inMorning = cyclic >= 6 && cyclic < 12;
		const inNight = hour >= 20 && hour < DAYBREAK_HOUR;

		this.setLoopPlaying(this.morningAmbience, inMorning);
		this.setLoopPlaying(this.nightAmbience, inNight);

		const prev = this.prevHour;
		// Detect forward crossing of 6 AM in the [0, 31) hour scale. Wrap from
		// ~31 back near 7 (start of the next sim day) is not a daybreak event.
		if (
			prev !== null &&
			prev < DAYBREAK_HOUR &&
			hour >= DAYBREAK_HOUR &&
			hour - prev < 12
		) {
			this.rooster.currentTime = 0;
			void this.rooster.play().catch(() => {});
		}
		this.prevHour = hour;
	}

	updateEffects(visibleFamilies: ReadonlySet<SoundFamily>): void {
		if (this.destroyed) return;
		if (this.currentEffect && !this.currentEffect.ended) return;

		const candidates: string[] = [];
		for (const family of visibleFamilies) {
			for (const src of FAMILY_SOUNDS[family]) candidates.push(src);
		}
		if (candidates.length === 0) {
			this.currentEffect = null;
			return;
		}
		const filtered = candidates.filter((src) => src !== this.lastEffectSrc);
		const pool = filtered.length > 0 ? filtered : candidates;
		const choice = pool[Math.floor(Math.random() * pool.length)];
		if (!choice) return;
		this.lastEffectSrc = choice;
		const audio = new Audio(choice);
		audio.volume = EFFECT_VOLUME;
		this.currentEffect = audio;
		void audio.play().catch(() => {
			// Autoplay blocked or load failed — drop the slot so the next tick
			// can retry once the audio context is unlocked by a user gesture.
			if (this.currentEffect === audio) this.currentEffect = null;
		});
	}

	private setLoopPlaying(audio: HTMLAudioElement, shouldPlay: boolean): void {
		if (shouldPlay) {
			if (audio.paused) {
				void audio.play().catch(() => {});
			}
		} else if (!audio.paused) {
			audio.pause();
		}
	}
}
