import { CompileCache, defaultCompileCacheDir } from "../compile-cache";
import type { WorkerConfig } from "../config";
import type { Logger } from "../logger";
import { DockerDriver } from "./docker";
import { IsolateDriver } from "./isolate";
import { MockJudgeDriver } from "./mock";
import type { JudgeDriver } from "./types";

export type { BlobSource, DriverInfo, DriverName, JudgeDriver, JudgeIO, JudgeOutcome, SubtaskOutcome } from "./types";

export async function createDriver(config: WorkerConfig, logger: Logger): Promise<JudgeDriver> {
  switch (config.RECX_DRIVER) {
    case "isolate": {
      // Compile artefacts live next to the blob cache (LIMITS.compileCache: 1 h, 5 GB).
      const compileCache = new CompileCache({ dir: defaultCompileCacheDir(config.RECX_CACHE_DIR), logger });
      const driver = await IsolateDriver.create({
        isolateBin: config.RECX_ISOLATE_BIN,
        boxBase: config.RECX_BOX_BASE,
        syntheticEtc: config.RECX_SYNTHETIC_ETC,
        logger,
        compileCache,
      });
      logger.info(
        { dir: compileCache.dir, enabled: compileCache.enabled, entries: compileCache.count, bytes: compileCache.sizeBytes },
        "compile cache ready",
      );
      return driver;
    }
    case "docker":
      return new DockerDriver();
    case "mock":
      logger.warn("RECX_DRIVER=mock: NO CODE IS EXECUTED and every verdict is fabricated (development only)");
      return new MockJudgeDriver();
  }
}
