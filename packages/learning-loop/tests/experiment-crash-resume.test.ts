// Crash-resume conformance for the Validate journal (decision 0028): a crash
// before or after EVERY write — the definition, each attempt's dispatch and
// its terminal compare-and-set, the intervention evaluation index, the
// evaluation record, and the validate transition — leaves a state a
// reconstructed host forward-completes without ever re-executing a slot the
// journal already dispatched. A dispatched slot whose result never landed is
// `outcome_unknown` and the evaluation is honestly invalid; every other
// crash converges on the byte-exact evaluation of a clean run.
import { describe, expect, it } from "vitest";
import type { EvaluationResult } from "../src/index.js";
import { createInMemoryReplayExecutor, createInMemoryStore } from "../src/testing/index.js";
import { createExperimentHarness, gradeByArm, type ExperimentHarness } from "./experiment-harness.js";
import { faultStore, type StoreFault } from "./publication-harness.js";

const CONTROL = { completion_typecheck_pass: false, acceptance_tests: true, cost: 2 };
const TREATMENT = { completion_typecheck_pass: true, acceptance_tests: true, cost: 3 };

const VALIDATE_KINDS = [
  "experiment-definition",
  "experiment-attempt",
  "experiment-evaluation",
  "intervention-evaluation",
  "intervention-transition",
] as const;

async function validateSnapshot(harness: ExperimentHarness): Promise<string> {
  const listing: string[] = [];
  for (const kind of VALIDATE_KINDS) {
    const page = await harness.store.list({ namespace: "learning", kind, limit: 10_000 });
    // Attempt records bind the nonce of their own dispatch, so a resumed run's
    // fresh dispatches differ in bytes by design; they are compared by slot.
    for (const record of page.records) {
      listing.push(
        JSON.stringify(kind === "experiment-attempt" ? [kind, record.key.id] : [kind, record.key.id, record.digest]),
      );
    }
  }
  return JSON.stringify(listing.sort());
}

interface CleanRun {
  readonly evaluation: EvaluationResult;
  readonly snapshot: string;
}

async function cleanRun(): Promise<CleanRun> {
  const harness = await createExperimentHarness({ grade: gradeByArm(CONTROL, TREATMENT) });
  await harness.declare();
  const evaluation = await harness.run();
  return { evaluation, snapshot: await validateSnapshot(harness) };
}

const RUN_FAULTS: readonly (StoreFault & {
  readonly expect: "improved" | "invalid";
  /** Executor calls across the crashed and the rebuilt host together. */
  readonly calls: number;
})[] = [
  // Crash before the first dispatch record: nothing ran; the rebuilt host runs the full design.
  { operation: "create", kind: "experiment-attempt", occurrence: 1, when: "before", expect: "improved", calls: 6 },
  // Crash after the dispatch record but before the executor ran: the slot is unknown and is never re-executed.
  { operation: "create", kind: "experiment-attempt", occurrence: 1, when: "after", expect: "invalid", calls: 0 },
  // Crash after the executor ran but before its result landed: unknown, never re-executed.
  {
    operation: "compareAndSet",
    kind: "experiment-attempt",
    occurrence: 1,
    when: "before",
    expect: "invalid",
    calls: 1,
  },
  // Crash after the result landed: the rebuilt host continues from slot 2.
  {
    operation: "compareAndSet",
    kind: "experiment-attempt",
    occurrence: 1,
    when: "after",
    expect: "improved",
    calls: 6,
  },
  { operation: "create", kind: "experiment-attempt", occurrence: 4, when: "before", expect: "improved", calls: 6 },
  {
    operation: "compareAndSet",
    kind: "experiment-attempt",
    occurrence: 4,
    when: "after",
    expect: "improved",
    calls: 6,
  },
  { operation: "append", kind: "intervention-evaluation", when: "before", expect: "improved", calls: 6 },
  { operation: "append", kind: "intervention-evaluation", when: "after", expect: "improved", calls: 6 },
  { operation: "create", kind: "experiment-evaluation", when: "before", expect: "improved", calls: 6 },
  { operation: "create", kind: "experiment-evaluation", when: "after", expect: "improved", calls: 6 },
  { operation: "append", kind: "intervention-transition", when: "before", expect: "improved", calls: 6 },
  { operation: "append", kind: "intervention-transition", when: "after", expect: "improved", calls: 6 },
];

