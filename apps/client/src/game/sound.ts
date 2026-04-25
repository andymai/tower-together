// Audio system: viewport-driven facility sound effects + time-of-day ambience.
//
// Effects are sampled from the families currently visible in the camera's
// world view, weighted by per-family tile count, never repeating the same
// sample twice in a row. The cooldown between effects shrinks as the visible
// tile count grows: a near-empty view is sparse, a dense floor is busy.
// Effects play through Web Audio so each one-shot gets a brief fade in/out
// and can carve sub-clip segments out of a longer source (the crowd loop is
// split into five segments). Ambience tracks loop via HTMLAudio gated on the
// in-game hour, and the rooster fires once when the day clock crosses 6 AM.

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

interface Sample {
	id: string;
	src: string;
}

// crowd.mp3 was pre-split offline into five short clips.
const CROWD_SEGMENT_COUNT = 5;
const CROWD_SAMPLES: Sample[] = Array.from(
	{ length: CROWD_SEGMENT_COUNT },
	(_, i) => ({ id: `crowd-${i}`, src: `/sounds/crowd-${i}.mp3` }),
);

const SAMPLES: Sample[] = [
	...CROWD_SAMPLES,
	{ id: "dishes", src: "/sounds/dishes.mp3" },
	{ id: "elevator", src: "/sounds/elevator.mp3" },
	{ id: "fax", src: "/sounds/fax.mp3" },
	{ id: "telephone", src: "/sounds/telephone.mp3" },
];

const SAMPLE_INDEX: Map<string, Sample> = new Map(
	SAMPLES.map((s) => [s.id, s]),
);

const FAMILY_SAMPLE_IDS: Record<SoundFamily, string[]> = {
	food: ["dishes"],
	office: ["fax", "telephone"],
	crowd: CROWD_SAMPLES.map((s) => s.id),
	transport: ["elevator"],
};

const MORNING_AMBIENCE_SRC = "/sounds/morning-ambience.mp3";
const NIGHT_AMBIENCE_SRC = "/sounds/night-ambience.mp3";
const ROOSTER_SRC = "/sounds/rooster.mp3";

const EFFECT_VOLUME = 0.55;
const AMBIENCE_VOLUME = 0.25;
const ROOSTER_VOLUME = 0.7;
const EFFECT_FADE_SECONDS = 0.08;

