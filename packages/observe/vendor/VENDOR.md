# Vendored browser libraries

Served same-origin from `/ui/vendor/<file>` by pomtreed (see `vendorDir()` in `src/index.ts`). No bundler, no
build step: the UMD files are loaded with plain `<script src>`. Vendored 2026-10-05, all MIT.

| File | Package | Version | Source file in tarball | UMD global |
| --- | --- | --- | --- | --- |
| `xterm.js` | `@xterm/xterm` | 6.0.0 | `package/lib/xterm.js` | `Terminal` |
| `xterm.css` | `@xterm/xterm` | 6.0.0 | `package/css/xterm.css` | n/a |
| `addon-fit.js` | `@xterm/addon-fit` | 0.11.0 | `package/lib/addon-fit.js` | `FitAddon.FitAddon` |
| `addon-webgl.js` | `@xterm/addon-webgl` | 0.19.0 | `package/lib/addon-webgl.js` | `WebglAddon.WebglAddon` |

Licenses: `LICENSE-xterm`, `LICENSE-addon-fit`, `LICENSE-addon-webgl` (verbatim from each tarball).
Files are byte-identical to the tarball contents, so the trailing `//# sourceMappingURL=` comments remain
(the `.map` files are deliberately not vendored; a devtools 404 for them is harmless).

## Sources and integrity (npm `dist.integrity`, sha512)

- https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz
  `sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==`
- https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz
  `sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g==`
- https://registry.npmjs.org/@xterm/addon-webgl/-/addon-webgl-0.19.0.tgz
  `sha512-b3fMOsyLVuCeNJWxolACEUED0vm7qC0cy4wRvf3oURSzDTYVQiGPhTnhWZwIHdvC48Y+oLhvYXnY4XDXPoJo6A==`

## Re-vendoring

1. Download each tarball and check `base64(sha512(tarball))` equals the integrity above (or the new value from
   `npm view @xterm/<pkg>@<version> dist.integrity`).
2. Extract and copy the files in the table above into this directory (rename none; the names already match).
3. Check the UMD globals still exist (load each file in `node:vm` with a fake `window`/`document`/`navigator`).
4. Regenerate checksums: `sha256sum xterm.js xterm.css addon-fit.js addon-webgl.js LICENSE-* > SHA256SUMS`
   and verify with `sha256sum -c SHA256SUMS`. Update this file's versions and date.
5. Keep `xterm.js` and `addon-webgl.js` on compatible versions (the addon declares its xterm peer range).
