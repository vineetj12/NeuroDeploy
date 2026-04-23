import 'dotenv/config';
export const port = process.env.PORT || 4000;
export const JWT_SECRET = process.env.JWT_SECRET || "123123";
export const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";