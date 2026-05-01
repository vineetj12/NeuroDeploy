import axios from "axios";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!API_KEY) {
  console.error("GEMINI_API_KEY is not set in the environment.");
  process.exit(2);
}

async function main() {
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      MODEL
    )}:generateContent`;

    const body = {
      contents: [{ parts: [{ text: "NeuroDeploy: authentication test - reply with a short confirmation." }] }],
      generationConfig: { temperature: 0 }
    };

    const resp = await axios.post(endpoint, body, {
      params: { key: API_KEY },
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    console.log("HTTP status:", resp.status);

    const candidate = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (candidate && typeof candidate === "string") {
      console.log("Response snippet:", candidate.slice(0, 400));
      console.log("GEMINI key appears to be valid.");
      process.exit(0);
    }

    console.error("No usable content in Gemini response. Full response:", JSON.stringify(resp.data));
    process.exit(1);
  } catch (err) {
    if (axios.isAxiosError && axios.isAxiosError(err)) {
      console.error("Request failed:", err.response?.status, err.response?.data ?? err.message);
    } else {
      console.error("Error:", err?.toString ? err.toString() : err);
    }
    process.exit(1);
  }
}

main();
