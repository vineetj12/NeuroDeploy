import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { getVercelProjects, triggerFixJob } from '../api/client';
import './Dashboard.css';

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await getVercelProjects();
        setProjects(data);
      } catch (e: any) {
        if (e.message === 'UNAUTHORIZED') {
          localStorage.removeItem('neurodeploy_token');
          navigate('/login');
        } else if (e.message === 'NO_CREDENTIALS') {
          navigate('/settings');
        } else {
          setError(e.message);
        }
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [navigate]);

  const handleFix = async (projectId: string) => {
    try {
      const jobId = await triggerFixJob(projectId);
      navigate(`/fixes?jobId=${jobId}`);
    } catch (e: any) {
      alert('Error triggering fix: ' + e.message);
    }
  };

  const failedProjects = projects.filter(p => {
    const latest = p.targets?.production || p.latestDeployments?.[0];
    return latest?.readyState === 'ERROR';
  });

  const successRate = projects.length === 0
    ? '—'
    : `${Math.round(((projects.length - failedProjects.length) / projects.length) * 100)}%`;

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Overview</h1>
      </div>

      <div className="stats-grid">
        <Card>
          <div className="stat-label">Active Projects</div>
          <div className="stat-value">
            {isLoading ? <span className="stat-skeleton">—</span> : projects.length}
          </div>
        </Card>
        <Card>
          <div className="stat-label">Success Rate</div>
          <div className="stat-value text-success">
            {isLoading ? <span className="stat-skeleton">—</span> : successRate}
          </div>
        </Card>
        <Card>
          <div className="stat-label">Failed Deployments</div>
          <div className="stat-value" style={{ color: failedProjects.length > 0 ? 'var(--status-error)' : undefined }}>
            {isLoading ? <span className="stat-skeleton">—</span> : failedProjects.length}
          </div>
        </Card>
      </div>

      <Card title="Recent Deployments" className="mt-8">
        {error && <Badge variant="error">{error}</Badge>}
        {isLoading && <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading projects...</p>}

        {!isLoading && !error && projects.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            No projects found. Add your Vercel token in{' '}
            <a href="/settings">Settings</a>.
          </p>
        )}

        <div className="activity-list">
          {projects.map(project => {
            const latest = project.targets?.production || project.latestDeployments?.[0];
            const state = latest?.readyState ?? 'UNKNOWN';
            const isFailed = state === 'ERROR';
            const isReady = state === 'READY';

            return (
              <div className="activity-item" key={project.id}>
                <div className="activity-info">
                  <span className="project-name">{project.name}</span>
                  <span className="timestamp">{project.framework ?? 'unknown framework'}</span>
                </div>
                <div className="activity-status">
                  {isFailed && <Badge variant="error">Failed</Badge>}
                  {isReady && <Badge variant="success">Deployed</Badge>}
                  {!isFailed && !isReady && <Badge variant="neutral">{state}</Badge>}
                  {isFailed && (
                    <Button size="sm" variant="secondary" onClick={() => handleFix(project.id)}>
                      Auto-Fix
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};

export default Dashboard;
