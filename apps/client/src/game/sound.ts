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

export type SoundFamily =
	| "food"
	| "office"
	| "crowd"
	| "transport"
	| "lodging"
	| "retail"
	| "medical"
	| "housekeeping"
	| "security"
	| "parking";

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
	metro: "transport",
	hotelSingle: "lodging",
	hotelTwin: "lodging",
	hotelSuite: "lodging",
	condo: "lodging",
	retail: "retail",
	medical: "medical",
	housekeeping: "housekeeping",
	recyclingCenter: "housekeeping",
	security: "security",
	parking: "parking",
};

// Hotel housekeeping is only audible during the cleaning shift (11 AM – 3 PM).
const HOUSEKEEPING_HOUR_START = 11;
const HOUSEKEEPING_HOUR_END = 15;

export interface TransportDirections {
	up: boolean;
	down: boolean;
}

interface Sample {
	id: string;
	src: string;
}

// crowd.mp3 was pre-split offline into five short clips.
const CROWD_SEGMENT_COUNT = 5;
const CROWD_SAMPLES: Sample[] = Array.from(
	{ length: CROWD_SEGMENT_COUNT },
	(_, i) => ({ id: `crowd-${i}`, src: `/sounds/crowd-${i}.webm` }),
);

const KACHING_ID = "kaching";

const SAMPLES: Sample[] = [
	...CROWD_SAMPLES,
	{ id: "dishes", src: "/sounds/dishes.webm" },
	{ id: "elevator-down", src: "/sounds/elevator-down.webm" },
	{ id: "elevator-up", src: "/sounds/elevator-up.webm" },
	{ id: "fax", src: "/sounds/fax.webm" },
	{ id: "telephone", src: "/sounds/telephone.webm" },
	{ id: "telephone2", src: "/sounds/telephone2.webm" },
	{ id: "hospital-monitor", src: "/sounds/hospital-monitor.webm" },
	{ id: "mop", src: "/sounds/mop.webm" },
	{ id: "vacuum", src: "/sounds/vacuum.webm" },
	{ id: "radio", src: "/sounds/radio.webm" },
	{ id: "radio2", src: "/sounds/radio2.webm" },
	{ id: "retail-door-open", src: "/sounds/retail-door-open.webm" },
	{ id: "shower", src: "/sounds/shower.webm" },
	{ id: "tires", src: "/sounds/tires.webm" },
	{ id: KACHING_ID, src: "/sounds/kaching.webm" },
];

const SAMPLE_INDEX: Map<string, Sample> = new Map(
	SAMPLES.map((s) => [s.id, s]),
);

const FAMILY_SAMPLE_IDS: Record<SoundFamily, string[]> = {
	food: ["dishes"],
	office: ["fax", "telephone", "telephone2"],
	crowd: CROWD_SAMPLES.map((s) => s.id),
	transport: ["elevator-down", "elevator-up"],
	lodging: ["shower"],
	retail: ["retail-door-open"],
	medical: ["hospital-monitor"],
	housekeeping: ["mop", "vacuum"],
	security: ["radio", "radio2"],
	parking: ["tires"],
};

const MORNING_AMBIENCE_SRC = "/sounds/morning-ambience.webm";
const AFTERNOON_AMBIENCE_SRC = "/sounds/afternoon-ambience.webm";
const NIGHT_AMBIENCE_SRC = "/sounds/night-ambience.webm";
const ROOSTER_SRC = "/sounds/rooster.webm";

const EFFECT_VOLUME = 0.55;
const AMBIENCE_VOLUME = 0.25;
const ROOSTER_VOLUME = 0.7;
const EFFECT_FADE_SECONDS = 0.4;

