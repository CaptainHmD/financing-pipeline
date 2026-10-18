/** Masks an identifier for display/logging: 1234567890 -> 1*******90 */
export function maskIdentifier(value: string): string {
  if (value.length <= 3) return '*'.repeat(value.length);
  return `${value[0]}${'*'.repeat(value.length - 3)}${value.slice(-2)}`;
}
