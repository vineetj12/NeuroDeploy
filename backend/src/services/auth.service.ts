import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../envdata/data.ts";

/**
 * Generates a signed JWT for the given userId (expires in 7 days).
 */
export function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });
}

/**
 * Verifies a JWT and returns the decoded payload.
 * Throws if the token is invalid or expired.
 */
export function verifyToken(token: string): { userId: string } {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: string };
  } catch (error) {
    console.error("[auth.service] Error verifying token:", error);
    throw new Error("Invalid token");
  }
}