// Cooldown between effect starts, measured from the start of the previous
// sample's fade-out so consecutive samples crossfade. Scales by total visible
// tile count: a near-empty view leaves ~6s of silence between samples; a
// dense floor lets the next sample begin as the previous fades out.
const EFFECT_BASE_GAP_MS = 6000;
const EFFECT_MIN_GAP_MS = 0;

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
	private activeSources: Set<AudioBufferSourceNode> = new Set();
	private lastSampleId: string | null = null;
	private nextEffectAtMs: number = 0;
	private currentHour: number | null = null;
	private kachingPending = false;
	private morningAmbience: HTMLAudioElement;
	private afternoonAmbience: HTMLAudioElement;
	private nightAmbience: HTMLAudioElement;
	private rooster: HTMLAudioElement;
	private prevHour: number | null = null;
	private destroyed = false;

	constructor() {
		this.morningAmbience = makeLoop(MORNING_AMBIENCE_SRC, AMBIENCE_VOLUME);
		this.afternoonAmbience = makeLoop(AFTERNOON_AMBIENCE_SRC, AMBIENCE_VOLUME);
		this.nightAmbience = makeLoop(NIGHT_AMBIENCE_SRC, AMBIENCE_VOLUME);
		this.rooster = new Audio(ROOSTER_SRC);
		this.rooster.volume = ROOSTER_VOLUME;
		this.rooster.preload = "auto";
	}

	destroy(): void {
		this.destroyed = true;
		for (const source of this.activeSources) {
			try {
				source.stop();
			} catch {
				// already stopped
			}
		}
		this.activeSources.clear();
		this.morningAmbience.pause();
		this.afternoonAmbience.pause();
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
		this.currentHour = hour;
		const cyclic = ((hour % 24) + 24) % 24;
		const inMorning = cyclic >= 6 && cyclic < 12;
		const inAfternoon = cyclic >= 12 && cyclic < 20;
		const inNight = hour >= 20 && hour < DAYBREAK_HOUR;

		this.setLoopPlaying(this.morningAmbience, inMorning);
		this.setLoopPlaying(this.afternoonAmbience, inAfternoon);
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

	/**
	 * Queue the kaching effect to fire as the next sample. Income events call
	 * this; the next `updateEffects` tick plays kaching immediately, bypassing
	 * the count-scaled cooldown and visible-family weighting.
	 */
	triggerCash(): void {
		if (this.destroyed) return;
		this.kachingPending = true;
	}

	updateEffects(
		familyCounts: ReadonlyMap<SoundFamily, number>,
		transport: TransportDirections = { up: false, down: false },
	): void {
		if (this.destroyed) return;
		const ctx = this.ensureContext();
		if (!ctx || ctx.state !== "running") return;

		if (this.kachingPending) {
			const sample = SAMPLE_INDEX.get(KACHING_ID);
			if (sample) {
				this.kachingPending = false;
				this.playSample(sample, ctx, 1);
				return;
			}
		}

		if (performance.now() < this.nextEffectAtMs) return;

		const housekeepingActive = this.isHousekeepingActive();
		const transportActive = transport.up || transport.down;
		const familyAllowed = (family: SoundFamily): boolean => {
			if (family === "housekeeping") return housekeepingActive;
			if (family === "transport") return transportActive;
			return true;
		};
		// Elevator dings are the most diegetic transport cue, so weight the
		// transport family heavily versus other facilities.
		const familyWeight = (family: SoundFamily): number =>
			family === "transport" ? 10 : 1;

		let totalCount = 0;
		for (const [family, count] of familyCounts) {
			if (count <= 0) continue;
			if (!familyAllowed(family)) continue;
			totalCount += count * familyWeight(family);
		}
		if (totalCount === 0) return;

		const target = Math.random() * totalCount;
		let acc = 0;
		let chosenFamily: SoundFamily | null = null;
		for (const [family, count] of familyCounts) {
			if (count <= 0) continue;
			if (!familyAllowed(family)) continue;
			acc += count * familyWeight(family);
			if (target < acc) {
				chosenFamily = family;
				break;
			}
		}
		if (!chosenFamily) return;

		const ids =
			chosenFamily === "transport"
				? this.transportSampleIds(transport)
				: FAMILY_SAMPLE_IDS[chosenFamily];
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

	private transportSampleIds(transport: TransportDirections): string[] {
		const ids: string[] = [];
		if (transport.up) ids.push("elevator-up");
		if (transport.down) ids.push("elevator-down");
		return ids;
	}

	private isHousekeepingActive(): boolean {
		const hour = this.currentHour;
		if (hour === null) return false;
		const cyclic = ((hour % 24) + 24) % 24;
		return cyclic >= HOUSEKEEPING_HOUR_START && cyclic < HOUSEKEEPING_HOUR_END;
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
		// Schedule the next sample to begin as this one starts fading out, so
		// consecutive effects crossfade. Sparse views still see silence because
		// gapMs grows large when totalCount is small.
		this.nextEffectAtMs =
			performance.now() + Math.max(0, duration - fade) * 1000 + gapMs;
		this.activeSources.add(source);
		source.onended = () => {
			this.activeSources.delete(source);
			try {
				source.disconnect();
				gainNode.disconnect();
			} catch {
				// already disconnected
			}
		};
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
