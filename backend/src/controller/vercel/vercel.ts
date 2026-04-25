import axios from "axios";
import type { VercelProject } from "../../types.ts";

type VercelProjectsResponse = {
  projects?: VercelProject[];
};

function getHeader(vercelToken: string) {
  if (!vercelToken || vercelToken.trim() === "") {
    throw new Error("Vercel token is required. Provide a user credential token from DB.");
  }
  return { Authorization: `Bearer ${vercelToken}` };
}

export async function fetchProjects(vercelToken?: string): Promise<VercelProject[]> {
  try {
    const headers = getHeader(vercelToken ?? "");
    const response = await axios.get<VercelProjectsResponse | VercelProject[]>(
      "https://api.vercel.com/v9/projects",
      { headers }
    );

    const { data } = response;

    if (Array.isArray(data)) {
      return data;
    }

    if (data && Array.isArray(data.projects)) {
      return data.projects;
    }

    throw new Error("Unexpected Vercel API response shape while fetching projects.");
  } catch (error) {
    console.error("[vercel.controller] Error fetching projects:", error);
    throw error;
  }
}

export async function fetchProjectById(
  projectId: string,
  vercelToken?: string
): Promise<VercelProject> {
  try {
    const headers = getHeader(vercelToken ?? "");
    const response = await axios.get<VercelProject>(
      `https://api.vercel.com/v10/projects/${projectId}`,
      { headers }
    );
    return response.data;
  } catch (error) {
    console.error("[vercel.controller] Error fetching project by ID:", error);
    throw error;
  }
}