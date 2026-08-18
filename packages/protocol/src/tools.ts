/**
 * MCP tool surface — SDD v0.5 §15 and Appendix A. The JSON Schemas in
 * Appendix A are normative; these Zod v4 shapes are mechanically equivalent
 * and are exposed through the MCP SDK. Tool names and required fields are
 * stable within major API version 1.
 *
 * Conditional constraints that JSON Schema expresses as allOf/if-then or
 * oneOf (screenshot element mode, wait condition) are enforced with
 * refinements: the validated value set is identical.
 */
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Appendix A.1 common $defs
// ---------------------------------------------------------------------------

export const TabSchema = z.strictObject({
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  pageRevision: z.int(),
});
export type Tab = z.infer<typeof TabSchema>;

export const SemanticNodeSchema = z.strictObject({
  elementRef: z.union([z.string(), z.null()]),
  role: z.string(),
  name: z.string(),
  text: z.string(),
  disabled: z.boolean(),
  checked: z.union([z.boolean(), z.null()]),
  valueRedacted: z.boolean(),
});
export type SemanticNode = z.infer<typeof SemanticNodeSchema>;

export const ImageCandidateSchema = z.strictObject({
  imageId: z.string(),
  order: z.int(),
  thumbnailUrl: z.union([z.string(), z.null()]),
  sourceUrl: z.union([z.string(), z.null()]),
  width: z.union([z.int(), z.null()]),
  height: z.union([z.int(), z.null()]),
  mimeType: z.union([z.string(), z.null()]),
});
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;

export const ArtifactDescriptorSchema = z.strictObject({
  artifactId: z.string(),
  mimeType: z.string(),
  byteLength: z.int(),
  delivery: z.enum(['mcp_inline', 'signed_url']),
  expiresAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
});
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;

// ---------------------------------------------------------------------------
// Tool input/output schemas (Appendix A)
// ---------------------------------------------------------------------------

export const SessionOpenInput = z.strictObject({
  deviceId: z.string(),
  profileName: z.string().default('ebay-research'),
});
export const SessionOpenOutput = z.strictObject({
  browserSessionHandle: z.string(),
  deviceId: z.string(),
  profileName: z.string(),
  status: z.enum(['ready', 'degraded']),
  tabs: z.array(TabSchema),
});

export const TabsInput = z.strictObject({
  browserSessionHandle: z.string(),
});
export const TabsOutput = z.strictObject({
  tabs: z.array(TabSchema),
});

export const NavigateInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  url: z.url(),
  waitUntil: z.enum(['domcontentloaded', 'load']).default('domcontentloaded'),
});
export const NavigateOutput = z.strictObject({
  finalUrl: z.string(),
  title: z.string(),
  origin: z.string(),
  pageRevision: z.int().min(0),
  navigationStatus: z.enum(['committed', 'same_document', 'blocked']),
});

export const SnapshotInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  maxNodes: z.int().min(100).max(10000).default(3000),
});
export const SnapshotOutput = z.strictObject({
  url: z.string(),
  title: z.string(),
  pageRevision: z.int(),
  snapshot: z.array(SemanticNodeSchema),
  truncated: z.boolean(),
});

export const ScreenshotInput = z
  .strictObject({
    browserSessionHandle: z.string(),
    tabId: z.string(),
    mode: z.enum(['viewport', 'full_page', 'element']),
    elementRef: z.string().optional(),
    format: z.enum(['png', 'jpeg']).default('png'),
  })
  .check((ctx) => {
    if (ctx.value.mode === 'element' && ctx.value.elementRef === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'elementRef is required when mode is "element"',
        input: ctx.value,
        path: ['elementRef'],
      });
    }
  });
export const ScreenshotOutput = z.strictObject({
  artifact: ArtifactDescriptorSchema,
  pageRevision: z.int(),
  width: z.int(),
  height: z.int(),
});

export const ImagesInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  scope: z.enum(['page', 'gallery']).default('gallery'),
});
export const ImagesOutput = z.strictObject({
  pageRevision: z.int(),
  images: z.array(ImageCandidateSchema),
});

export const ImageGetInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  imageId: z.string(),
});
export const ImageGetOutput = z.strictObject({
  artifact: ArtifactDescriptorSchema,
  sourceUrl: z.string(),
  pageRevision: z.int(),
});

export const ClickInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  elementRef: z.string(),
  button: z.enum(['left']).default('left'),
});
export const ClickOutput = z.strictObject({
  pageRevision: z.int(),
  url: z.string(),
  changed: z.boolean(),
});

export const FillInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  elementRef: z.string(),
  value: z.string().max(4096),
});
export const FillOutput = z.strictObject({
  pageRevision: z.int(),
  filled: z.boolean(),
});

export const SelectInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  elementRef: z.string(),
  value: z.string(),
});
export const SelectOutput = z.strictObject({
  pageRevision: z.int(),
  selectedValue: z.string(),
});

export const ScrollInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  elementRef: z.string().optional(),
  deltaX: z.int().min(-5000).max(5000).default(0),
  deltaY: z.int().min(-5000).max(5000),
});
export const ScrollOutput = z.strictObject({
  pageRevision: z.int(),
  scrollX: z.number(),
  scrollY: z.number(),
});

export const ALLOWED_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;

export const KeyInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  key: z.enum(ALLOWED_KEYS),
});
export const KeyOutput = z.strictObject({
  pageRevision: z.int(),
  sent: z.boolean(),
});

const WaitConditionBase = z.object({
  text: z.string().optional(),
  urlPattern: z.string().optional(),
  elementRef: z.string().optional(),
  networkIdleMs: z.int().min(100).max(5000).optional(),
});

export const WaitInput = z
  .strictObject({
    browserSessionHandle: z.string(),
    tabId: z.string(),
    condition: WaitConditionBase,
    timeoutMs: z.int().min(100).max(30000).default(10000),
  })
  .check((ctx) => {
    const cond = ctx.value.condition;
    const present = (['text', 'urlPattern', 'elementRef', 'networkIdleMs'] as const).filter(
      (key) => cond[key] !== undefined,
    );
    if (present.length !== 1) {
      ctx.issues.push({
        code: 'custom',
        message: 'condition must specify exactly one of text, urlPattern, elementRef, networkIdleMs',
        input: ctx.value,
        path: ['condition'],
      });
    }
  });
export const WaitOutput = z.strictObject({
  satisfied: z.boolean(),
  pageRevision: z.int(),
  elapsedMs: z.int(),
});

export const ExtractInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  /**
   * Versioned site profiles the bridge ships extractors for. The agent
   * dispatches by the live page's host and page kind; this field declares
   * caller intent and a mismatch downgrades to a warning, never a refusal.
   */
  siteProfile: z.enum(['ebay.ca.v1', 'kijiji.ca.v1']),
});
export const ExtractOutput = z.strictObject({
  siteProfile: z.string(),
  pageRevision: z.int(),
  record: z.looseObject({}),
  warnings: z.array(z.string()),
});

export const HandoffInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  message: z.string().max(500),
  timeoutSeconds: z.int().min(30).max(1800).default(300),
});
export const HandoffOutput = z.strictObject({
  resumed: z.boolean(),
  pageRevision: z.int(),
  url: z.string(),
});

export type WaitCondition = z.infer<typeof WaitConditionBase>;
