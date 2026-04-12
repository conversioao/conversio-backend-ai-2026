/**
 * Utility to generate and manage seeds for image generation
 * to ensure variety and prevent identical outputs for the same prompts.
 */
export class SeedSystem {
    /**
     * Generates a random integer seed between 0 and 2^32 - 1
     */
    static generateSeed(): number {
        return Math.floor(Math.random() * 4294967295);
    }

    /**
     * Derives a seed from a string (e.g. product hash) if needed
     */
    static deriveSeed(input: string): number {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            const char = input.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash >>> 0; // Convert to unsigned 32-bit int
        }
        return hash;
    }
}
