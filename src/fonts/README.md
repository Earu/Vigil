# Fonts

Inter and Bebas Neue, self-hosted. They used to be pulled from Google Fonts at
runtime with two `@import`s in `src/index.css`, which meant every launch of a
password manager made a request to Google, and the UI fell back to system fonts
when offline. Neither is acceptable, so the files live here instead.

`fonts.css` is generated: it keeps Google's own `unicode-range` declarations, so
the browser still loads only the subset a given string needs, and anything
outside latin / latin-ext falls through to the stack in `src/index.css`.

## Files

`<Family>-<subset>.woff2`, referenced from `fonts.css`, which `src/index.css`
imports. Vite hashes them into `dist/assets` at build time, and the relative
`url()` keeps working under the `file://` origin the packaged app loads from.

There is no weight in the filename because both families are variable fonts:
one file per subset backs every weight. That is why `fonts.css` has ten
`@font-face` rules over four files, with the Inter 500/600/700 faces pointing
at the same file as 400. Google Fonts serves exactly this, so it is not a
mistake to fix.

## Regenerating

    cd src/fonts && node ../../scripts/fetch-fonts.mjs

Which is to say: fetch the stylesheet for each family with a modern-browser User-Agent (Google
serves woff2 only to those), keep the `latin` and `latin-ext` blocks, download
each distinct `.woff2` once, and rewrite each `src:` to point at the local
file. Weights in use: Inter 400/500/600/700, Bebas Neue 400. Declaring a weight
in the CSS with no face behind it gets you a synthetic-bold fallback rather
than an error, so keep the two in step.

## License

Both families are licensed under the SIL Open Font License 1.1, reproduced in
`OFL.txt`.

- Inter: Copyright (c) 2016 The Inter Project Authors, https://github.com/rsms/inter
- Bebas Neue: Copyright (c) 2010 Dharma Type, https://github.com/dharmatype/Bebas-Neue
