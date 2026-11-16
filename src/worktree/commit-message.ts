/** Keep externally supplied titles on one commit subject line. */
export function commitSubject(subject: string): string {
  return subject.trim().replace(/\s*\r?\n\s*/g, " ");
}
