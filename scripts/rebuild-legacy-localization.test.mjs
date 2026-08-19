import assert from "node:assert/strict";
import test from "node:test";

import { parseLegacyLocalizationArgs } from "./rebuild-legacy-localization.mjs";

test("legacy localization command is preview-first and requires explicit commit", () => {
  const preview = parseLegacyLocalizationArgs(["--registry", "./registry.sqlite", "--project", "project-1"]);
  assert.equal(preview.commit, false);
  assert.match(preview.projection, /registry\.sqlite\.localization\.sqlite$/u);
  assert.equal(parseLegacyLocalizationArgs(["--registry", "./registry.sqlite", "--project", "project-1", "--commit"]).commit, true);
  assert.throws(() => parseLegacyLocalizationArgs(["--registry", "./registry.sqlite"]), /--registry and --project/u);
  assert.throws(() => parseLegacyLocalizationArgs(["--projection", "./projection.sqlite", "--rollback", "r1", "--commit"]),
    /rollback requires only/u);
});
