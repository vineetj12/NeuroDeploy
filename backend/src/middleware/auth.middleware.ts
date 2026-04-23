import { type Request, type Response, type NextFunction } from "express";
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../envdata/data.ts';
export interface AuthenticatedRequest extends Request {
  userId?: string;
  token?: string;
}
export const GenerateToken = (userId: String) => {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}
export const VerifyToken = (token: string) => {
    try {
        return jwt.verify(token, JWT_SECRET) as { userId: string };
    } catch (error) {
        console.error("Error verifying token:", error);
        throw new Error("Invalid token");
    }
}
export const authMiddleware = (req:AuthenticatedRequest, res:Response, next:NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Authorization header missing" });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: "Token missing" });
    }
    try {        
        const decoded = VerifyToken(token);
        req.userId = decoded.userId;
        req.token = token;
        next();
    } catch (error) {
        return res.status(401).json({ error: "Invalid token" });
    }
}
