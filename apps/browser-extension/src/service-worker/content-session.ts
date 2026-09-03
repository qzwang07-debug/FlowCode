export interface ContentSessionState {
  activeSessionId: string | null;
  flushedSessionId: string | null;
}

/** Returns true only when a record.start must cross this content port. */
export function beginContentSession(
  state: ContentSessionState,
  sessionId: string,
): boolean {
  if (state.activeSessionId === sessionId) return false;
  state.activeSessionId = sessionId;
  state.flushedSessionId = null;
  return true;
}

export function finishContentSession(
  state: ContentSessionState,
  sessionId: string,
): boolean {
  if (state.activeSessionId !== sessionId) return false;
  state.activeSessionId = null;
  state.flushedSessionId = sessionId;
  return true;
}
