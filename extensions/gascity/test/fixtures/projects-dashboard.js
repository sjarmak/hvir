window.projectsFixture = {
  "now": "2026-10-29T12:00:00Z",
  "projects": [
    {"id": "fx-project-1", "title": "Lantern catalog", "status": "open", "labels": ["city-project"], "metadata": {"proj.lead": "omni-pl", "proj.state": "moving", "proj.now": "Building the first searchable collection.", "proj.stuck_why": "", "proj.next_milestone": "fx-ms-1", "proj.updated_at": "2026-10-29T10:00Z", "ref.prs": "fixture-lab/lantern#12", "ref.issues": "fixture-lab/lantern#24,bad reference"}},
    {"id": "fx-project-2", "title": "Harbor replay", "status": "open", "labels": ["city-project"], "metadata": {"proj.lead": "omni-evals-pl", "proj.state": "stuck", "proj.now": "Replay coverage is waiting on a sample bundle.", "proj.stuck_why": "The synthetic sample bundle has not arrived.", "proj.next_milestone": "fx-ms-2", "proj.updated_at": "2026-10-29T10:00Z"}},
    {"id": "fx-project-3", "title": "Shared signal board", "status": "open", "labels": ["city-project"], "metadata": {"proj.lead": "city-infra-pl", "proj.state": "needs-you", "proj.now": "The shared board is ready for a retention choice.", "proj.stuck_why": "Choose how long to retain the fake traces.", "proj.next_milestone": "fx-ms-3", "proj.updated_at": "2026-10-29T10:00Z", "proj.contributors": "omni-pl,omni-evals-pl"}},
    {"id": "fx-project-4", "title": "Orchard queue", "status": "open", "labels": ["city-project"], "metadata": {"proj.lead": "omni-pl", "proj.state": "paused", "proj.now": "Paused until the next planning window.", "proj.stuck_why": "", "proj.next_milestone": "fx-ms-4", "proj.updated_at": "2026-10-27T09:00Z"}},
    {"id": "fx-project-5", "title": "Compass handoff", "status": "open", "labels": ["city-project"], "metadata": {"proj.lead": "omni-evals-pl", "proj.state": "done", "proj.now": "", "proj.stuck_why": "", "proj.next_milestone": "fx-ms-5", "proj.updated_at": "2026-10-01T09:00Z"}},
    {"id": "fx-project-6", "title": "Bridge sampler", "status": "open", "labels": ["city-project"], "metadata": {"proj.lead": "city-infra-pl", "proj.state": "moving", "proj.now": "Checking a small batch of synthetic routes.", "proj.stuck_why": "", "proj.next_milestone": "fx-ms-6", "proj.updated_at": "2026-10-29T10:00Z"}}
  ],
  "milestones": [
    {"id": "fx-ms-1", "title": "Searchable catalog", "status": "open", "labels": ["city-milestone"], "metadata": {"ms.state": "active", "ms.target": "2026-11-02", "ms.outcome": "", "ref.prs": "fixture-lab/lantern#12"}, "parent": "fx-project-1"},
    {"id": "fx-ms-2", "title": "Replay sample coverage", "status": "open", "labels": ["city-milestone"], "metadata": {"ms.state": "planned", "ms.target": "2026-11-03", "ms.outcome": ""}, "parent": "fx-project-2"},
    {"id": "fx-ms-3", "title": "Retention choice applied", "status": "open", "labels": ["city-milestone"], "metadata": {"ms.state": "planned", "ms.target": "2026-11-04", "ms.outcome": ""}, "parent": "fx-project-3"},
    {"id": "fx-ms-4", "title": "Queue trial", "status": "open", "labels": ["city-milestone"], "metadata": {"ms.state": "planned", "ms.target": "2026-11-10", "ms.outcome": ""}, "parent": "fx-project-4"},
    {"id": "fx-ms-5", "title": "Handoff delivered", "status": "open", "labels": ["city-milestone"], "metadata": {"ms.state": "done", "ms.target": "2026-10-20", "ms.outcome": "A synthetic baseline was delivered."}, "parent": "fx-project-5"},
    {"id": "fx-ms-6", "title": "Sampler report", "status": "open", "labels": ["city-milestone"], "metadata": {"ms.state": "active", "ms.target": "2026-11-05", "ms.outcome": ""}, "parent": "fx-project-6"},
    {"id": "fx-ms-7", "title": "Catalog baseline", "status": "open", "labels": ["city-milestone"], "metadata": {"ms.state": "done", "ms.target": "2026-10-28", "ms.outcome": "A synthetic baseline was delivered."}, "parent": "fx-project-1"},
    {"id": "fx-ms-8", "title": "Old catalog import", "status": "open", "labels": ["city-milestone"], "metadata": {"ms.state": "dropped", "ms.target": "2026-10-30", "ms.outcome": ""}, "parent": "fx-project-1"}
  ],
  "decisions": [
    {"id": "fx-ask-retention", "title": "Choose a trace retention window", "status": "open", "labels": ["needs/stephanie"], "metadata": {"gc.project": "fx-project-3", "ref.issues": "fixture-lab/signals#8"}},
    {"id": "fx-ask-answered", "title": "Pick a catalog accent", "status": "open", "labels": ["needs/stephanie"], "metadata": {"gc.project": "fx-project-1", "gc.answered": "2026-10-29T09:00Z"}},
    {"id": "fx-ask-unlinked", "title": "Choose a city demo time", "status": "open", "labels": ["needs/stephanie"], "metadata": {}}
  ],
  "sessions": [
    {"id": "fx-session-lead", "name": "omni-pl", "agent_name": "omni-pl", "provider": "codex", "command": "codex --model gpt-fixture", "started_at": "2026-10-29T09:00Z"},
    {"id": "fx-session-pool-a", "name": "fx-worker-a", "agent_name": "fx-pool", "provider": "codex", "command": "codex --model gpt-fixture-small", "started_at": "2026-10-29T11:00Z"},
    {"id": "fx-session-pool-b", "name": "fx-worker-b", "agent_name": "fx-pool", "provider": "claude", "command": "claude", "started_at": "2026-10-29T10:30Z"},
    {"id": "fx-session-unlinked", "name": "fx-unlinked", "agent_name": "fx-observer", "provider": "codex", "command": "codex", "started_at": "2026-10-29T11:30Z"}
  ],
  "inProgress": [
    {"id": "fx-lead-work", "title": "Shape the catalog launch", "status": "in_progress", "labels": [], "metadata": {"proj.id": "fx-project-1"}, "assignee": "omni-pl"},
    {"id": "fx-step-catalog", "title": "Build catalog search", "status": "in_progress", "labels": [], "metadata": {"gc.root_bead_id": "fx-root-catalog", "gc.step_id": "implement"}, "assignee": "fx-session-pool-a"},
    {"id": "fx-step-replay", "title": "Build the replay adapter", "status": "in_progress", "labels": [], "metadata": {"gc.root_bead_id": "fx-root-replay", "gc.step_id": "implement"}, "assignee": "fx-session-pool-b", "parent": "fx-parent"},
    {"id": "fx-seat-work", "title": "Check retention choices", "status": "in_progress", "labels": [], "metadata": {"proj.id": "fx-project-3"}},
    {"id": "fx-parent", "title": "Replay work package", "status": "open", "labels": [], "metadata": {}, "parent": "fx-project-2"}
  ],
  "workflowRoots": [
    {"id": "fx-root-catalog", "title": "Catalog workflow", "status": "open", "labels": [], "metadata": {"gc.kind": "workflow", "gc.formula_name": "mol-scoped-work", "proj.id": "fx-project-1"}},
    {"id": "fx-root-replay", "title": "Replay workflow", "status": "open", "labels": [], "metadata": {"gc.kind": "workflow", "gc.formula_name": "mol-scoped-work"}, "parent": "fx-parent"}
  ],
  "workflowSteps": [
    {"id": "fx-step-catalog", "title": "Build catalog search", "status": "in_progress", "labels": [], "metadata": {"gc.root_bead_id": "fx-root-catalog", "gc.step_id": "implement"}, "assignee": "fx-session-pool-a"},
    {"id": "fx-step-replay", "title": "Build the replay adapter", "status": "in_progress", "labels": [], "metadata": {"gc.root_bead_id": "fx-root-replay", "gc.step_id": "implement"}, "assignee": "fx-session-pool-b", "parent": "fx-parent"},
    {"id": "fx-step-catalog-plan", "title": "Plan the synthetic work", "status": "closed", "labels": [], "metadata": {"gc.root_bead_id": "fx-root-catalog", "gc.step_id": "plan"}},
    {"id": "fx-step-replay-plan", "title": "Plan the synthetic work", "status": "closed", "labels": [], "metadata": {"gc.root_bead_id": "fx-root-replay", "gc.step_id": "plan"}}
  ],
  "seatJobs": [
    {"seat": "city-infra-pl", "label": "fx-retention", "alive": true, "job": {"seat": "city-infra-pl", "label": "fx-retention", "bead": "fx-seat-work", "started_at": "2026-10-29T10:00Z", "account": "fx-review-account", "argv": ["codex", "--model", "gpt-fixture"]}},
    {"seat": "omni-pl", "label": "fx-old-trial", "alive": false, "job": {"seat": "omni-pl", "label": "fx-old-trial", "bead": "fx-lead-work", "started_at": "2026-10-28T10:00Z", "account": "fx-old-account", "argv": ["codex"]}}
  ],
  "refStates": {"fixture-lab/lantern#12": {"state": "draft", "review": "pending", "checks": "passing", "title": "Add synthetic catalog search"}, "fixture-lab/lantern#24": {"state": "open", "review": "", "checks": "", "title": "Track the synthetic catalog"}, "fixture-lab/signals#8": {"state": "open", "review": "", "checks": "", "title": "Choose trace retention"}}
}
