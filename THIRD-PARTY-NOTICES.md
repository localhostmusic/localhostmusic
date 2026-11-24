# Third-party notices

Localhost Music is licensed under the [GNU AGPL v3](LICENSE). Parts of it are
ported from, or built on, other people's work. Their notices are below.

Libraries installed through npm and Go modules (React, Fastify, Electron,
better-sqlite3, sharp, music-metadata, TagLib and the rest) keep their own
licenses in their packages. They are listed in each `package.json` and in
`server/scanner-go/go.mod`.

## Vissonance

The Iris, Fracture, Siphon and Silk visualizers are ports to raw WebGL of the
presets of the same names in [Vissonance](https://github.com/tariqksoliman/Vissonance)
by Tariq Soliman. The bars, wave and radial styles use its spectrum sampling.

Files: `web/src/player/IrisVisualizer.tsx`, `FractureVisualizer.tsx`,
`SiphonVisualizer.tsx`, `SilkVisualizer.tsx`, and `vissonanceBins` in `vizCommon.ts`.

```
MIT License

Copyright (c) 2020 Tariq Soliman

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

## webgl-noise

The Orb visualizer's shader includes the 3D simplex noise function from
[webgl-noise](https://github.com/stegu/webgl-noise) by Ashima Arts and Stefan Gustavson.

File: `web/src/player/OrbVisualizer.tsx`.

```
Copyright (C) 2011 by Ashima Arts (Simplex noise)
Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)

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

## webgl-music-visualizer

The Neon and Orb visualizers are modeled on
[webgl-music-visualizer](https://github.com/wayne-wu/webgl-music-visualizer) by Wayne Wu:
the nested displaced spheres, the audio response curve and the bloom look. They are
written from scratch in raw WebGL and contain none of that project's code.

## Geist

The interface font is [Geist](https://github.com/vercel/geist-font) by Vercel, under the
SIL Open Font License 1.1. Its license ships in the `@fontsource-variable/geist` package.

## FFmpeg

The desktop app bundles an [FFmpeg](https://ffmpeg.org) binary through
[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static). FFmpeg is licensed under the
GPL v3 in that build. Its source is available at https://ffmpeg.org/download.html.
