export {
  SELF_CHECK_FIXTURES,
  evaluateFixture,
  summarizeSelfCheck,
  type FixtureExpectation,
  type FixtureObservation,
  type FixtureVerdict,
  type SelfCheckFixture,
} from "./fixtures";
export {
  runSelfCheck,
  defaultResidueProbe,
  type HostResidueProbe,
  type SelfCheckResult,
  type SelfCheckRunnerOptions,
} from "./runner";
export {
  C_RUNTIME,
  compileProgram,
  runProgram,
  nativeRunLimits,
  type NativeRunOptions,
  type NativeRunResult,
} from "./exec";
