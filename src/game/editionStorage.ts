// New namespace on the same Staging2 origin: never import its former shared-game save/session.
export const isolatedHackathon = ['staging2', 'seeker'].includes(import.meta.env?.MODE ?? '');
export const editionStorageKey = (key: string): string => isolatedHackathon ? `heroloop-seeker:v1:${key}` : key;
