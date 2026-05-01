import { prisma } from "../PrismaClientManager/index.ts";

/**
 * Fetches the most-recently-updated credential secret for a given user + provider.
 * Returns null if not found.
 */
export async function getLatestCredentialSecret(
  userId: string,
  provider: "GITHUB" | "VERCEL" | "CUSTOM"
): Promise<string | null> {
  const credential = await prisma.userCredential.findFirst({
    where: { userId, provider },
    orderBy: { updatedAt: "desc" },
  });
  return credential?.secret?.trim() || null;
}

/**
 * Retrieves the Vercel token for a user, throwing if it is missing.
 */
export async function getUserVercelToken(userId: string): Promise<string> {
  console.log(`[credential.service] Looking up Vercel token for userId=${userId}`);
  const secret = await getLatestCredentialSecret(userId, "VERCEL");
  if (!secret) {
    console.error(`[credential.service] No Vercel credential found for userId=${userId}`);
    throw new Error("Vercel credential not found for this user.");
  }
  console.log(`[credential.service] Found Vercel token for userId=${userId}`);
  return secret;
}

/**
 * Retrieves the GitHub token for a user, throwing if it is missing.
 */
export async function getUserGithubToken(userId: string): Promise<string> {
  console.log(`[credential.service] Looking up GitHub token for userId=${userId}`);
  const secret = await getLatestCredentialSecret(userId, "GITHUB");
  if (!secret) {
    console.error(`[credential.service] No GitHub credential found for userId=${userId}`);
    throw new Error("GitHub credential not found for this user.");
  }
  console.log(`[credential.service] Found GitHub token for userId=${userId}`);
  return secret;
}
