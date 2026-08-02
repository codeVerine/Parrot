/** User-facing role labels. Internal IDs stay planner/reviewer. */

const AUTHOR_IDS = new Set(["planner", "author"]);
const PAIR_IDS = new Set(["reviewer", "pair", "adversarial"]);

/** Map known agent ids to Author/Pair; preserve custom names. */
export function displayAgentLabel(agentId: string): string {
  const trimmed = agentId.trim();
  if (!trimmed) return "unknown";
  const key = trimmed.toLowerCase();
  if (AUTHOR_IDS.has(key)) return "Author";
  if (PAIR_IDS.has(key)) return "Pair";
  return trimmed;
}

export function displayTurnTitle(turnType: string): string {
  switch (turnType) {
    case "planner_propose":
      return "Author Propose";
    case "planner_revise":
      return "Author Revise";
    case "reviewer_review":
      return "Pair Review";
    case "adversarial_review":
      return "Pair Adversarial Review";
    case "resolution_verification":
      return "Resolution Verification";
    case "objection_merge":
      return "Objection Merge";
    case "compacted_state_refresh":
      return "Compacted State Refresh";
    case "frontier_report":
      return "Frontier Report";
    case "implementation":
      return "Implementation";
    case "repair":
      return "Repair";
    default:
      return turnType
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}
