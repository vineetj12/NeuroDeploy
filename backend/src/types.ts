export type VercelProject = {
  id: string;
  name: string;
  buildCommand?: string | null;
  installCommand?: string | null;
  framework?: string | null;
  outputDirectory?: string | null;
  link?: VercelProjectLink | null;
  latestDeployments?: VercelDeployment[];
  targets?: Record<string, VercelDeployment>;
};

export type VercelProjectLink = {
  org?: string | null;
  repo?: string | null;
  productionBranch?: string | null;
};

export type VercelDeployment = {
  id?: string;
  readyState?: string;
  target?: string;
  url?: string;
};