const UPLOAD_URL = "https://storage.googleapis.com/upload/storage/v1/b";
const OBJECT_URL = "https://storage.googleapis.com/storage/v1/b";

const EXTENSIONS: Record<string, string> = {
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/ogg": "ogg",
	"audio/flac": "flac",
	"audio/aac": "aac",
	"video/mp4": "mp4",
	"video/quicktime": "mov",
	"video/webm": "webm",
	"application/pdf": "pdf",
};

export function extensionFor(mimeType: string): string {
	return EXTENSIONS[mimeType] ?? mimeType.split("/")[1]?.replace(/[^a-z0-9]/g, "") ?? "bin";
}

/** Uploads bytes to the bucket and returns the object's gs:// URI plus a cleanup function. */
export async function uploadObject(
	bucket: string,
	accessToken: string,
	bytes: Uint8Array,
	mimeType: string,
): Promise<{ uri: string; remove: () => Promise<void> }> {
	const name = `uploads/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extensionFor(mimeType)}`;
	const headers = { authorization: `Bearer ${accessToken}` };
	const response = await fetch(
		`${UPLOAD_URL}/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`,
		{ method: "POST", headers: { ...headers, "content-type": mimeType }, body: bytes },
	);
	if (!response.ok) {
		throw new Error(`Cloud Storage upload failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
	}
	return {
		uri: `gs://${bucket}/${name}`,
		// Best effort: a failed delete just leaves the object for a bucket lifecycle rule.
		remove: async () => {
			try {
				await fetch(`${OBJECT_URL}/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`, {
					method: "DELETE",
					headers,
				});
			} catch {
				// ignored
			}
		},
	};
}
