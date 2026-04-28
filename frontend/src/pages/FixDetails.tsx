import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { getJobStatus, type JobProgress, type AIPatchReasoning } from '../api/client';
import './FixDetails.css';

// Maps backend step name to a display step index (0-3)
const STEP_ORDER = ['error_detected', 'ai_analyzing', 'validating', 'pr_created'];

const TIMELINE_STEPS = [
  { key: 'error_detected', label: 'Error Detected', desc: 'Webhook received from Vercel' },
  { key: 'ai_analyzing', label: 'AI Analyzing', desc: 'Gemini is analyzing the codebase' },
  { key: 'validating', label: 'Validating Fix', desc: 'Docker is running the patched build' },
  { key: 'pr_created', label: 'PR Created', desc: 'Fix pushed & pull request opened on GitHub' },
];

function getStepIndex(step: string): number {
  const idx = STEP_ORDER.indexOf(step);
  return idx === -1 ? 0 : idx;
}

function getBadgeVariant(state: string, step?: string) {
  if (state === 'failed' || step === 'failed') return 'error' as const;
  if (step === 'pr_created') return 'success' as const;
  if (state === 'completed') return 'success' as const;
  return 'pending' as const;
}

function getStatusLabel(state: string, step?: string) {
  if (step === 'failed') return 'Fix Failed';
  if (step === 'pr_created') return 'PR Opened';
  if (step === 'ai_analyzing') return 'AI Analyzing';
  if (step === 'validating') return 'Validating';
  if (step === 'error_detected') return 'Error Detected';
  if (state === 'waiting') return 'Queued';
  if (state === 'active') return 'In Progress';
  if (state === 'completed') return 'Completed';
  return 'Unknown';
}

function getRiskColor(level?: string): string {
  switch (level) {
    case 'LOW': return 'var(--status-success)';
    case 'MEDIUM': return '#f59e0b';
    case 'HIGH': return 'var(--status-error)';
    default: return 'var(--text-secondary)';
  }
}

function getRiskBgColor(level?: string): string {
  switch (level) {
    case 'LOW': return 'var(--status-success-bg)';
    case 'MEDIUM': return 'rgba(245, 158, 11, 0.12)';
    case 'HIGH': return 'var(--status-error-bg)';
    default: return 'rgba(255, 255, 255, 0.04)';
  }
}

function getConfidenceColor(score: number): string {
  if (score >= 0.8) return 'var(--status-success)';
  if (score >= 0.5) return '#f59e0b';
  return 'var(--status-error)';
}

