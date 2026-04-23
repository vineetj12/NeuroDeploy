import router from 'express';
import { fetchProjectById, fetchProjects, fixproject } from '../controller/vercel/vercel.ts';
import { handleVercelWebhook } from '../controller/vercel/vercelwebhook.ts';
import { prisma } from '../PrismaClientManager/index.ts';

export const vercelRouter=router.Router(); 

async function getUserVercelToken(userId: string): Promise<string> {
    console.log(`[vercel] Looking up Vercel token for userId=${userId}`);
    const credential = await prisma.userCredential.findFirst({
        where: { userId, provider: "VERCEL" },
        orderBy: { updatedAt: "desc" },
    });
    if (!credential?.secret) {
        console.error(`[vercel] No Vercel credential found for userId=${userId}`);
        throw new Error("Vercel credential not found for this user.");
    }
    console.log(`[vercel] Found Vercel token for userId=${userId} (credentialId=${credential.id})`);
    return credential.secret;
}

vercelRouter.get("/projects", async (req, res) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    if (!userId) {
        res.status(400).json({ error: "userId query param is required" });
        return;
    }
    try {
        const vercelToken = await getUserVercelToken(userId);
        console.log(`[vercel] Fetching all projects...`);
        const projects = await fetchProjects(vercelToken);
        console.log(`[vercel] Fetched ${projects.length} projects`);
        res.json(projects);
    } catch (error) {
        console.error("[vercel] Error fetching projects:", error);
        res.status(500).json({ error: "Failed to fetch projects" });
    }
});

vercelRouter.get("/projects/:id", async (req, res) => {
    const projectId = req.params.id;
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    if (!userId) {
        res.status(400).json({ error: "userId query param is required" });
        return;
    }
    try {
        const vercelToken = await getUserVercelToken(userId);
        console.log(`[vercel] Fetching project ${projectId}...`);
        const project = await fetchProjectById(projectId, vercelToken);
        const latest = project.latestDeployments?.[0];
        const failed = latest?.readyState !== "READY";
        const latestDeploymentId = latest?.id ?? null;
        console.log(`[vercel] Project ${projectId}: name=${project.name} readyState=${latest?.readyState} deploymentId=${latestDeploymentId}`);
        res.json({
            project,
            failed,
            latestDeploymentId,
        });
    } catch (error) {
        console.error("[vercel] Error fetching project by ID:", error);
        res.status(500).json({ error: "Failed to fetch project" });
    }
});

vercelRouter.post("/projects/:id/fix", async (req, res) => {
    const projectId = req.params.id;
    const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
    console.log(`[vercel/fix] Received fix request: projectId=${projectId} userId=${userId}`);
    if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
    }
    try {
        console.log(`[vercel/fix] Step 1: Looking up Vercel token...`);
        const vercelToken = await getUserVercelToken(userId);

        console.log(`[vercel/fix] Step 2: Fetching project from Vercel API...`);
        const project = await fetchProjectById(projectId, vercelToken);
        const latestDeploymentId = project.latestDeployments?.[0]?.id ?? null;
        console.log(`[vercel/fix] Step 3: Project fetched. name=${project.name} latestDeploymentId=${latestDeploymentId} readyState=${project.latestDeployments?.[0]?.readyState}`);

        console.log(`[vercel/fix] Step 4: Enqueueing fix job...`);
        await fixproject(projectId, latestDeploymentId, userId);
        console.log(`[vercel/fix] Step 5: Job enqueued successfully!`);

        res.json({
            queued: true,
            projectId,
            latestDeploymentId,
            userId,
        });
    } catch (error) {
        console.error("[vercel/fix] Error queueing project fix:", error);
        res.status(500).json({ error: "Failed to queue project fix" });
    }
});

vercelRouter.post("/webhook", async (req, res) => {
    try {
        await handleVercelWebhook(req, res);
    } catch (error) {
        console.error("Error handling webhook:", error);
        res.status(500).json({ error: "Failed to handle webhook" });
    }
});