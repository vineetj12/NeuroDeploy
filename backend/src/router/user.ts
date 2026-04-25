import router from "express";
export const userRouter = router.Router();
import {
  CheckUserAndPassword,
  CreateUser,
  UpdateUser,
  DeleteUser,
  AddUserCredential,
  UpdateUserModelKey,
  DeleteUserModelKey,
  CreateUserCredential,
  UpdateUserCredential,
  DeleteUserCredential,
  CreateAIModel,
  UpdateAIModel,
  DeleteAIModel,
} from "../controller/user/user.controller.ts";
import { GenerateToken, authMiddleware, type AuthenticatedRequest } from "../middleware/auth.middleware.ts";

// ── Auth (public) ───────────────────────────────────────────────────────────

userRouter.post("/create", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await CreateUser(email, password);
    const token = GenerateToken(user.id);
    res.status(201).json({ token });
  } catch (error) {
    console.error("[user] Error creating user:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
});

userRouter.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await CheckUserAndPassword(email, password);
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const token = GenerateToken(user.id);
    res.status(200).json({ token });
  } catch (error) {
    console.error("[user] Error logging in:", error);
    res.status(500).json({ error: "Failed to log in" });
  }
});

// ── User (protected) ────────────────────────────────────────────────────────

userRouter.put("/update", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const { email, password, selectedModelId } = req.body;
  try {
    const user = await UpdateUser(userId, { email, password, selectedModelId });
    res.json(user);
  } catch (error) {
    console.error("[user] Error updating user:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

userRouter.delete("/delete", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  try {
    await DeleteUser(userId);
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error("[user] Error deleting user:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ── UserModelKey (protected) ────────────────────────────────────────────────

userRouter.post("/model-keys", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const { modelId, apiKey } = req.body;
  try {
    const key = await AddUserCredential(userId, modelId, apiKey);
    res.status(201).json(key);
  } catch (error) {
    console.error("[user] Error adding model key:", error);
    res.status(500).json({ error: "Failed to add model key" });
  }
});

userRouter.put("/model-keys", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const { modelId, apiKey } = req.body;
  try {
    const key = await UpdateUserModelKey(userId, modelId, apiKey);
    res.json(key);
  } catch (error) {
    console.error("[user] Error updating model key:", error);
    res.status(500).json({ error: "Failed to update model key" });
  }
});

userRouter.delete("/model-keys/:modelId", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const modelId = req.params.modelId as string;
  try {
    await DeleteUserModelKey(userId, modelId);
    res.json({ message: "Model key deleted successfully" });
  } catch (error) {
    console.error("[user] Error deleting model key:", error);
    res.status(500).json({ error: "Failed to delete model key" });
  }
});

// ── UserCredential (protected) ──────────────────────────────────────────────

userRouter.post("/credentials", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const { provider, name, secret } = req.body;
  try {
    const credential = await CreateUserCredential(userId, provider, name, secret);
    res.status(201).json(credential);
  } catch (error) {
    console.error("[user] Error creating credential:", error);
    res.status(500).json({ error: "Failed to create credential" });
  }
});

userRouter.put("/credentials", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId!;
  const { provider, name, secret } = req.body;
  try {
    const credential = await UpdateUserCredential(userId, provider, name, secret);
    res.json(credential);
  } catch (error) {
    console.error("[user] Error updating credential:", error);
    res.status(500).json({ error: "Failed to update credential" });
  }
});

userRouter.delete(
  "/credentials/:provider/:name",
  authMiddleware,
  async (req: AuthenticatedRequest, res) => {
    const userId = req.userId!;
    const provider = req.params.provider as "GITHUB" | "VERCEL" | "CUSTOM";
    const name = req.params.name as string;
    try {
      await DeleteUserCredential(userId, provider, name);
      res.json({ message: "Credential deleted successfully" });
    } catch (error) {
      console.error("[user] Error deleting credential:", error);
      res.status(500).json({ error: "Failed to delete credential" });
    }
  }
);

// ── AIModel (protected) ─────────────────────────────────────────────────────

userRouter.post("/models", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { name, provider } = req.body;
  try {
    const model = await CreateAIModel(name, provider);
    res.status(201).json(model);
  } catch (error) {
    console.error("[user] Error creating AI model:", error);
    res.status(500).json({ error: "Failed to create AI model" });
  }
});

userRouter.put("/models/:id", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const id = req.params.id as string;
  const { name, provider, isActive, isSelected } = req.body;
  try {
    const model = await UpdateAIModel(id, { name, provider, isActive, isSelected });
    res.json(model);
  } catch (error) {
    console.error("[user] Error updating AI model:", error);
    res.status(500).json({ error: "Failed to update AI model" });
  }
});

userRouter.delete("/models/:id", authMiddleware, async (req: AuthenticatedRequest, res) => {
  const id = req.params.id as string;
  try {
    await DeleteAIModel(id);
    res.json({ message: "AI model deleted successfully" });
  } catch (error) {
    console.error("[user] Error deleting AI model:", error);
    res.status(500).json({ error: "Failed to delete AI model" });
  }
});