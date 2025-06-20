// biome-ignore lint/complexity/noBannedTypes: Generic JSON Object utility function
export function toURLSafeBase64(jsonObject: Object): string {
    const text = JSON.stringify(jsonObject);
    const textBytes = new TextEncoder().encode(text);
    return bytesToBase64(textBytes);
}

// biome-ignore lint/complexity/noBannedTypes: Generic JSON Object utility function
export function fromURLSafeBase64(urlSafeBase64: string): Object {
    const textBytes = base64ToBytes(urlSafeBase64);
    const jsonString = new TextDecoder().decode(textBytes);
    return JSON.parse(jsonString);
}

function base64ToBytes(urlsafeBase64: string): Uint8Array {
    const base64 = urlsafeBase64
        .replace(/\-/g, "+") // Convert '-' to '+'
        .replace(/_/g, "/"); // Convert '_' to '/'
    const binString = atob(base64);
    return Uint8Array.from(binString, (m, _) => m.codePointAt(0)!);
}

function bytesToBase64(bytes: Uint8Array) {
    const binString = String.fromCodePoint(...bytes);
    const b64 = btoa(binString);
    // return urlsafe base 64
    return b64
        .replace(/\+/g, "-") // Convert '+' to '-'
        .replace(/\//g, "_") // Convert '/' to '_'
        .replace(/=+$/, ""); // Remove ending '='
}
