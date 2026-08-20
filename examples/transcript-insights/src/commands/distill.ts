// `distill` — deterministic heuristics ONLY. No model call happens anywhere
// in this app. A cluster of recurring friction proposes ONE inert candidate;
// problem/hypothesis text is templated from aggregate numbers only — never
// from transcript text. Cross-run dedup comes free from the kernel's
// content-digest dedup: identical aggregates re-propose into the existing
// candidate instead of creating a twin.
import type { CandidateInput, Scope } from "@cormidia/learning-loop";
import { sha256HexOfCanonicalJson, toJsonValue } from "@cormidia/learning-loop";
import type { DemoLoop } from "../compose.js";
import type { FoldListProgress, SignalCluster, StoreFold } from "../fold.js";
import { foldStore } from "../fold.js";
import type { CliOutput } from "../output.js";

// A cluster is worth proposing when the signal recurred: at least MIN_EVENTS
// events spread over at least MIN_EPISODES distinct episodes.
const MIN_EVENTS = 3;
const MIN_EPISODES = 2;
const MAX_EVIDENCE_IDS = 20;

interface FrictionCluster {
  readonly provider: string;
  readonly project: string;
  readonly label: string;
  readonly problem: string;
  readonly hypothesis: string;
  readonly evidenceIds: readonly string[];
}

function evidenceOf(cluster: SignalCluster): readonly string[] {
  return [...cluster.observationIds].sort().slice(0, MAX_EVIDENCE_IDS);
}

function qualifies(cluster: SignalCluster): boolean {
  return cluster.count >= MIN_EVENTS && cluster.episodeIds.size >= MIN_EPISODES;
}

function deriveClusters(fold: StoreFold): readonly FrictionCluster[] {
  const clusters: FrictionCluster[] = [];
  for (const project of fold.projects.values()) {
    const where = `in project "${project.project}" (provider ${project.provider})`;
    for (const [toolName, failures] of [...project.toolFailures.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!qualifies(failures)) continue;
      clusters.push({
        provider: project.provider,
        project: project.project,
        label: `tool-failure:${toolName}`,
        problem:
          `Tool "${toolName}" recorded ${failures.count} failure(s) across ` +
          `${failures.episodeIds.size} distinct session(s) ${where}.`,
        hypothesis:
          `The recurring "${toolName}" failures point at a standing setup or usage friction in this project; ` +
          "a host-owned note about it may cut repeat failures. Advisory transcript evidence shows recurrence only.",
        evidenceIds: evidenceOf(failures),
      });
    }
    if (qualifies(project.corrections)) {
      clusters.push({
        provider: project.provider,
        project: project.project,
        label: "correction-signal",
        problem:
          `${project.corrections.count} human correction-signal message(s) across ` +
          `${project.corrections.episodeIds.size} distinct session(s) ${where}.`,
        hypothesis:
          "Recurring human corrections point at instructions or defaults that repeatedly miss intent in this " +
          "project; a host-owned note may lower repeat corrections. Advisory transcript evidence shows recurrence only.",
        evidenceIds: evidenceOf(project.corrections),
      });
    }
  }
  return clusters;
}

function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug.length === 0 ? "x" : slug).slice(0, 40);
}

function progressLine(progress: FoldListProgress): string {
  const waiting = progress.heartbeat ? " waiting-for-page" : "";
  return (
    `distill: listing ${progress.kind} records=${progress.records} pages=${progress.pages}` +
    ` elapsed=${progress.elapsedSeconds}s${waiting}`
  );
}

export async function runDistillCommand(loop: DemoLoop, out: CliOutput): Promise<number> {
  const fold = await foldStore(loop.learning, (progress) => out.write(progressLine(progress)));
  const clusters = deriveClusters(fold);
  out.write(
    `distill: fold complete projects=${fold.projects.size}; ${clusters.length} qualifying cluster(s)` +
      ` (>=${MIN_EVENTS} events over >=${MIN_EPISODES} episodes)`,
  );
  let created = 0;
  let known = 0;
  for (const cluster of clusters) {
    const scope: Scope = [
      { type: "provider", id: cluster.provider },
      { type: "project", id: cluster.project },
    ];
    const proposalContent = {
      scope,
      problem: cluster.problem,
      hypothesis: cluster.hypothesis,
      evidenceIds: cluster.evidenceIds,
      intervention: {
        destinationId: "demo/report-only",
        kind: "report-note",
        content: { text: `Recurring friction cluster ${cluster.label}: ${cluster.problem}` },
        rollbackIntent: "discard candidate",
      },
      proposedRisk: "T1" as const,
    };
    // This request fingerprint only makes a stable display id. The kernel
    // resolves exact EvidenceRefs and computes the authoritative Candidate v2
    // content digest; evolving aggregates mint a new display id, while the
    // kernel's digest index remains the deduplication authority.
    const requestDigest = sha256HexOfCanonicalJson(toJsonValue(proposalContent));
    const input: CandidateInput = {
      id: `ti-${slugOf(cluster.label)}-${slugOf(cluster.project)}-${requestDigest.slice(0, 12)}`,
      ...proposalContent,
      proposedBy: loop.distiller,
    };
    const outcome = await loop.learning.propose(input);
    const duplicate = outcome.governance.reasons.some((reason) => reason.code === "candidate.duplicate_content");
    if (duplicate) known += 1;
    else created += 1;
    out.write(
      `candidate ${outcome.candidate.id} (${cluster.provider}/${cluster.project} ${cluster.label}) — ` +
        `${duplicate ? "already known" : "new"}`,
    );
  }
  out.write(`distill done: ${created} new candidate(s), ${known} already known`);
  out.write("candidates are inert and advisory; review them with the review command");
  return 0;
}
