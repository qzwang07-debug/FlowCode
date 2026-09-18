import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  BrowserEnvironmentProfileSchema,
  BrowserSessionLeaseSchema,
  type BrowserEnvironmentProfile,
  type BrowserSessionLease,
} from "../../common/browser-environment";
import {
  ZiniaoPublicProfileSchema,
  type ZiniaoPublicProfile,
} from "../../common/ziniao-recording";
import { contractHash } from "../evidence/blueprint-contract";

const ProfilesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z.array(BrowserEnvironmentProfileSchema),
  })
  .strict();
const LeasesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    leases: z.array(BrowserSessionLeaseSchema),
  })
  .strict();

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function publicProfile(profile: BrowserEnvironmentProfile): ZiniaoPublicProfile {
  if (profile.provider !== "ziniao")
    throw new Error("Expected a Ziniao environment profile.");
  const statuses = profile.capabilities.results.map((result) => result.status);
  const capabilityState = statuses.includes("unsupported")
    ? "degraded"
    : statuses.includes("unknown")
      ? "degraded"
      : "supported";
  return ZiniaoPublicProfileSchema.parse({
    id: profile.id,
    revision: profile.revision,
    provider: "ziniao",
    storeId: profile.binding.storeId,
    storeName: profile.binding.expectedName,
    siteScopes: profile.siteScopes,
    capabilityState,
    updatedAt: profile.capabilities.checkedAt,
  });
}

export class ZiniaoProfileStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(path.resolve(root), "browser-profiles", "profiles.json");
  }

  async list(): Promise<BrowserEnvironmentProfile[]> {
    const raw = await readJson(this.file);
    if (raw === null) return [];
    return ProfilesFileSchema.parse(raw).profiles;
  }

  async listPublic(): Promise<ZiniaoPublicProfile[]> {
    return (await this.list())
      .filter((profile) => profile.provider === "ziniao")
      .map(publicProfile)
      .sort((left, right) => left.storeName.localeCompare(right.storeName));
  }

  async get(id: string): Promise<BrowserEnvironmentProfile> {
    const profile = (await this.list()).find((item) => item.id === id);
    if (!profile || profile.provider !== "ziniao")
      throw new Error("The selected Ziniao environment no longer exists.");
    return profile;
  }

  save(profile: BrowserEnvironmentProfile): Promise<ZiniaoPublicProfile> {
    const value = BrowserEnvironmentProfileSchema.parse(profile);
    if (value.provider !== "ziniao")
      return Promise.reject(new Error("Only Ziniao profiles belong in this store."));
    return this.enqueue(async () => {
      const profiles = await this.list();
      const duplicate = profiles.find(
        (item) =>
          item.provider === "ziniao" &&
          item.id !== value.id &&
          item.binding.accountRef === value.binding.accountRef &&
          item.binding.storeId === value.binding.storeId,
      );
      if (duplicate)
        throw new Error("That exact Ziniao store is already bound to an environment.");
      const index = profiles.findIndex((item) => item.id === value.id);
      if (index >= 0) profiles[index] = value;
      else profiles.push(value);
      await writeJsonAtomic(
        this.file,
        ProfilesFileSchema.parse({ schemaVersion: 1, profiles }),
      );
      return publicProfile(value);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class ZiniaoLeaseStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;
  private initialized = false;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(path.resolve(root), "browser-leases", "leases.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const leases = await this.read();
    let changed = false;
    const expired = leases.map((lease) => {
      if (["preparing", "active", "paused"].includes(lease.state)) {
        changed = true;
        return BrowserSessionLeaseSchema.parse({
          ...lease,
          state: "expired",
          releasedAt: undefined,
          expiresAt: Math.max(lease.expiresAt, this.now(), lease.issuedAt + 1),
        });
      }
      return lease;
    });
    if (changed) await this.write(expired);
  }

  acquire(input: {
    profile: BrowserEnvironmentProfile;
    sessionId: string;
    pageId: string;
    allowAssociatedPopups: boolean;
    launchOwnership: "borrowed" | "flowcode";
  }): Promise<BrowserSessionLease> {
    return this.enqueue(async () => {
      await this.initialize();
      const profile = input.profile;
      if (profile.provider !== "ziniao")
        throw new Error("A Ziniao lease requires a Ziniao environment.");
      const leases = await this.read();
      const now = this.now();
      const conflict = leases.find(
        (lease) =>
          lease.provider === "ziniao" &&
          lease.binding?.accountRef === profile.binding.accountRef &&
          lease.binding?.storeId === profile.binding.storeId &&
          ["preparing", "active", "paused"].includes(lease.state) &&
          lease.expiresAt > now,
      );
      if (conflict)
        throw new Error("That Ziniao store already has an active FlowCode lease.");
      const lease = BrowserSessionLeaseSchema.parse({
        schemaVersion: 1,
        id: `lease-${randomUUID()}`,
        environmentProfileId: profile.id,
        environmentHash: contractHash(profile),
        provider: "ziniao",
        binding: profile.binding,
        owner: { kind: "recording", sessionId: input.sessionId },
        pages: [
          {
            id: input.pageId,
            ownership: "borrowed",
            allowAssociatedPopups: input.allowAssociatedPopups,
          },
        ],
        launchOwnership: input.launchOwnership,
        issuedAt: now,
        expiresAt: now + 4 * 60 * 60 * 1000,
        state: "active",
      });
      leases.push(lease);
      await this.write(leases);
      return lease;
    });
  }

  release(id: string): Promise<BrowserSessionLease> {
    return this.enqueue(async () => {
      const leases = await this.read();
      const index = leases.findIndex((lease) => lease.id === id);
      if (index < 0) throw new Error("Browser lease no longer exists.");
      const lease = leases[index];
      if (lease.state === "released") return lease;
      const released = BrowserSessionLeaseSchema.parse({
        ...lease,
        state: "released",
        releasedAt: this.now(),
      });
      leases[index] = released;
      await this.write(leases);
      return released;
    });
  }

  private async read(): Promise<BrowserSessionLease[]> {
    const raw = await readJson(this.file);
    if (raw === null) return [];
    return LeasesFileSchema.parse(raw).leases;
  }

  private write(leases: BrowserSessionLease[]): Promise<void> {
    return writeJsonAtomic(
      this.file,
      LeasesFileSchema.parse({ schemaVersion: 1, leases }),
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
