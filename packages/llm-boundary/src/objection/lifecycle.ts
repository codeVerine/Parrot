import {
  isLegalObjectionTransition,
  type ObjectionStatus,
} from "@platform/contracts";

export type LifecycleActor = "planner" | "verifier" | "human" | "system";

export type LifecycleDecision =
  | { ok: true; next: ObjectionStatus }
  | { ok: false; reason: string; status: ObjectionStatus };

/**
 * Apply a requested status change. Verifier rejection keeps `open`.
 */
export function applyObjectionTransition(input: {
  current: ObjectionStatus;
  requested: ObjectionStatus | "verifier_reject";
  actor: LifecycleActor;
}): LifecycleDecision {
  if (input.requested === "verifier_reject") {
    if (input.actor !== "verifier") {
      return { ok: false, reason: "only verifier may reject a resolution", status: input.current };
    }
    return { ok: true, next: "open" };
  }

  if (input.current === input.requested) {
    return { ok: true, next: input.current };
  }

  if (!isLegalObjectionTransition(input.current, input.requested)) {
    return {
      ok: false,
      reason: `illegal transition ${input.current} → ${input.requested}`,
      status: input.current,
    };
  }

  if (input.requested === "waived" && input.actor !== "human") {
    return { ok: false, reason: "only human may waive objections", status: input.current };
  }

  return { ok: true, next: input.requested };
}
