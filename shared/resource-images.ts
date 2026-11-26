export const resourceImageLimit = 3;
export const resourceImageMaxBytes = 8 * 1024 * 1024;
export const resourceImageIdPattern = /^[a-f0-9]{64}$/;
export const resourceImageMimeTypes = ["image/jpeg", "image/png", "image/webp"];

export type ResourceImageInput = { id: string } | { data: string };
