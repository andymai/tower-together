# Facility Family Docs

These docs define family-specific behavior that sits on top of the shared rules in `FACILITIES.md`, `PEOPLE.md`, `ROUTING.md`, and `ECONOMY.md`.

For the main occupiable / rentable families, the target level of detail is:

- semantic stored state and visible status bands
- exact activation / sale / rental / closure triggers
- route requirements versus mere structural connectivity
- sim creation and stagger rules
- UI-visible status behavior
- end-of-day and checkpoint reset behavior

## Files

- `HOTEL.md`: families `3`, `4`, `5`
- `OFFICE.md`: family `7`, reimplementation-oriented office behavior spec
- `CONDO.md`: family `9`
- `COMMERCIAL.md`: families `6`, `12`, `10`
- `ENTERTAINMENT.md`: movie theater (18/0x12) and party hall (29/0x1d)
- `LOBBY.md`: family `24` (Lobby)
- `PARKING.md`: families `11` (parking space), `44` (parking ramp)
- `RECYCLING.md`: recycling center stack, adequacy checks, and star gate
- `METRO.md`: metro station stack, placement, display toggle, and star gate
- `EVALUATION.md`: cathedral guests and Tower advancement
- `HOTEL.md`: hotel room families and hotel-guest venue visits
- `HOUSEKEEPING.md`: housekeeping helper family
- `MEDICAL.md`: family `13`, medical facility that office workers demand at star `>= 3`
