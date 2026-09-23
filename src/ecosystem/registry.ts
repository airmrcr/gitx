import { nodeEcosystem } from './node.ts';
import type { DetectedProject, Ecosystem } from './types.ts';

/**
 * Registered ecosystems, tried in order. Adding Go or Rust support is a matter of implementing
 * {@link Ecosystem} and appending it here.
 */
export const ecosystems: readonly Ecosystem[] = Object.freeze([nodeEcosystem]);

/**
 * Returns the first ecosystem that recognises the directory, if any.
 *
 * @param dir Directory to inspect.
 * @returns The detected project, or `undefined` if no ecosystem recognises `dir`.
 */
export const detectProject = async (dir: string): Promise<DetectedProject | undefined> => {
  for (const ecosystem of ecosystems) {
    const detected = await ecosystem.detect(dir);
    if (detected) return detected;
  }
  return undefined;
};
