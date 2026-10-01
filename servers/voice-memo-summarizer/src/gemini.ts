import { GoogleGenAI, type Part } from "@google/genai";
import { uploadObject } from "./gcs.js";
import type { InputPart } from "./input.js";
import { SYSTEM_INSTRUCTION } from "./prompt.js";
import type { Env } from "./env.js";

export class GeminiError extends Error {}

function vertexBaseUrl(location: string): string {
	return location === "global"
		? "https://aiplatform.googleapis.com/"
		: `https://${location}-aiplatform.googleapis.com/`;
}

// js-genai's web build (the one that runs on Workers) only supports API-key
// auth for Vertex. Instead it gets a placeholder key plus this fetch, which
// swaps that key for the workload-identity access token on every request.
function bearerFetch(accessToken: string): typeof fetch {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.delete("x-goog-api-key");
		headers.set("authorization", `Bearer ${accessToken}`);
		return fetch(input, { ...init, headers });
	};
}

export async function summarize(env: Env, accessToken: string, input: InputPart[]): Promise<string> {
	const ai = new GoogleGenAI({
		vertexai: true,
		apiKey: "unused-replaced-by-bearer-token",
		httpOptions: {
			baseUrl: vertexBaseUrl(env.VERTEX_LOCATION),
			apiVersion: "v1",
			fetch: bearerFetch(accessToken) as never,
		},
	});

	const uploads: Awaited<ReturnType<typeof uploadObject>>[] = [];
	try {
		const parts: Part[] = [];
		for (const item of input) {
			if (item.kind === "text") {
				parts.push({ text: item.text });
				continue;
			}
			// Media goes through the bucket: Vertex reads it by gs:// URI, so file
			// size isn't capped by the request body limit.
			const upload = await uploadObject(env.GCS_BUCKET, accessToken, item.bytes, item.mimeType);
			uploads.push(upload);
			parts.push({ text: `Input "${item.label}" (${item.mimeType}):` });
			parts.push({ fileData: { fileUri: upload.uri, mimeType: item.mimeType } });
		}

		const response = await ai.models.generateContent({
			model: `projects/${env.GCP_PROJECT_ID}/locations/${env.VERTEX_LOCATION}/publishers/google/models/${env.GEMINI_MODEL}`,
			contents: [{ role: "user", parts }],
			config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.2 },
		});
		const text = response.text?.trim();
		if (!text) {
			const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason;
			throw new GeminiError(`Gemini returned no text${reason ? ` (${reason})` : ""}.`);
		}
		return text;
	} finally {
		await Promise.all(uploads.map((upload) => upload.remove()));
	}
}
