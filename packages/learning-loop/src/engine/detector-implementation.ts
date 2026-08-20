// Non-forgeable runtime pairing between an immutable detector registration
// and one synchronous deterministic implementation callback.
import { invalid } from "../parse/toolkit.js";
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { DetectorRegistration } from "../records/detector-registration.js";
import { parseDetectorRegistration } from "../records/detector-registration.js";
import { registeredDetectorImplementationBrand } from "../records/brands.js";
import type { DetectorWindow } from "./detector-window.js";

export interface RegisteredDetectorImplementation {
  readonly detector: {
    readonly id: string;
    readonly version: string;
    readonly registrationDigest: string;
  };
  readonly implementationDigest: string;
  readonly registrationDigest: string;
  readonly [registeredDetectorImplementationBrand]: true;
}

interface ImplementationBinding {
  readonly registration: DetectorRegistration;
  readonly evaluate: (window: DetectorWindow) => unknown;
  readonly token: object;
}

const bindings = new WeakMap<RegisteredDetectorImplementation, ImplementationBinding>();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return "then" in value && typeof value.then === "function";
}

export function defineDetectorImplementation(input: {
  readonly registration: DetectorRegistration;
  readonly evaluate: (window: DetectorWindow) => unknown;
}): RegisteredDetectorImplementation {
  const registration = deepFreeze(parseDetectorRegistration(input.registration));
  if (registration.maturity === "deprecated") {
    throw invalid("detector.implementation_invalid", "deprecated detector cannot have a callable implementation", [
      "registration",
    ]);
  }
  const evaluate = input.evaluate;
  if (typeof evaluate !== "function") {
    throw invalid("detector.implementation_invalid", "detector implementation requires a synchronous callback", [
      "evaluate",
    ]);
  }
  const binding: ImplementationBinding = Object.freeze({
    registration,
    evaluate,
    token: Object.freeze({}),
  });
  const rawCapability: RegisteredDetectorImplementation = {
    detector: Object.freeze({
      id: registration.id,
      version: registration.version,
      registrationDigest: registration.registrationDigest,
    }),
    implementationDigest: registration.implementationDigest,
    registrationDigest: sha256HexOfCanonicalJson({
      detector: {
        id: registration.id,
        version: registration.version,
        registrationDigest: registration.registrationDigest,
      },
      implementationDigest: registration.implementationDigest,
    }),
    [registeredDetectorImplementationBrand]: true,
  };
  const capability = Object.freeze(rawCapability);
  bindings.set(capability, binding);
  return capability;
}

export function detectorImplementationRegistration(capability: RegisteredDetectorImplementation): DetectorRegistration {
  const binding = bindings.get(capability);
  if (binding === undefined) {
    throw invalid("config.invalid", "detector implementation was not created by defineDetectorImplementation", [
      "detectorImplementations",
    ]);
  }
  return binding.registration;
}

export function evaluateDetectorImplementation(
  capability: RegisteredDetectorImplementation,
  window: DetectorWindow,
): unknown {
  const binding = bindings.get(capability);
  if (binding === undefined) {
    throw invalid("detector.implementation_invalid", "detector implementation capability is not bound", []);
  }
  const result = binding.evaluate.call(capability, window);
  if (isThenable(result)) {
    throw invalid("detector.implementation_invalid", "detector implementation returned an asynchronous result", []);
  }
  return result;
}
