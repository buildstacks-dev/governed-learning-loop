# @cormidia/learning-loop

> **Work in progress:** this package is pre-1.0. Its public contract is
> versioned, but breaking changes may still ship in minor releases. It does
> not claim that an intervention improves an agent unless an independently
> declared experiment produces that evidence.

`@cormidia/learning-loop` is a provider-neutral governed adaptation kernel for
TypeScript agent products. It records provenance-bearing evidence, keeps
proposals inert until independent review and exact authorization, journals
publication and reversal effects, and keeps authorization separate from
measured validation.

## Install

```bash
npm install @cormidia/learning-loop
```

Node.js 22.18 or newer is required. The package is ESM-only and has no runtime
dependencies or model-provider SDKs.

## Entrypoints

| Import | Purpose |
| --- | --- |
| `@cormidia/learning-loop` | Domain records, unknown-first parsers, policies, ports, and the learning-loop façade |
| `@cormidia/learning-loop/node` | Local JSON Lines filesystem store |
| `@cormidia/learning-loop/testing` | Runtime-safe in-memory adapters, fixtures, and injected conformance suites |
| `@cormidia/learning-loop/reference-detectors` | Opt-in structural reference detector bundle |
| `@cormidia/learning-loop/workflows` | Provider-neutral semantic generation and advisory-review workflow capability |

Deep imports are unsupported.

## Minimal setup

```ts
import {
  conservativePolicy,
  createLearningLoop,
} from "@cormidia/learning-loop";
import {
  createExactScopePolicy,
  createInMemoryStore,
  createTestIdentityPort,
} from "@cormidia/learning-loop/testing";

const learning = createLearningLoop({
  store: createInMemoryStore(),
  policy: conservativePolicy(),
  identity: createTestIdentityPort(),
  scopePolicy: createExactScopePolicy(),
  contentPolicies: [],
  sources: [],
});

console.log(typeof learning.propose);
```

Real hosts compose their own source registrations, content and scope policies,
identity port, durable store, publication destinations, and—when needed—an
authority port or replay executor. Importing a package entrypoint grants none
of those capabilities.

## Versioning and migrations

During 0.x, breaking public-surface changes increment the minor version. Pin an
exact version when stability matters. The public export snapshot and decision
records document surface changes; there is no automatic migration of legacy
Candidate records or other content-bound history.

## Limitations

- Candidates and generated output are inert; the package never turns model
  output into authority.
- Authorized and validated are separate states. Neither implies the other.
- Reference detectors are structural examples, not calibrated claims of harm,
  quality, utility, or efficacy.
- Hosts remain responsible for identity, policy, durable storage, provider
  execution, approvals, destination effects, and operational controls.

## Contract and source

The ratified API contract is maintained as
`docs/contract/api-contract.md` in the
[source repository](https://github.com/cormidia/governed-learning-loop), and
the exported-symbol budget is recorded in `docs/public-api.txt`. Published
tarballs contain both compiled `dist/` output and the corresponding TypeScript
`src/`, excluding tests, fixtures, documentation, environment files, and
source maps.

The public project landing page is
[cormidia/cormidia-web](https://github.com/cormidia/cormidia-web).

## Security

Report vulnerabilities privately to
[security@cormidia.dev](mailto:security@cormidia.dev). Do not open a public
issue for an unfixed vulnerability. The current supported-version policy is
documented in the source repository's `SECURITY.md`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
