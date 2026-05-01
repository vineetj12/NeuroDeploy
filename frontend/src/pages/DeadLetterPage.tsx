import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import {
  dismissDeadLetterEntry,
  getDeadLetterEntries,
  replayDeadLetterEntry,
  type DeadLetterEntry,
} from "../api/client";
import "./DeadLetterPage.css";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncatePayload(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload, null, 2) ?? "{}";
  if (text.length <= 2000) return text;
  return `${text.slice(0, 2000)}\n...`;
}

export default function DeadLetterPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<DeadLetterEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const hasEntries = entries.length > 0;

  const payloadCache = useMemo(() => {
    const map = new Map<string, string>();
    entries.forEach((entry) => {
      map.set(entry.id, truncatePayload(entry.webhookPayload));
    });
    return map;
  }, [entries]);

  const loadEntries = async () => {
    try {
      setIsLoading(true);
      const data = await getDeadLetterEntries();
      setEntries(data);
      setError(null);
    } catch (err: any) {
      if (err.message === "UNAUTHORIZED") {
        localStorage.removeItem("neurodeploy_token");
        navigate("/login");
      } else {
        setError(err.message || "Failed to load dead letter queue");
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadEntries();
  }, []);

  const handleReplay = async (entry: DeadLetterEntry) => {
    setBusyId(entry.id);
    try {
      const newJobId = await replayDeadLetterEntry(entry.id);
      navigate(`/fixes?jobId=${newJobId}`);
    } catch (err: any) {
      alert(err.message || "Failed to replay job");
    } finally {
      setBusyId(null);
    }
  };

  const handleDismiss = async (entry: DeadLetterEntry) => {
    setBusyId(entry.id);
    try {
      await dismissDeadLetterEntry(entry.id);
      setEntries((prev) => prev.filter((item) => item.id !== entry.id));
    } catch (err: any) {
      alert(err.message || "Failed to dismiss entry");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="dead-letter-page">
      <div className="dead-letter-hero">
        <div className="dead-letter-hero-copy">
          <p className="dead-letter-kicker">Webhook Dead Letter Queue</p>
          <h1>Replay failures without losing context</h1>
          <p className="dead-letter-subtitle">
            Inspect jobs that exhausted retries, replay them when ready, or dismiss them once resolved.
          </p>
        </div>
        <div className="dead-letter-hero-actions">
          <Button variant="secondary" onClick={loadEntries} disabled={isLoading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="dead-letter-error">
          <Badge variant="error">{error}</Badge>
        </div>
      )}

      {isLoading && (
        <Card className="dead-letter-card">
          <div className="dead-letter-empty">
            <span className="dead-letter-muted">Loading dead letter entries...</span>
          </div>
        </Card>
      )}

      {!isLoading && !hasEntries && !error && (
        <Card className="dead-letter-card">
          <div className="dead-letter-empty">
            <h3>Queue is clear</h3>
            <p>No permanently failed jobs are waiting for review.</p>
          </div>
        </Card>
      )}

      {!isLoading && hasEntries && (
        <div className="dead-letter-grid">
          {entries.map((entry) => {
            const payloadPreview = payloadCache.get(entry.id) ?? "{}";
            const replayDisabled = !entry.canReplay || busyId === entry.id;

            return (
              <Card key={entry.id} className="dead-letter-card">
                <div className="dead-letter-card-header">
                  <div>
                    <div className="dead-letter-title">Job #{entry.originalJobId}</div>
                    <div className="dead-letter-meta">
                      <span>Attempts: {entry.attemptCount}</span>
                      <span>First failed: {formatDate(entry.firstFailedAt)}</span>
                      <span>Last failed: {formatDate(entry.lastFailedAt)}</span>
                    </div>
                  </div>
                  <Badge variant={entry.canReplay ? "pending" : "error"}>
                    {entry.canReplay ? "Replayable" : "Expired"}
                  </Badge>
                </div>

                <div className="dead-letter-reason">{entry.failureReason}</div>

                <div className="dead-letter-payload">
                  <div className="dead-letter-payload-label">Webhook payload</div>
                  <pre>{payloadPreview}</pre>
                </div>

                <div className="dead-letter-actions">
                  <Button
                    size="sm"
                    disabled={replayDisabled}
                    onClick={() => handleReplay(entry)}
                  >
                    Replay
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === entry.id}
                    onClick={() => handleDismiss(entry)}
                  >
                    Dismiss
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
