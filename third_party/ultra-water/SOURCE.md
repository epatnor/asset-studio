# Ultra-Water (brytande vågor och spetsskum)

Källa: https://github.com/Humpalumps/Ultra-Water (commit `ce9248fa20afbdf63fd4c11709f68d7368aca0a0` 2026-10-28), läst 2026-10-29.

**Licens: MIT** (texten nedan). Delar av koden är porterade och omskrivna här:

- `shared/effects/shore.js`: gångtidsfältet (fast sweeping, fröna vid vattenlinjen, holmarna, riktningen och samstämmigheten) efter `src/water/shoreMap.js`.
- `shared/effects/water.js`: de brytande vågorna (`shoreWaves`), sköljningen och den våta linjen (`SWASH_GLSL`) och spetsskummet (`bakeTextures.js` och skumdelen av `OceanSurface.js`), omskrivna i TSL.

Ingen kod från projektet ligger här i övrigt; inga filer är kopierade.

```
MIT License

Copyright (c) 2026 Humpalumps

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
