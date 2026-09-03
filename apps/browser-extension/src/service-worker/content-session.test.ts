import assert from "node:assert/strict";
import test from "node:test";

import {
  beginContentSession,
  finishContentSession,
  type ContentSessionState,
} from "./content-session";

test("content hello messages cannot create a recursive record.start loop", () => {
  const state: ContentSessionState = {
    activeSessionId: null,
    flushedSessionId: null,
  };
  assert.equal(beginContentSession(state, "session-1"), true);
  assert.equal(beginContentSession(state, "session-1"), false);
  assert.equal(beginContentSession(state, "session-1"), false);
  assert.equal(finishContentSession(state, "other-session"), false);
  assert.equal(finishContentSession(state, "session-1"), true);
  assert.equal(beginContentSession(state, "session-2"), true);
});
