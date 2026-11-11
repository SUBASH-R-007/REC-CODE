import type { JudgeJobSpec } from "@recx/shared";
import type { DriverInfo, JudgeDriver, JudgeIO, JudgeOutcome } from "./types";

/**
 * Planned local-Linux development driver: the shared judging logic on a
 * Docker-backed Sandbox. It would NOT be timing-accurate (no cgroup CPU
 * accounting per run, container start-up in every measurement) and would be
 * slow, so it could never judge a real submission.
 *
 * It is not available in Phase 1 — Docker does not run on the development
 * machine, so it could not be verified. Selecting it fails at start-up
 * instead of judging with an untested sandbox. Use RECX_DRIVER=isolate
 * (Linux / WSL2) or RECX_DRIVER=mock (Windows UI work).
 */
export class DockerDriver implements JudgeDriver {
  readonly name = "docker" as const;

  constructor() {
    throw new Error(
      "DockerDriver is not available in Phase 1. Use RECX_DRIVER=isolate on Linux/WSL2, or RECX_DRIVER=mock for Windows UI development.",
    );
  }

  async info(): Promise<DriverInfo> {
    throw new Error("DockerDriver is not available in Phase 1.");
  }

  async judge(_spec: JudgeJobSpec, _io: JudgeIO): Promise<JudgeOutcome> {
    throw new Error("DockerDriver is not available in Phase 1.");
  }
}
