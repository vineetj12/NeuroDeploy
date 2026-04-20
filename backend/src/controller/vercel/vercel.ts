import axios from "axios";
import type { VercelProject } from "../../types.js";
import { enqueueFixProject } from "../../queue/fixProjectQueue.js";

type VercelProjectsResponse = {
  projects?: VercelProject[];
};

function GetHeader(vercelTokenOverride?: string) {
  const token = vercelTokenOverride;
  if (!token || token.trim() === "") {
    throw new Error("Vercel token is required. Provide a user credential token from DB.");
  }
  return {
    Authorization: `Bearer ${token}`,
  };
}

export async function fetchProjects(vercelTokenOverride?: string): Promise<VercelProject[]> {
    try {
        const Header=GetHeader(vercelTokenOverride);
        const response = await axios.get<VercelProjectsResponse | VercelProject[]>(
          "https://api.vercel.com/v9/projects",
          { headers: Header }
        );

        const { data } = response;

        if (Array.isArray(data)) {
          return data.map(({ id, name }) => ({ id, name }));
        }

        if (data && Array.isArray(data.projects)) {
          return data.projects.map(({ id, name }) => ({ id, name }));
        }

        throw new Error("Unexpected Vercel API response shape while fetching projects.");
    } catch (error) {
        console.error("Error fetching projects:", error);
        throw error;
    }
}

export async function fetchProjectById(projectId: string, vercelTokenOverride?: string): Promise<VercelProject> {
  try {
    const Header=GetHeader(vercelTokenOverride);
    const response = await axios.get<VercelProject>(
      `https://api.vercel.com/v10/projects/${projectId}`,
      { headers: Header }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching project by ID:", error);
    throw error;
  }
}
export async function fixproject(projectId: string, latestDeploymentId: string | null, userId?: string): Promise<void> {
    if (!latestDeploymentId) {
        throw new Error("Invalid latestDeploymentId");
    }

  await enqueueFixProject({
    projectId,
    latestDeploymentId,
    ...(userId ? { userId } : {}),
  });
}