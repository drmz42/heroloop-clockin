# Hero class portraits v6 (prepared, not active)

Full-card variant of v5: each v5 source (head top at 10%) gets 256 px of outpainted background above it
(1024x1792 source, 4:7), so the art can fill the whole card with no empty band while the head stays clear of
the frame rim. Pixels below the 48 px seam are identical to v5. Full art 720x1260 WebP q80, `thumb/` 320x560 q78.
Not referenced by code yet: activation switches `src/game/portraits.ts` from v5 to v6 and resets
`heroPortraitStyle` to a full box (inset 0, height 100%, no mask) with a tuned object position.
