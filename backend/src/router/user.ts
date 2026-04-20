import router from 'express';
export const userRouter=router.Router(); 
import { CreateUser, UpdateUser } from '../controller/user/user.controller.ts';

userRouter.post('/create', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await CreateUser(email, password);
        res.json(user);
    } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({ error: "Failed to create user" });
    }
});

userRouter.patch('/:id', async (req, res) => {
    const { email, password, selectedModelId } = req.body;
    const updateData = {
        ...(email !== undefined ? { email } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(selectedModelId !== undefined ? { selectedModelId } : {}),
    };

    if (Object.keys(updateData).length === 0) {
        res.status(400).json({ error: "No fields provided to update" });
        return;
    }

    try {
        const user = await UpdateUser(req.params.id, updateData);
        res.json(user);
    } catch (error) {
        console.error("Error updating user:", error);
        res.status(500).json({ error: "Failed to update user" });
    }
});