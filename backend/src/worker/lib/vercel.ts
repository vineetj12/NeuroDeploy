import axios from "axios";
import type { DeploymentEvent } from "./types.ts";

function getVercelHeaders(vercelToken: string) {
  if (!vercelToken || vercelToken.trim() === "") {
    throw new Error("User Vercel token is missing.");
  }

  return {
    Authorization: `Bearer ${vercelToken}`,
  };
}

export async function fetchDeploymentError(deploymentId: string, vercelToken: string): Promise<string | null> {
  try {
    const response = await axios.get<DeploymentEvent[] | { events?: DeploymentEvent[] }>(
      `https://api.vercel.com/v3/deployments/${deploymentId}/events`,
      {
        params: {
          limit: -1,
          builds: 1,
        },
        headers: getVercelHeaders(vercelToken),
      }
    );

    const events = Array.isArray(response.data) ? response.data : response.data.events ?? [];
    const logLines = events
      .flatMap((event) => [event.text, event.payload?.text])
      .filter((line): line is string => typeof line === "string");

    for (let i = logLines.length - 1; i >= 0; i -= 1) {
      const line = logLines[i];
      if (!line) {
        continue;
      }

      const normalizedLine = line.trim();
      if (/error|failed|exception|fatal/i.test(normalizedLine)) {
        return normalizedLine;
      }
    }

    const hasErrorState = events.some((event) => event.payload?.info?.readyState === "ERROR");
    if (hasErrorState) {
      return "Deployment finished with ERROR state, but no explicit error line was found.";
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      return `Failed to fetch deployment events: ${error.message}`;
    }
    return "Failed to fetch deployment events.";
  }
}