// Cooldown between effects, scaled by total visible tile count. With one
// audible tile the next sample fires ~6s after the previous ends; the gap
// shrinks as 1/count so a dense floor sounds near-continuous.
const EFFECT_BASE_GAP_MS = 6000;
const EFFECT_MIN_GAP_MS = 100;

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

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
	const w = window as unknown as {
		AudioContext?: AudioContextCtor;
		webkitAudioContext?: AudioContextCtor;
	};
	return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class SoundManager {
	private ctx: AudioContext | null = null;
	private buffers: Map<string, AudioBuffer> = new Map();
	private bufferLoads: Map<string, Promise<void>> = new Map();
	private currentSource: AudioBufferSourceNode | null = null;
	private lastSampleId: string | null = null;
	private nextEffectAtMs: number = 0;
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
		this.currentSource?.stop();
		this.currentSource = null;
		this.morningAmbience.pause();
		this.nightAmbience.pause();
		this.rooster.pause();
		this.ctx?.close().catch(() => {});
		this.ctx = null;
	}

	/** Resume the audio context after a user gesture (Chrome autoplay policy). */
	unlock(): void {
		if (this.destroyed) return;
		const ctx = this.ensureContext();
		if (ctx && ctx.state === "suspended") {
			void ctx.resume().catch(() => {});
		}
	}

	updateAmbience(hour: number): void {
		if (this.destroyed) return;
		const cyclic = ((hour % 24) + 24) % 24;
		const inMorning = cyclic >= 6 && cyclic < 12;
		const inNight = hour >= 20 && hour < DAYBREAK_HOUR;

		this.setLoopPlaying(this.morningAmbience, inMorning);
		this.setLoopPlaying(this.nightAmbience, inNight);

		const prev = this.prevHour;
		// Detect forward crossing of 6 AM in the [0, 31) hour scale. The wrap
		// from ~31 back near 7 (start of the next sim day) is not a daybreak.
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

	updateEffects(familyCounts: ReadonlyMap<SoundFamily, number>): void {
		if (this.destroyed) return;
		if (this.currentSource) return;
		const ctx = this.ensureContext();
		if (!ctx || ctx.state !== "running") return;
		if (performance.now() < this.nextEffectAtMs) return;

		let totalCount = 0;
		for (const count of familyCounts.values()) {
			if (count > 0) totalCount += count;
		}
		if (totalCount === 0) return;

		const target = Math.random() * totalCount;
		let acc = 0;
		let chosenFamily: SoundFamily | null = null;
		for (const [family, count] of familyCounts) {
			if (count <= 0) continue;
			acc += count;
			if (target < acc) {
				chosenFamily = family;
				break;
			}
		}
		if (!chosenFamily) return;

		const ids = FAMILY_SAMPLE_IDS[chosenFamily];
		const samples: Sample[] = [];
		for (const id of ids) {
			const sample = SAMPLE_INDEX.get(id);
			if (sample) samples.push(sample);
		}
		if (samples.length === 0) return;
		const filtered = samples.filter((s) => s.id !== this.lastSampleId);
		const pool = filtered.length > 0 ? filtered : samples;
		const choice = pool[Math.floor(Math.random() * pool.length)];
		if (!choice) return;
		this.playSample(choice, ctx, totalCount);
	}

	private playSample(
		sample: Sample,
		ctx: AudioContext,
		totalCount: number,
	): void {
		const buffer = this.buffers.get(sample.src);
		if (!buffer) {
			void this.loadBuffer(sample.src, ctx);
			return;
		}
		const duration = buffer.duration;
		if (duration <= 0) return;

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		const gainNode = ctx.createGain();
		source.connect(gainNode).connect(ctx.destination);

		const fade = Math.min(EFFECT_FADE_SECONDS, duration / 2);
		const start = ctx.currentTime;
		const fadeOutAt = start + duration - fade;
		gainNode.gain.setValueAtTime(0, start);
		gainNode.gain.linearRampToValueAtTime(EFFECT_VOLUME, start + fade);
		gainNode.gain.setValueAtTime(EFFECT_VOLUME, fadeOutAt);
		gainNode.gain.linearRampToValueAtTime(0, fadeOutAt + fade);

		source.start(start);
		const gapMs = Math.max(EFFECT_MIN_GAP_MS, EFFECT_BASE_GAP_MS / totalCount);
		source.onended = () => {
			if (this.currentSource === source) {
				this.currentSource = null;
				this.nextEffectAtMs = performance.now() + gapMs;
			}
			try {
				source.disconnect();
				gainNode.disconnect();
			} catch {
				// already disconnected
			}
		};
		this.currentSource = source;
		this.lastSampleId = sample.id;
	}

	private ensureContext(): AudioContext | null {
		if (this.ctx) return this.ctx;
		const Ctor = getAudioContextCtor();
		if (!Ctor) return null;
		this.ctx = new Ctor();
		for (const sample of SAMPLES) void this.loadBuffer(sample.src, this.ctx);
		return this.ctx;
	}

	private loadBuffer(src: string, ctx: AudioContext): Promise<void> {
		const existing = this.bufferLoads.get(src);
		if (existing) return existing;
		const promise = (async () => {
			try {
				const response = await fetch(src);
				const data = await response.arrayBuffer();
				const buffer = await ctx.decodeAudioData(data);
				if (!this.destroyed) this.buffers.set(src, buffer);
			} catch {
				this.bufferLoads.delete(src);
			}
		})();
		this.bufferLoads.set(src, promise);
		return promise;
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
