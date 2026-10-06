/// <reference types="vite/client" />

/** Hackathon builds: image URL path -> content fingerprint. Null in web builds. */
declare const __HL_ASSET_VERSIONS__: Record<string, string> | null;
