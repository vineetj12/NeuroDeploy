import router from 'express';
import { fetchProjectById, fetchProjects, fixproject } from '../controller/vercel/vercel.ts';
import { handleVercelWebhook } from '../controller/vercel/vercelwebhook.ts';

export const vercelRouter=router.Router(); 
vercelRouter.get("/projects",async (req,res)=>{
    try {
        const projects=await fetchProjects();
        console.log("Fetched projects:", projects);
        res.json(projects);
    } catch (error) {
        console.error("Error fetching projects:", error);
        res.status(500).json({ error: "Failed to fetch projects" });
    }
});
vercelRouter.get("/projects/:id",async (req,res)=>{
    const projectId=req.params.id;
    try {
        const project=await fetchProjectById(projectId);
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
        const project = await fetchProjectById(projectId);
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