import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../../envdata/data.ts';

export const GenerateToken = (userId: String) => {
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    return token;
}
export const VerifyToken = (token: string) => {
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
        return decoded;
    } catch (error) {
        console.error("Error verifying token:", error);
        throw new Error("Invalid token");
    }
}