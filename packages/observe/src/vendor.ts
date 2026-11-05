import { fileURLToPath } from "node:url";

// Absolute path of packages/observe/vendor: the vendored browser libraries (xterm.js, xterm.css, addon-fit.js,
// addon-webgl.js; see vendor/VENDOR.md). pomtreed serves them same-origin at /ui/vendor/<file>.
export const vendorDir = (): string => fileURLToPath(new URL("../vendor", import.meta.url));