function label(fault: StoreFault): string {
  return `${fault.when} ${fault.operation} ${fault.kind}${fault.occurrence === undefined ? "" : ` #${fault.occurrence}`}`;
}

describe("crash-resume: runExperiment", () => {
  for (const fault of RUN_FAULTS) {
    it(`recovers from a crash ${label(fault)}`, async () => {
      const clean = await cleanRun();
      const base = createInMemoryStore();
      const faulted = faultStore(base, fault, { armed: false });
      const replay = createInMemoryReplayExecutor({ grade: gradeByArm(CONTROL, TREATMENT) });
      const crashed = await createExperimentHarness({ store: faulted.store, replay });
      await crashed.declare();
      faulted.arm();
      await expect(crashed.run()).rejects.toThrow(/injected crash/);
      expect(faulted.fired()).toBe(true);

      const rebuilt = await createExperimentHarness({ store: base, replay, rebuild: crashed });
      const evaluation = await rebuilt.run();
      expect(evaluation.verdict).toBe(fault.expect);
      expect(replay.calls.attempt).toBe(fault.calls);
      const intervention = await rebuilt.learning.getIntervention({ interventionId: crashed.intervention.id });
      expect(intervention?.state.validation).toBe(fault.expect);
      expect(intervention?.evaluationIds).toEqual([evaluation.id]);
      if (fault.expect === "improved") {
        expect(evaluation).toEqual(clean.evaluation);
        expect(await validateSnapshot(rebuilt)).toBe(clean.snapshot);
      } else {
        expect(evaluation.classifications[0]?.status).toBe("outcome_unknown");
        expect(evaluation.classifications.slice(1).every((classification) => classification.status === "not_run")).toBe(
          true,
        );
        expect(evaluation.diagnostics[0]?.code).toBe("experiment.missing_arm");
      }
      // Once concluded, a rerun is a pure read.
      const snapshot = await validateSnapshot(rebuilt);
      expect(await rebuilt.run()).toEqual(evaluation);
      expect(await validateSnapshot(rebuilt)).toBe(snapshot);
      expect(replay.calls.attempt).toBe(fault.calls);
    });
  }

  it("a crash around the declaration converges on the same definition", async () => {
    for (const when of ["before", "after"] as const) {
      const base = createInMemoryStore();
      const faulted = faultStore(base, { operation: "create", kind: "experiment-definition", when }, { armed: false });
      const replay = createInMemoryReplayExecutor({ grade: gradeByArm(CONTROL, TREATMENT) });
      const crashed = await createExperimentHarness({ store: faulted.store, replay });
      faulted.arm();
      await expect(crashed.declare()).rejects.toThrow(/injected crash/);
      const rebuilt = await createExperimentHarness({ store: base, replay, rebuild: crashed });
      const definition = await rebuilt.declare();
      expect(definition.definitionDigest).toBe((await crashed.declare()).definitionDigest);
      expect((await rebuilt.run()).verdict).toBe("improved");
    }
  });

  it("a concurrent second runner converges on one evaluation and never re-executes a dispatched slot", async () => {
    const replay = createInMemoryReplayExecutor({ grade: gradeByArm(CONTROL, TREATMENT) });
    const harness = await createExperimentHarness({ replay });
    await harness.declare();
    const other = await createExperimentHarness({ store: harness.store, replay, rebuild: harness });
    const [first, second] = await Promise.all([harness.run(), other.run()]);
    expect(second).toEqual(first);
    // Hosts must serialize runners per experiment: the second runner finds the
    // first runner's dispatched slot, cannot know whether its executor ran,
    // classifies it outcome_unknown, and its honestly invalid evaluation is
    // the one persisted first. The first runner converges on it and never
    // re-executes the slot; re-evaluation is a new declaration.
    expect(first.verdict).toBe("invalid");
    expect(first.classifications[0]?.status).toBe("outcome_unknown");
    expect(replay.calls.attempt).toBe(1);
    const intervention = await harness.learning.getIntervention({ interventionId: harness.intervention.id });
    expect(intervention?.evaluationIds).toEqual([first.id]);
    expect(intervention?.state.validation).toBe("invalid");
  });
});
