/**
 * Every planted file carries a marker in its name. Nearly every tool prints the path of the file it
 * rejects, so a failing gate whose output contains the marker failed because of the planted fault
 * and not for some unrelated reason.
 */
export interface Marker {
  /** Six lowercase hex digits. */
  id: string;
  /** `falsegreen_<id>`: file names, identifiers, messages. */
  snake: string;
  /** `Falsegreen<id>`: Java and Kotlin class names, which must match the file name. */
  pascal: string;
}

export function newMarker(random: () => number = Math.random): Marker {
  const id = Array.from({ length: 6 }, () => Math.floor(random() * 16).toString(16)).join('');
  return { id, snake: `falsegreen_${id}`, pascal: `Falsegreen${id}` };
}

export function outputMentions(output: string, marker: Marker): boolean {
  return new RegExp(`falsegreen_?${marker.id}`, 'i').test(output);
}
