import router from 'express';
export const userRouter=router.Router(); 
import { CheckUserAndPassword, CreateUser, UpdateUser } from '../controller/user/user.controller.ts';
import { GenerateToken } from '../controller/token/tokencontroller.ts';

userRouter.post('/create', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await CreateUser(email, password);
        const token = GenerateToken(user.id);
        res.status(201).json({ token });
    } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({ error: "Failed to create user" });
    }
});

userRouter.post('/login',async (req,res)=>{
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
        console.error("Error logging in:", error);
        res.status(500).json({ error: "Failed to log in" });
    }
});