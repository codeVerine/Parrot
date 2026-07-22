import { useState, type FormEvent } from "react";

type Snapshot = {
  summary: {
    workflowId: string;
    phase: string;
    iterationCount: number;
    spendTotal: number;
    consensusReached: boolean;
  };
  openObjections: Array<{
    id: string;
    severity: string;
    claim: { value: string };
  }>;
  cost: {
    inputTokens: number;
    outputTokens: number;
    recordCount: number;
  };
  escalation: {
    reason: string | null;
    openObjectionIds: string[];
  };
  frontier: {
    readiness: string | null;
  };
};

export function App() {
  const [workflowId, setWorkflowId] = useState("workflow-1");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}`);
      if (!response.ok) throw new Error(await response.text());
      setSnapshot(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approved" | "rejected", waive = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/workflows/${encodeURIComponent(workflowId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision,
            comment: comment || undefined,
            waiveOpenObjections: waive,
          }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void load();
  }

  return (
    <main>
      <h1>Parrot</h1>
      <p className="lede">
        Structured read models only — objections, cost, frontier, and human
        decisions. Claims render escaped; never as instructions.
      </p>

      <form className="row" onSubmit={onSubmit}>
        <input
          value={workflowId}
          onChange={(event) => setWorkflowId(event.target.value)}
          aria-label="Workflow ID"
        />
        <button type="submit" disabled={busy}>
          Load
        </button>
      </form>

      {error ? <p className="error">{error}</p> : null}

      {snapshot ? (
        <>
          <section>
            <h2>Summary</h2>
            <div className="meta">
              <div>
                <strong>Phase</strong>
                {snapshot.summary.phase}
              </div>
              <div>
                <strong>Iteration</strong>
                {snapshot.summary.iterationCount}
              </div>
              <div>
                <strong>Spend</strong>
                {snapshot.summary.spendTotal.toFixed(4)}
              </div>
              <div>
                <strong>Frontier</strong>
                {snapshot.frontier.readiness ?? "—"}
              </div>
              <div>
                <strong>Escalation</strong>
                {snapshot.escalation.reason ?? "none"}
              </div>
            </div>
          </section>

          <section>
            <h2>Open objections</h2>
            {snapshot.openObjections.length === 0 ? (
              <p>None.</p>
            ) : (
              <ul>
                {snapshot.openObjections.map((objection) => (
                  <li key={objection.id}>
                    <div>
                      {objection.id} · {objection.severity}
                    </div>
                    {/* React text node escapes once — do not pre-escape in the API. */}
                    <div className="claim">{objection.claim.value}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Cost</h2>
            <div className="meta">
              <div>
                <strong>Input tokens</strong>
                {snapshot.cost.inputTokens}
              </div>
              <div>
                <strong>Output tokens</strong>
                {snapshot.cost.outputTokens}
              </div>
              <div>
                <strong>Ledger rows</strong>
                {snapshot.cost.recordCount}
              </div>
            </div>
          </section>

          <section>
            <h2>Decision</h2>
            <textarea
              rows={3}
              style={{ width: "100%", marginBottom: "0.75rem" }}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Optional comment"
            />
            <div className="row">
              <button type="button" disabled={busy} onClick={() => void decide("approved")}>
                Approve
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || snapshot.openObjections.length === 0}
                onClick={() => void decide("approved", true)}
              >
                Approve with waivers
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void decide("rejected")}
              >
                Reject
              </button>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
