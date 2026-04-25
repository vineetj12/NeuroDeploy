// API Client — all requests use JWT token from localStorage

const BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('neurodeploy_token');
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export const register = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`${BASE}/user/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Registration failed');
  }
  const data = await res.json();
  return data.token as string;
};

export const login = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`${BASE}/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Login failed');
  }
  const data = await res.json();
  return data.token as string;
};

// ── Vercel Projects ───────────────────────────────────────────────────────────

export const getVercelProjects = async (): Promise<any[]> => {
  const res = await fetch(`${BASE}/vercel/projects`, {
    headers: authHeaders(),
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (res.status === 403) throw new Error('NO_CREDENTIALS');
  if (!res.ok) throw new Error('Failed to fetch projects');
  const data = await res.json();
  return data as any[];
};

// ── Fix Job ───────────────────────────────────────────────────────────────────

export const triggerFixJob = async (projectId: string): Promise<string> => {
  const res = await fetch(`${BASE}/vercel/projects/${projectId}/fix`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error('Failed to trigger fix');
  const data = await res.json();
  return data.jobId as string;
};

// ── Job Status ────────────────────────────────────────────────────────────────

export interface JobProgress {
  step: 'error_detected' | 'ai_analyzing' | 'validating' | 'pr_created' | 'failed' | 'no_error';
  logs: string[];
  diff: string | null;
  prUrl: string | null;
}

export interface JobStatus {
  jobId: string;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
  progress: JobProgress | number | null;
}

export const getJobStatus = async (jobId: string): Promise<JobStatus> => {
  const res = await fetch(`${BASE}/vercel/jobs/${jobId}/status`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('Failed to fetch job status');
  return res.json();
};

// ── Credentials (save API keys) ───────────────────────────────────────────────

export const saveCredential = async (
  provider: 'VERCEL' | 'GITHUB' | 'CUSTOM',
  name: string,
  secret: string
): Promise<void> => {
  const res = await fetch(`${BASE}/user/credentials`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ provider, name, secret }),
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error(`Failed to save ${provider} credential`);
};

export const saveAIModel = async (name: string, provider: string): Promise<any> => {
  const res = await fetch(`${BASE}/user/models`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, provider }),
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error('Failed to save AI model');
  return res.json();
};

export const saveModelKey = async (modelId: string, apiKey: string): Promise<void> => {
  const res = await fetch(`${BASE}/user/model-keys`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ modelId, apiKey }),
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error('Failed to save AI model key');
};

export const updateUser = async (data: { selectedModelId?: string }): Promise<void> => {
  const res = await fetch(`${BASE}/user/update`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(data),
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error('Failed to update user');
};
