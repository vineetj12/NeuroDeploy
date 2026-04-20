import 'dotenv/config';
export const port = process.env.PORT || 4000;
export const VERCEL_TOKEN=process.env.VERCEL_TOKEN||"";
export const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";