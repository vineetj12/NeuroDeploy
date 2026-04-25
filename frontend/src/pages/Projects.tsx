import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { getVercelProjects, triggerFixJob } from '../api/client';
import './Projects.css';

const Projects: React.FC = () => {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const data = await getVercelProjects();
        setProjects(data);
      } catch (err: any) {
        if (err.message === 'UNAUTHORIZED') {
          localStorage.removeItem('neurodeploy_token');
          navigate('/login');
        } else if (err.message === 'NO_CREDENTIALS') {
          navigate('/settings');
        } else {
          setError(String(err));
        }
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchProjects();
  }, [navigate]);

  const handleFix = async (projectId: string) => {
    try {
      const jobId = await triggerFixJob(projectId);
      navigate(`/fixes?jobId=${jobId}`);
    } catch (err: any) {
      alert('Error triggering fix: ' + String(err));
    }
  };

  return (
    <div className="projects-page">
      <div className="page-header">
        <h1>Connected Projects</h1>
      </div>

      {isLoading && <p>Loading projects...</p>}
      {error && <Badge variant="error">{error}</Badge>}

      {!isLoading && !error && projects.length === 0 && (
        <p>No projects found for this Vercel account.</p>
      )}

      <div className="projects-grid mt-4">
        {projects.map(project => (
          <Card key={project.id} className="project-card">
            <div className="project-header">
              <h3 className="project-name">{project.name}</h3>
              <span className="framework-badge">{project.framework || 'unknown'}</span>
            </div>
            
            <div className="project-actions">
              <Button size="sm" onClick={() => handleFix(project.id)}>Trigger Auto-Fix</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default Projects;
