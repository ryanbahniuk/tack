import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded before every test file (see bunfig.toml). `src/paths` reads TACK_HOME
// once, at first import, and test files share one module cache — so the scratch
// home has to be set here, before ANY test imports Tack code, or a test could read
// or write the developer's real `~/.tack`.
process.env.TACK_HOME = join(realpathSync(mkdtempSync(join(tmpdir(), "tack-test-home-"))), "tack");
