/** Search a name, accents and case aside: « Élodie » matches « elodie ». */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
