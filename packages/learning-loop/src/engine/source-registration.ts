// Root defineSourceRegistration. The ports-layer registration
// (ports/evidence.ts) deliberately exposes no adapter reference on the
// branded capability, but the engine must stream the adapter's pages during
// ingest. This wrapper is the sanctioned pairing point: it binds the host
// grant via the ports helper and retains the adapter in a module-private
// WeakMap the engine reads. Nothing outside the engine can enumerate or
// replace an adapter through this table.
import { defineSourceRegistration as bindPortsRegistration } from "../ports/evidence.js";
import type { EvidenceSource, RegisteredSource } from "../ports/evidence.js";
import type { TrustClass } from "../records/provenance.js";

const adapters = new WeakMap<RegisteredSource<unknown>, EvidenceSource<unknown>>();

/**
 * Binds an evidence-source adapter to its host-granted trust ceiling and
 * content policy (contract §Evidence source). The registry revision digests
 * the source id, adapter version, trust ceiling, and content policy id; the
 * returned capability preserves its input type so one source's input cannot
 * be fed to another registration.
 */
export function defineSourceRegistration<I>(input: {
  readonly source: EvidenceSource<I>;
  readonly trustCeiling: TrustClass;
  readonly contentPolicyId: string;
}): RegisteredSource<I> {
  const registered = bindPortsRegistration(input);
  adapters.set(registered, input.source);
  return registered;
}

/** Engine-internal: the adapter paired with a registration, if this process minted it. */
export function adapterFor(source: RegisteredSource<unknown>): EvidenceSource<unknown> | undefined {
  return adapters.get(source);
}
