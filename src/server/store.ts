import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCreatureProfile, normalizeCreatureProfile } from "../core/profile";
import type { CreatureProfile } from "../core/types";

export interface ProfileStore {
  listProfiles(): Promise<Array<{ userId: string; creatureName: string; createdAt: string }>>;
  getProfile(userId: string): Promise<CreatureProfile | undefined>;
  saveProfile(profile: CreatureProfile): Promise<void>;
  createProfile(input: { userId?: string; creatureName?: string }): Promise<CreatureProfile>;
}

interface StoreFile {
  profiles: Record<string, CreatureProfile>;
}

export class JsonProfileStore implements ProfileStore {
  constructor(private readonly filePath = path.join(process.cwd(), "data", "papo-store.json")) {}

  async listProfiles() {
    const data = await this.read();
    return Object.values(data.profiles).map((profile) => normalizeCreatureProfile(profile)).map((profile) => ({
      userId: profile.userId,
      creatureName: profile.creatureName,
      createdAt: profile.createdAt
    }));
  }

  async getProfile(userId: string) {
    const data = await this.read();
    const profile = data.profiles[userId];
    return profile ? normalizeCreatureProfile(profile) : undefined;
  }

  async saveProfile(profile: CreatureProfile) {
    const data = await this.read();
    data.profiles[profile.userId] = normalizeCreatureProfile(profile);
    await this.write(data);
  }

  async createProfile(input: { userId?: string; creatureName?: string }) {
    const data = await this.read();
    const profile = createCreatureProfile(input);
    data.profiles[profile.userId] = profile;
    await this.write(data);
    return profile;
  }

  private async read(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as StoreFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { profiles: {} };
    }
  }

  private async write(data: StoreFile) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

export class MemoryProfileStore implements ProfileStore {
  private profiles = new Map<string, CreatureProfile>();

  async listProfiles() {
    return [...this.profiles.values()].map((profile) => ({
      userId: profile.userId,
      creatureName: profile.creatureName,
      createdAt: profile.createdAt
    }));
  }

  async getProfile(userId: string) {
    const profile = this.profiles.get(userId);
    return profile ? normalizeCreatureProfile(profile) : undefined;
  }

  async saveProfile(profile: CreatureProfile) {
    this.profiles.set(profile.userId, normalizeCreatureProfile(profile));
  }

  async createProfile(input: { userId?: string; creatureName?: string }) {
    const profile = createCreatureProfile(input);
    this.profiles.set(profile.userId, profile);
    return profile;
  }
}
