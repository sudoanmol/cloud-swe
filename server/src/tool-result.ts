/** The text result every tool returns to Pi. */
export const text = (message: string, isError = false) => ({
  output: [{ type: 'text' as const, text: message }],
  isError,
});
