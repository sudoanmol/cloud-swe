export function quote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}
