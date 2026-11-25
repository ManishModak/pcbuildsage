export function formatErrorMessageFallback(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Couldn't load models.";
}
