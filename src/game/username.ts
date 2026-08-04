const BLOCKED_USERNAME_PARTS = [
  'fuck', 'shit', 'cunt', 'dick', 'pussy', 'bitch', 'asshole', 'whore', 'slut',
  'nigg', 'fagg', 'retard',
  'huy', 'hui', 'khuy', 'pizd', 'blya', 'blia', 'suka', 'syka', 'mudak',
  'dolboeb', 'dolboyob', 'eblan', 'eban', 'yeban', 'zalupa', 'zhopa',
] as const;

export function normalizeUsernameForModeration(value: string): string {
  return value.toLowerCase().replace(/[013457@$]/g, (char) => ({
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's',
  })[char] ?? char).replace(/[^a-z]/g, '');
}

export function hasBlockedUsernameLanguage(value: string): boolean {
  const normalized = normalizeUsernameForModeration(value);
  return BLOCKED_USERNAME_PARTS.some((part) => normalized.includes(part));
}
