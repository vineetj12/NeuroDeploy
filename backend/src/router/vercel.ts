import router from 'express';
import { fetchProjectById, fetchProjects, fixproject } from '../controller/vercel/vercel.ts';
import { handleVercelWebhook } from '../controller/vercel/vercelwebhook.ts';
import { prisma } from '../PrismaClientManager/index.ts';

export const vercelRouter=router.Router(); 

async function getUserVercelToken(userId: string): Promise<string> {
    const credential = await prisma.userCredential.findFirst({
        where: { userId, provider: "VERCEL" },
        orderBy: { updatedAt: "desc" },
    });
    if (!credential?.secret) {
        throw new Error("Vercel credential not found for this user.");
    }
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
        const projects = await fetchProjects(vercelToken);
        console.log("Fetched projects:", projects);
        res.json(projects);
    } catch (error) {
        console.error("Error fetching projects:", error);
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
        const project = await fetchProjectById(projectId, vercelToken);
        const latest = project.latestDeployments?.[0];
        const failed = latest?.readyState !== "READY";
        const latestDeploymentId = latest?.id ?? null;
        console.log("Fetched project:", project);
        res.json({
            project,
            failed,
            latestDeploymentId,
        });
    } catch (error) {
        console.error("Error fetching project by ID:", error);
        res.status(500).json({ error: "Failed to fetch project" });
    }
});

vercelRouter.post("/projects/:id/fix", async (req, res) => {
    const projectId = req.params.id;
    const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
    if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
    }
    try {
        const vercelToken = await getUserVercelToken(userId);
        const project = await fetchProjectById(projectId, vercelToken);
        const latestDeploymentId = project.latestDeployments?.[0]?.id ?? null;
        await fixproject(projectId, latestDeploymentId, userId);

        res.json({
            queued: true,
            projectId,
            latestDeploymentId,
            userId,
        });
    } catch (error) {
        console.error("Error queueing project fix:", error);
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