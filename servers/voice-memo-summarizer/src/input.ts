// Turns whatever the caller POSTed into a list of parts for Gemini: text, or
// binary media (audio, video, images, PDFs). Handles raw bodies (Apple
// Shortcuts "Get contents of URL" with a File request body), JSON, plain text
// and multipart/form-data.

export type InputPart =
	| { kind: "text"; text: string }
	| { kind: "media"; bytes: Uint8Array; mimeType: string; label: string };

export class InputError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export const MAX_BODY_BYTES = 100 * 1024 * 1024;

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|x-ndjson|csv|javascript|x-www-form-urlencoded)|.+\+(json|xml))/;
const MEDIA_TYPES = /^(audio\/|video\/|image\/|application\/pdf$)/;

function startsWith(bytes: Uint8Array, signature: (number | null)[], offset = 0): boolean {
	return signature.every((b, i) => b === null || bytes[offset + i] === b);
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
	String.fromCharCode(...bytes.subarray(start, end));

/** Identify a file from its magic bytes; used when the caller sends no useful Content-Type. */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
	if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	if (ascii(bytes, 0, 4) === "RIFF") {
		const form = ascii(bytes, 8, 12);
		if (form === "WAVE") return "audio/wav";
		if (form === "WEBP") return "image/webp";
	}
	if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
	if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
	if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
	if (startsWith(bytes, [0xff, 0xf1]) || startsWith(bytes, [0xff, 0xf9])) return "audio/aac";
	if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
	if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
	if (ascii(bytes, 4, 8) === "ftyp") {
		const brand = ascii(bytes, 8, 12);
		if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
		if (brand === "qt  ") return "video/quicktime";
		if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "image/heic";
		return "video/mp4";
	}
	return undefined;
}

/** Normalise aliases Gemini doesn't accept (e.g. Apple's `audio/x-m4a`). */
export function normalizeMimeType(contentType: string | null | undefined): string | undefined {
	const base = contentType?.split(";")[0]?.trim().toLowerCase();
	if (!base) return undefined;
	const aliases: Record<string, string> = {
		"audio/x-m4a": "audio/mp4",
		"audio/m4a": "audio/mp4",
		"audio/x-aac": "audio/aac",
		"audio/x-wav": "audio/wav",
		"audio/wave": "audio/wav",
		"audio/x-flac": "audio/flac",
		"audio/mp3": "audio/mpeg",
		"image/jpg": "image/jpeg",
	};
	return aliases[base] ?? base;
}

function looksLikeText(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 4096);
	if (sample.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sample);
		return true;
	} catch {
		// A multi-byte character cut at the sample boundary is still text.
		return new TextDecoder("utf-8").decode(sample).split("�").length <= 2;
	}
}

/** Classify bytes + declared type as text or media; throws 415 for unusable types. */
function toPart(bytes: Uint8Array, declared: string | undefined, label: string): InputPart | null {
	if (bytes.byteLength === 0) return null;
	if (declared && TEXT_TYPES.test(declared)) {
		return { kind: "text", text: new TextDecoder().decode(bytes) };
	}
	let mimeType = declared && MEDIA_TYPES.test(declared) ? declared : undefined;
	// A declared audio/video type is trusted; octet-stream and friends are sniffed.
	mimeType ??= sniffMimeType(bytes);
	if (mimeType && MEDIA_TYPES.test(mimeType)) return { kind: "media", bytes, mimeType, label };
	if (!declared || declared === "application/octet-stream" || declared === "binary/octet-stream") {
		if (looksLikeText(bytes)) return { kind: "text", text: new TextDecoder().decode(bytes) };
	}
	throw new InputError(
		415,
		`Unsupported input type${declared ? ` "${declared}"` : ""}. Send audio, video, images, PDFs, or text/JSON.`,
	);
}

async function readBody(request: Request): Promise<Uint8Array> {
	const length = Number(request.headers.get("content-length") ?? 0);
	if (length > MAX_BODY_BYTES) throw new InputError(413, `Body exceeds ${MAX_BODY_BYTES} bytes.`);
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > MAX_BODY_BYTES) throw new InputError(413, `Body exceeds ${MAX_BODY_BYTES} bytes.`);
	return bytes;
}

export async function readInput(request: Request): Promise<InputPart[]> {
	const contentType = request.headers.get("content-type");
	const declared = normalizeMimeType(contentType);
	const parts: InputPart[] = [];

	if (declared === "multipart/form-data") {
		const length = Number(request.headers.get("content-length") ?? 0);
		if (length > MAX_BODY_BYTES) throw new InputError(413, `Body exceeds ${MAX_BODY_BYTES} bytes.`);
		let form: FormData;
		try {
			form = await request.formData();
		} catch {
			throw new InputError(400, "Malformed multipart/form-data body.");
		}
		for (const [name, value] of form.entries()) {
			if (typeof value === "string") {
				if (value.trim()) parts.push({ kind: "text", text: `Form field "${name}":\n${value}` });
				continue;
			}
			const filename = value.name || name;
			const part = toPart(new Uint8Array(await value.arrayBuffer()), normalizeMimeType(value.type), filename);
			if (!part) continue;
			parts.push(
				part.kind === "text" ? { kind: "text", text: `File "${filename}":\n${part.text}` } : part,
			);
		}
	} else {
		const label = new URL(request.url).searchParams.get("filename") ?? "upload";
		const part = toPart(await readBody(request), declared, label);
		if (part) parts.push(part);
	}

	if (parts.length === 0) throw new InputError(400, "Empty request: send a body to summarize.");
	return parts;
}
