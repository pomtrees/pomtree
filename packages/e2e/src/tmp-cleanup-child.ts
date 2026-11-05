// Child process for tmp-cleanup.test.ts: creates temp dirs through the e2e harness helpers, prints their paths, exits normally.
import { gitRepo, tmp } from "./harness.ts";

console.log(JSON.stringify([gitRepo(), tmp("state")]));
