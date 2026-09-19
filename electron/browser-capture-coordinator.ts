import type { BrowserCaptureSummary } from "../common/browser";
import type { RecordingBrowserSelection } from "../common/ziniao-recording";

interface StandardCapture {
  startSession(
    sessionId: string,
    sessionDir: string,
    startedAt: number,
    browser?: "chrome" | "edge",
  ): Promise<void>;
  stopSession(sessionId: string): Promise<BrowserCaptureSummary>;
  dispose(): Promise<void>;
}

interface ZiniaoCapture {
  startSession(
    sessionId: string,
    sessionDir: string,
    startedAt: number,
    selection: Extract<RecordingBrowserSelection, { provider: "ziniao" }>,
  ): Promise<void>;
  stopSession(sessionId: string): Promise<BrowserCaptureSummary>;
  dispose(): Promise<void>;
}

export class BrowserCaptureCoordinator {
  private active:
    | { sessionId: string; provider: "standard" }
    | { sessionId: string; provider: "ziniao" }
    | null = null;

  constructor(
    private readonly standard: StandardCapture,
    private readonly ziniao: ZiniaoCapture,
  ) {}

  async startSession(
    sessionId: string,
    sessionDir: string,
    startedAt: number,
    selection?: RecordingBrowserSelection,
  ): Promise<void> {
    if (this.active) throw new Error("A semantic capture channel is already active.");
    if (selection?.provider === "ziniao") {
      await this.ziniao.startSession(sessionId, sessionDir, startedAt, selection);
      this.active = { sessionId, provider: "ziniao" };
      return;
    }
    await this.standard.startSession(
      sessionId,
      sessionDir,
      startedAt,
      selection?.provider,
    );
    this.active = { sessionId, provider: "standard" };
  }

  async stopSession(sessionId: string): Promise<BrowserCaptureSummary> {
    const active = this.active;
    if (!active || active.sessionId !== sessionId)
      throw new Error("That semantic capture session is not active.");
    this.active = null;
    return active.provider === "ziniao"
      ? this.ziniao.stopSession(sessionId)
      : this.standard.stopSession(sessionId);
  }

  async dispose(): Promise<void> {
    await this.ziniao.dispose();
    await this.standard.dispose();
    this.active = null;
  }
}
