import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const TEMPLATE_SCHEMA_VERSION = 1 as const;
export const PROJECT_REGISTRY_SCHEMA_VERSION = 1 as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const ProjectIdSchema = z.string().regex(SAFE_ID, "Invalid project id.");
export const ProjectKindSchema = z.enum(["web-test", "browser-automation"]);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

const TimestampSchema = z.number().int().nonnegative().finite();

export const FlowProjectSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id: ProjectIdSchema,
    name: z.string().trim().min(1).max(120),
    kind: ProjectKindSchema,
    rootPath: z
      .string()
      .min(1)
      .max(32_767)
      .refine((value) => !value.includes("\0"), {
        message: "Project root contains a null byte.",
      }),
    templateId: z.string().regex(SAFE_ID, "Invalid template id."),
    templateVersion: z.string().regex(SEMVER, "Invalid template version."),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    defaultTargetId: z
      .string()
      .regex(SAFE_ID, "Invalid default target id.")
      .optional(),
  })
  .strict()
  .superRefine((project, context) => {
    if (project.updatedAt < project.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt cannot be earlier than createdAt.",
      });
    }
  });
export type FlowProject = z.infer<typeof FlowProjectSchema>;

function isSafeTemplatePath(value: string): boolean {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes(":"),
  );
}

export const TemplateFileSchema = z
  .object({
    path: z.string().max(512).refine(isSafeTemplatePath, {
      message: "Template file path must be a safe relative POSIX path.",
    }),
    sha256: z.string().regex(SHA256, "Template file hash must be SHA-256."),
    required: z.boolean(),
  })
  .strict();
export type TemplateFile = z.infer<typeof TemplateFileSchema>;

export const TemplateManifestSchema = z
  .object({
    schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
    id: z.string().regex(SAFE_ID, "Invalid template id."),
    version: z.string().regex(SEMVER, "Invalid template version."),
    kind: ProjectKindSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    files: z.array(TemplateFileSchema).min(1),
    integrity: z
      .object({
        algorithm: z.literal("sha256"),
        value: z.string().regex(SHA256, "Template integrity must be SHA-256."),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = new Set<string>();
    for (const [index, file] of manifest.files.entries()) {
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: `Duplicate template file path "${file.path}".`,
        });
      }
      paths.add(file.path);
    }
  });
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

export const ProjectRegistrySchema = z
  .object({
    schemaVersion: z.literal(PROJECT_REGISTRY_SCHEMA_VERSION),
    projects: z.array(FlowProjectSchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    for (const [index, project] of registry.projects.entries()) {
      if (ids.has(project.id)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "id"],
          message: `Duplicate project id "${project.id}".`,
        });
      }
      ids.add(project.id);
    }
  });
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

export const ProjectAvailabilitySchema = z.enum([
  "available",
  "missing",
  "unsafe",
]);
export type ProjectAvailability = z.infer<typeof ProjectAvailabilitySchema>;

export const ProjectListItemSchema = z
  .object({
    project: FlowProjectSchema,
    availability: ProjectAvailabilitySchema,
    message: z.string().optional(),
  })
  .strict();
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

export const FLOWCODE_PROJECT_DIRECTORY = ".flowcode";
export const FLOWCODE_PROJECT_FILE = "project.json";
