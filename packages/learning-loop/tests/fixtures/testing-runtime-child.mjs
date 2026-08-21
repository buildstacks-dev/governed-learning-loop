// This process deliberately has no Vitest imports or module stubs. The parent
// test also removes every VITEST_* environment variable before launching it.
import assert from "node:assert/strict";
import {
  createFixedClock,
  createInMemoryDestination,
  createInMemoryStore,
  createSequentialIds,
  runLearningStoreConformance,
  runPublicationDestinationConformance,
} from "@cormidia/learning-loop/testing";

assert.deepEqual(
  Object.keys(process.env).filter((name) => name.startsWith("VITEST")),
  [],
);

const suiteNames = [];
const testNames = [];
runLearningStoreConformance(() => createInMemoryStore(), {
  describe(name, suite) {
    suiteNames.push(name);
    suite();
  },
  it(name, test) {
    assert.equal(typeof test, "function");
    testNames.push(name);
  },
  expect() {
    throw new Error("registration must not execute a conformance test body");
  },
});

const destinationTestNames = [];
runPublicationDestinationConformance(() => createInMemoryDestination(), {
  describe(name, suite) {
    suiteNames.push(name);
    suite();
  },
  it(name, test) {
    assert.equal(typeof test, "function");
    destinationTestNames.push(name);
  },
  expect() {
    throw new Error("registration must not execute a conformance test body");
  },
});

const destination = createInMemoryDestination({ id: "standalone-destination" });
assert.equal(destination.read("standalone-destination/procedure").currentVersion, "v0");

const store = createInMemoryStore();
const created = await store.create(
  { namespace: "standalone", kind: "observation", id: "one" },
  { usable: true },
  "digest-one",
  "operation-one",
);
assert.deepEqual(created, { status: "created", revision: "1" });

const clock = createFixedClock("2026-08-20T00:00:00.000Z");
const firstTime = clock.now();
clock.tick(250);
const secondTime = clock.now();

const ids = createSequentialIds("standalone");
process.stdout.write(
  JSON.stringify({
    suiteNames,
    registeredTestCount: testNames.length,
    firstRegisteredTest: testNames[0],
    destinationTestCount: destinationTestNames.length,
    firstTime,
    secondTime,
    ids: [ids.next("record"), ids.next("record")],
  }),
);
