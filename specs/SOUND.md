# Sound

SimTower drives all notification-style audio through **WAVMIX16.DLL**, a 16-bit wave mixer. The binary imports the following ordinals:

| Ordinal | API                        | Ghidra name                       |
| ------- | -------------------------- | --------------------------------- |
| 3       | `waveOutOpen`              | `wavmix_waveOutOpen`              |
| 4       | `waveOutClose`             | `wavmix_waveOutClose`             |
| 5       | `waveOutWrite`             | `wavmix_waveOutWrite`             |
| 6       | `waveOutPrepareHeader`     | `wavmix_waveOutPrepareHeader`     |
| 7       | `waveOutUnprepareHeader`   | `wavmix_waveOutUnprepareHeader`   |
| 9       | `waveOutGetPosition`       | `wavmix_waveOutGetPosition`       |
| 10      | `waveOutSetVolume`         | `wavmix_waveOutSetVolume`         |
| 11      | `waveOutPause`             | `wavmix_waveOutPause`             |
| 12      | `waveOutRestart`           | `wavmix_waveOutRestart`           |

## Playback helper

`play_wave_resource` (11d0:0167) is the shared "play a wave resource by ID" helper:

- loads a wave resource from `hInstance = 0x2d0c` by logical ID
- pushes header pointer + device handle (DS:0x3760) + `type = 2` (WHDR_PREPARED) and calls `wavmix_waveOutWrite`
- stores the returned wave handle (DX:AX) at DS:0x3a12/0x3a14
- also uses `wavmix_waveOutRestart`; no DialogBox / LoadBitmap on this path

Every wave-playback site in the binary funnels through this helper.

## Wave resource IDs

Logical IDs passed to `play_wave_resource`. These are **wave clips, not bitmaps**; they produce no visible popup.

### Random-news + newspaper family (classifier-driven)

- `0x568` / `0x569`: restaurant jingles
- `0x5a8`: office jingle
- `0x628` / `0x629`: condo jingles
- `0x668`: retail-shop jingle
- `0x6a8` / `0x6a9`: parking-space jingles
- `0xb28`: party-hall jingle
- `0x2712`: general-tower "periodic-maintenance" fallback jingle
- `0x271b` / `0x271c`: general-tower day-counter fallback jingles
- `0x271d`: family-`3/4/5` checkout-sale newspaper jingle

In the NE resource table the 0x271x logical IDs are stored with the high bit set (for example `0x2712` → raw resource id `0xa712`); the loader strips that bit before lookup.

## Random-news sound dispatcher

Dispatcher: `play_classified_news_sound` (11d0:042c). Called once per tick from the day scheduler's early event hook (see TIME.md). The path is audio-only — there is no visual popup / dialog / on-screen message produced here.

Trigger gates:

- notifications enabled and `(game_state_flags & 0x09) == 0` (the same bomb/fire suppression bits used elsewhere in the event system)
- first RNG gate: `random() % 16 == 0`
- second RNG roll: `random() % 6`, selecting one of six viewport buckets

Viewport bucket coordinates (used to sample the occupancy grid):

- `0`: `x = visible_width / 4`, `y = (visible_height - 1) / 2`
- `1`: `x = visible_width / 2`, `y = (visible_height - 1) / 2`
- `2`: `x = visible_width - visible_width / 4`, `y = (visible_height - 1) / 2`
- `3`: `x = visible_width / 4`, `y = (visible_height - 1) - (visible_height - 1) / 4`
- `4`: `x = visible_width / 2`, `y = (visible_height - 1) - (visible_height - 1) / 4`
- `5`: `x = visible_width - visible_width / 4`, `y = (visible_height - 1) - (visible_height - 1) / 4`

The sampled viewport row is converted back to an absolute floor index before classification.

### Classifier return codes

- `-2`: suppress (play nothing)
- `-1`: empty tile above ground; eligible for the general-tower fallback path
- positive values: family / subject codes consumed by the wave mapper below

