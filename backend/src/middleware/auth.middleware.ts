import { type Request, type Response, type NextFunction } from "express";
import { generateToken, verifyToken } from "../services/auth.service.ts";

export interface AuthenticatedRequest extends Request {
  userId?: string;
  token?: string;
}

/**
 * @deprecated Use `generateToken` from `services/auth.service.ts` directly.
 * Kept here for backwards-compatibility with existing router imports.
 */
export const GenerateToken = generateToken;

export const authMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Authorization header missing" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Token missing" });
  }

  try {
    const decoded = verifyToken(token);
    req.userId = decoded.userId;
    req.token = token;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};
