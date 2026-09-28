# ADR-067: Whole-monorepo architecture capture

> Lifecycle: Active
> Supersedes: [ADR-063](ADR-063-architecture-review-history-and-agent-worktrees.md) | partial | The small-repository read budgets and default subsystem mapping across workspace packages; capture and classification use the expanded shared budgets and package boundaries refine default subsystems.
> Supersedes: [ADR-066](ADR-066-scans-reuse-blobs-by-object-id-and-analyses-by-fingerprint.md) | partial | The 32 MiB blob-cache budget; the cache remains twice the expanded capture byte budget.

## Context

A monorepo review needs relationships across packages and services on both sides of a
change. Requiring a narrower scope to fit a small scan budget hides the dependencies the
review is intended to explain. Treating every package as one subsystem also removes
cross-package edges from the subsystem graph.

## Decision

Whole-repository capture supports 32,000 source and configuration files, 256 MiB per
snapshot end and 8 MiB per file. Classification uses the same read budgets. The existing
per-request commit and pair-scan limits remain. These are resource limits, not sampling
rules: capture refuses a scope it cannot read completely. Analysis retains up to 500,000
import facts and fails explicitly above that limit instead of returning a partial graph.
The subsystem map does not discard nodes or relationships at fixed display counts.

Symbolic links and submodule entries are disclosed exclusions. They are not followed or
parsed as source. Regular files at their targets remain independently eligible. Live
capture rejects symbolic-link parent directories and retains its read-time boundary
checks. All capture IO continues through ProjectHost.

Captured package manifests provide a virtual node_modules tree to the existing TypeScript
resolver. Package exports and entry points are interpreted by TypeScript against captured
files only. No installation, checkout or host filesystem lookup is required. Unresolved
workspace imports stay unresolved in the evidence.

Kotlin joins the grammar scanners through web-tree-sitter. Package declarations, top-level
symbols and explicit imports supply source relationships. Kotlin classification requires
facts from the complete snapshot. Gradle Kotlin build-file directories identify project
systems; inferred workspace and project roots refine default subsystem boundaries.
Explicit subsystem mappings remain authoritative.

## Consequences

Repository-wide snapshots consume more memory and parsing time. Work remains in utility
processes, and caches remain bounded: the blob cache is twice the capture byte budget;
the analysis and parse cache policies are unchanged.

This is a static source-import graph. It does not prove runtime impact, service calls,
reflection, generated dependencies or build-classpath compatibility. Unsupported languages
remain disclosed exclusions. Kotlin package wildcard imports identify candidate source
files, not symbol-use analysis.

## Rejected alternatives

- Narrowing the repository to make a scan fit: removes cross-boundary impact context.
- Returning the first files or imports that fit: presents incomplete evidence as a graph.
- Following links or entering submodules: crosses snapshot and repository boundaries.
- Running installed builds to resolve packages: depends on mutable host state and executes
  repository code during a read-only review.
