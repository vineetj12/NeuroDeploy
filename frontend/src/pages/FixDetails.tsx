import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { getJobStatus, type JobProgress } from '../api/client';
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

const FixDetails: React.FC = () => {
  const [searchParams] = useSearchParams();
  const jobId = searchParams.get('jobId');

  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [jobState, setJobState] = useState<string>('waiting');
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isTerminal = (state: string, step?: string) =>
    state === 'failed' || step === 'pr_created' || step === 'failed' || step === 'no_error';

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
    intervalRef.current = setInterval(poll, 2500);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [jobId]);

  const currentStepIndex = progress ? getStepIndex(progress.step) : -1;

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
          <Card className="full-height-card" title="Worker Logs">
            <div className="terminal">
              {!progress && jobState === 'waiting' && (
                <div className="terminal-line text-secondary">⏳ Job is queued, waiting for a worker...</div>
              )}
              {progress?.logs?.map((line, i) => (
                <div key={i} className={`terminal-line ${line.includes('FAILED') || line.includes('failed') ? 'text-error' : ''}`}>
                  {line}
                </div>
              ))}
              {jobState === 'active' && (
                <div className="terminal-line text-secondary blinking-cursor">▌</div>
              )}
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