### Empty-tile handling

- if the sampled slot is empty and absolute floor index is below `10`, classification returns `-2` and the event is suppressed
- if the slot is empty on floor `10` or above, classification returns `-1`, which the caller turns into the general-tower fallback

### Facility eligibility rules

- hotel families `3/4/5`: `state_byte < 0x10` and `(state_byte & 0x07) != 0`
- condo family `9`: `state_byte < 0x10` and `(state_byte & 0x07) != 0`
- office family `7`: `state_byte < 0x08` and `(state_byte & 0x07) != 0`
- restaurant / fast-food / retail families `6`, `0x0c`, `0x10`: linked `CommercialVenueRecord.state` must be neither `-1` nor `3`, and `CommercialVenueRecord.activity_byte` must be nonzero
- parking ramp family `0x0b`: state byte must be `> 1`
- single-screen entertainment families `0x1d/0x1e`: linked entertainment `link_phase_state` must be `> 1`
- paired entertainment families `0x12/0x13/0x22/0x23`: linked entertainment `link_phase_state` must equal `3`; on success the classifier returns `0x2329 + family_selector_or_single_link_flag`
- all other families, and all inactive / not-ready records, return `-2`

### Wave-clip mapping for positive classifier codes

- `3`, `4`, `5` -> wave `0x629`
- `6` -> wave `0x568` or `0x569` with equal probability
- `7` -> wave `0x5a8`
- `9` -> wave `0x628` on `1/10`, else `0x629`
- `0x0b` -> wave `0x6a8` or `0x6a9` with equal probability
- `0x0c`, `0x10` -> wave `0x569` or `0x668` with equal probability
- `0x1d`, `0x1e` -> wave `0x0b28`

### General-tower fallback for classifier result `-1`

The fallback reaches the wave dispatcher through a one-argument far-call shim, so the helper treats `-1` as enabled there.

- if the periodic-maintenance gate is set, play wave `0x2712`
- otherwise:
  - if `(day_counter / 3) % 4 == 2` and `pre_day_4() != 0`, play wave `0x271c`
  - if `(day_counter / 3) % 4 == 3` and `pre_day_4() == 0`, play wave `0x271b`
  - all other cases suppress the event

### Paired-entertainment note

- the paired-link classifier path returns `0x2329 + family_selector_or_single_link_flag`
- the downstream wave switch does not recognize that range, and no wave resources in the `0x2329..0x2335` range were recovered from the extracted manifest
- inference: ready paired entertainment samples do not produce an audible sound in practice, despite reaching a distinct classifier branch

## Checkout newspaper sound

Family-`3/4/5` sale / checkout completions play wave `0x271d` through the same helper. This is not queued as an event; it is a single latch polled on the next cash-display refresh.

Producer (`deactivate_family_345_unit_with_income`):

- increments the cumulative `family345_sale_count`
- if `family345_sale_count < 20`: sets `newspaper_trigger = 1` exactly on even counts, else `0`
- if `family345_sale_count >= 20`: sets `newspaper_trigger = 1` exactly on counts divisible by `8`, else `0`

Consumer (currently named `update_cash_display_and_maybe_show_newspaper_popup`; the trailing "show_popup" is a misnomer — the call is a wave playback):

- runs from the shared cash-display refresh helper used by income, refunds, and construction-cost updates
- if `cash_report_dirty_flag != 0` and `newspaper_trigger != 0`: plays wave `0x271d` via `play_wave_resource(0x271d, 2, 3)` before redrawing the cash panel
- after playing, forces `newspaper_trigger = 1` again; later non-milestone family-`3/4/5` transactions are what clear it back to `0`

## Clone-room mapping

- The sim worker does not play audio. It is responsible only for the RNG-consuming trigger gates that keep the shared RNG stream aligned with the binary.
- Audio playback and resource loading belong on the client once the audio subsystem lands.
- For parity traces: compare classifier outcomes and wave-ID selection, not PCM buffers.