/* ── Patch Card Sub-Component ──────────────────────────────────────────────── */
const PatchReasoningCard: React.FC<{ patch: AIPatchReasoning; index: number }> = ({ patch, index }) => {
  const [isOpen, setIsOpen] = useState(false);
  const confidencePct = Math.round((patch.confidenceScore ?? 0) * 100);

  return (
    <div className="patch-card" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="patch-card-header">
        <span className="patch-file-icon">📄</span>
        <span className="patch-file-path">{patch.filePath}</span>
        <span
          className="confidence-pill"
          style={{
            color: getConfidenceColor(patch.confidenceScore),
            borderColor: getConfidenceColor(patch.confidenceScore),
          }}
        >
          {confidencePct}% confident
        </span>
      </div>

      <div className="patch-card-body">
        <div className="reasoning-field">
          <span className="reasoning-label">🔍 Root Cause</span>
          <p className="reasoning-value">{patch.rootCause}</p>
        </div>

        <div className="reasoning-field">
          <span className="reasoning-label">🛠️ Fix Strategy</span>
          <p className="reasoning-value">{patch.fixStrategy}</p>
        </div>

        <div className="confidence-bar-container">
          <span className="reasoning-label">📊 Confidence</span>
          <div className="confidence-bar-track">
            <div
              className="confidence-bar-fill"
              style={{
                width: `${confidencePct}%`,
                backgroundColor: getConfidenceColor(patch.confidenceScore),
              }}
            />
          </div>
        </div>

        {patch.alternativesConsidered && patch.alternativesConsidered.length > 0 && (
          <div className="alternatives-section">
            <button
              className="alternatives-toggle"
              onClick={() => setIsOpen(!isOpen)}
              aria-expanded={isOpen}
            >
              <span className="alternatives-icon">{isOpen ? '▾' : '▸'}</span>
              Alternatives considered ({patch.alternativesConsidered.length})
            </button>
            {isOpen && (
              <ul className="alternatives-list">
                {patch.alternativesConsidered.map((alt, i) => (
                  <li key={i} className="alternative-item">
                    <span className="alt-bullet">✕</span>
                    {alt}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Main Component ────────────────────────────────────────────────────────── */
const FixDetails: React.FC = () => {
  const [searchParams] = useSearchParams();
  const jobId = searchParams.get('jobId');

  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [jobState, setJobState] = useState<string>('waiting');
  const [error, setError] = useState<string | null>(null);
  const [realtimeLogs, setRealtimeLogs] = useState<any[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const isTerminal = (state: string, step?: string) =>
    state === 'failed' || step === 'pr_created' || step === 'failed' || step === 'no_error';

  // Auto-scroll logs terminal
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [realtimeLogs]);

  // SSE for Real-time Logs
  useEffect(() => {
    if (!jobId) return;

    const token = localStorage.getItem("neurodeploy_token");
    const es = new EventSource(`/api/vercel/jobs/${jobId}/stream?token=${token}`);
    
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        setRealtimeLogs((prev) => [...prev, entry]);
      } catch (err) {
        console.error("Failed to parse SSE message", err);
      }
    };

    es.onerror = () => {
      console.warn("SSE connection error, it might have been closed by server.");
      es.close();
    };

    return () => es.close();
  }, [jobId]);


  useEffect(() => {
    if (!jobId) return;

    const poll = async () => {
      try {
        const status = await getJobStatus(jobId);
        setJobState(status.state);
        if (status.progress && typeof status.progress === 'object') {
          setProgress(status.progress as JobProgress);
        }
        if (isTerminal(status.state, (status.progress as JobProgress)?.step)) {
          if (intervalRef.current) clearInterval(intervalRef.current);
        }
      } catch (e) {
        setError(String(e));
        if (intervalRef.current) clearInterval(intervalRef.current);
      }
    };

    poll();
    intervalRef.current = setInterval(poll, 3000); // Poll slower since we have SSE
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [jobId]);

  const currentStepIndex = progress ? getStepIndex(progress.step) : -1;
  const reasoning = progress?.aiReasoning;
  const hasReasoning = reasoning && (reasoning.overallSummary || (reasoning.patches && reasoning.patches.length > 0));

  // If no jobId, show instructions
  if (!jobId) {
    return (
      <div className="fix-details-page">
        <div className="page-header">
          <h1>Fix Job Details</h1>
        </div>
        <Card>
          <div style={{ padding: '24px', color: 'var(--text-secondary)' }}>
            <p>No fix job selected.</p>
            <p style={{ marginTop: '8px', fontSize: '13px' }}>
              Go to the <strong>Projects</strong> page, find a project with a failed deployment, and click <strong>"Trigger Auto-Fix"</strong> to start a job.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="fix-details-page">
      <div className="page-header">
        <div className="header-title-group">
          <h1>Fix Job</h1>
          <span className="job-id-tag">#{jobId}</span>
          <Badge variant={getBadgeVariant(jobState, progress?.step)}>
            {getStatusLabel(jobState, progress?.step)}
          </Badge>
        </div>
        {progress?.prUrl && (
          <Button onClick={() => window.open(progress.prUrl!, '_blank')}>
            View PR on GitHub →
          </Button>
        )}
      </div>

      {error && <Badge variant="error" className="mb-4">{error}</Badge>}

      <div className="split-view">
        {/* Left: Logs */}
        <div className="pane left-pane">
          <Card className="full-height-card" title={
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              Worker Logs
              {jobState === 'active' && <span className="live-dot" />}
            </div>
          }>
            <div className="terminal">
              {realtimeLogs.length === 0 && jobState === 'waiting' && (
                <div className="terminal-line text-secondary">⏳ Job is queued, waiting for a worker...</div>
              )}
              {realtimeLogs.map((log, i) => (
                <div key={i} className={`terminal-line ${log.level === 'error' || log.message.includes('FAILED') ? 'text-error' : log.level === 'warn' ? 'text-warning' : ''}`}>
                  <span className="log-ts">[{new Date(log.ts).toLocaleTimeString()}]</span> {log.message}
                </div>
              ))}
              {jobState === 'active' && (
                <div className="terminal-line text-secondary blinking-cursor">▌</div>
              )}
              <div ref={logsEndRef} />
            </div>
          </Card>
        </div>

        {/* Right: AI Code Diff */}
        <div className="pane right-pane">
          <Card className="full-height-card" title="AI-Generated Code Changes">
            <div className="code-diff">
              {!progress?.diff && (
                <div className="terminal-line text-secondary">
                  {currentStepIndex < 2
                    ? 'Waiting for AI to generate a fix...'
                    : 'No code changes were generated.'}
                </div>
              )}
              {progress?.diff && progress.diff.split('\n').map((line, idx) => {
                let cls = 'diff-line';
                if (line.startsWith('-') && !line.startsWith('---')) cls += ' diff-removed';
                else if (line.startsWith('+') && !line.startsWith('+++')) cls += ' diff-added';
                else if (line.startsWith('@@')) cls += ' diff-header';
                else if (line.startsWith('//')) cls += ' diff-file-header';
                return <div key={idx} className={cls}><span className="diff-content">{line}</span></div>;
              })}
            </div>
          </Card>
        </div>
      </div>

      {/* ── AI Reasoning Panel ──────────────────────────────────────────────── */}
      {hasReasoning && (
        <div className="reasoning-panel mt-4">
          <div className="reasoning-panel-header">
            <div className="reasoning-title-group">
              <span className="reasoning-icon">🧠</span>
              <h2 className="reasoning-title">AI Reasoning</h2>
            </div>
            {reasoning.estimatedRiskLevel && (
              <div
                className="risk-badge"
                style={{
                  color: getRiskColor(reasoning.estimatedRiskLevel),
                  backgroundColor: getRiskBgColor(reasoning.estimatedRiskLevel),
                  borderColor: getRiskColor(reasoning.estimatedRiskLevel),
                }}
              >
                <span className="risk-dot" style={{ backgroundColor: getRiskColor(reasoning.estimatedRiskLevel) }} />
                {reasoning.estimatedRiskLevel} RISK
              </div>
            )}
          </div>

          {reasoning.overallSummary && (
            <div className="overall-summary">
              <p>{reasoning.overallSummary}</p>
            </div>
          )}

          {reasoning.patches && reasoning.patches.length > 0 && (
            <div className="patches-grid">
              {reasoning.patches.map((patch, idx) => (
                <PatchReasoningCard key={patch.filePath + idx} patch={patch} index={idx} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Timeline */}
      <Card title="Repair Timeline" className="timeline-card mt-4">
        <div className="timeline">
          {TIMELINE_STEPS.map((ts, idx) => {
            const isCompleted = currentStepIndex > idx || (progress?.step === 'pr_created' && idx === 3);
            const isActive = currentStepIndex === idx && !isTerminal(jobState, progress?.step);
            const isFailed = progress?.step === 'failed' && currentStepIndex === idx;

            return (
              <div
                key={ts.key}
                className={`timeline-step ${isCompleted ? 'completed' : ''} ${isActive ? 'active' : ''} ${isFailed ? 'failed-step' : ''}`}
              >
                <div className={`step-indicator ${isActive ? 'spinner' : ''}`}></div>
                <div className="step-content">
                  <div className="step-title">{ts.label}</div>
                  <div className="step-desc">{ts.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};

export default FixDetails;
